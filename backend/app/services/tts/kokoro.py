"""Kokoro: a real neural voice, synthesized on this server.

The gap this closes: browser voices vary wildly per visitor's OS, and the
good server voices all cost per character and send the text to a third
party. Kokoro-82M (Apache-2.0) runs on the CPU this API already has, so
every deployment gets one consistent, natural voice with no key, no bill,
and no text leaving the instance.

Model weights are not Python dependencies — the Dockerfile downloads them
next to the MediaPipe models, and the provider simply reports itself
unconfigured when the files are absent (local dev without the ~350MB
download keeps working, minus this provider).

Synthesis is CPU-bound and blocking, so it runs in a worker thread; a
process-wide semaphore caps concurrent syntheses at 1. That is deliberate
throttling, not an oversight: on a 4-core box, two parallel syntheses slow
each other AND starve the API workers, whereas queueing keeps latency
predictable and the speech cache means each phrase is ever synthesized once.

Timing: when the timestamped export (kokoro-timed.onnx, the lip-sync lab's
model) is installed, speech is made with it and its cues are the model's own
phoneme spans (lab_timing.native_cues): each sound starts when the model
says it does, and pauses stay where they are. The fallback, and the only
path without that model, is the one every other provider uses: a duration
table stretched to the measured audio length (cues_from_text), which drifts
inside a sentence wherever the voice's pacing differs from the table's.

The two models do not make the same audio. kokoro-onnx tops up the pause
after every comma and full stop when the model reports timings, and only at
batch joins when it does not, so the timed model's clause pauses are longer
by construction (and the files are two separate exports). Cues are
therefore always computed from the audio they are served with, never
borrowed from the other model. The original model is loaded only when the
timed path fails, so a normal server holds one Kokoro session (~1 GB
resident), not two.

Speech cache: rows made on one path are keyed apart from the other's
(`cache_version`), so turning native timing on never serves an old recording
with stretched cues; a recording made by the fallback is not cached at all
(the next request tries the timed model again).
"""
from __future__ import annotations

import asyncio
import io
import logging
import threading

from app.core.config import get_settings
from app.services.tts.base import SynthesisResult, TTSProvider, Voice
from app.services.tts.visemes import cues_from_text

logger = logging.getLogger("liveface.tts.kokoro")

# Bumped whenever what a native-timed recording's cues mean changes: the
# speech cache keys Kokoro rows by it (registry.cache_key).
NATIVE_CACHE_VERSION = "native-1"

# A curated slice of Kokoro's 54 voices: one or two per language, not fifty
# near-identical English ones. Japanese and Mandarin are deliberately absent
# — those voices were trained with a dedicated Japanese/Chinese text
# processor (misaki), and this image phonemizes with espeak, which produces
# audio but mispronounces enough to be worse than offering nothing.
VOICES = [
    Voice(id="af_heart", name="Heart · warm female", locale="en-US", gender="female"),
    Voice(id="af_bella", name="Bella · bright female", locale="en-US", gender="female"),
    Voice(id="am_michael", name="Michael · calm male", locale="en-US", gender="male"),
    Voice(id="am_fenrir", name="Fenrir · deep male", locale="en-US", gender="male"),
    Voice(id="bf_emma", name="Emma · British female", locale="en-GB", gender="female"),
    Voice(id="bm_george", name="George · British male", locale="en-GB", gender="male"),
    Voice(id="ef_dora", name="Dora · Spanish female", locale="es-ES", gender="female"),
    Voice(id="em_alex", name="Alex · Spanish male", locale="es-ES", gender="male"),
    Voice(id="ff_siwis", name="Siwis · French female", locale="fr-FR", gender="female"),
    Voice(id="if_sara", name="Sara · Italian female", locale="it-IT", gender="female"),
    Voice(id="im_nicola", name="Nicola · Italian male", locale="it-IT", gender="male"),
    Voice(id="pf_dora", name="Dora · Portuguese female", locale="pt-BR", gender="female"),
    Voice(id="pm_alex", name="Alex · Portuguese male", locale="pt-BR", gender="male"),
    Voice(id="hf_alpha", name="Alpha · Hindi female", locale="hi-IN", gender="female"),
    Voice(id="hm_omega", name="Omega · Hindi male", locale="hi-IN", gender="male"),
]
_VOICE_IDS = {v.id for v in VOICES}
# Kokoro's voice-id prefixes ARE its language codes.
_LANG_BY_PREFIX = {
    "a": "en-us", "b": "en-gb", "e": "es", "f": "fr-fr",
    "i": "it", "p": "pt-br", "h": "hi",
}
DEFAULT_VOICE = "af_heart"

_engine = None
_engine_lock = threading.Lock()
_synth_semaphore: asyncio.Semaphore | None = None


def _get_engine():
    """The ONNX session, built once. ~1GB resident, so exactly one exists."""
    global _engine
    with _engine_lock:
        if _engine is None:
            from kokoro_onnx import Kokoro

            settings = get_settings()
            _engine = Kokoro(settings.kokoro_model_path, settings.kokoro_voices_path)
        return _engine


class KokoroTTSProvider(TTSProvider):
    name = "kokoro"
    display_name = "Server voice (built-in)"

    def is_configured(self) -> bool:
        """Either model, with the voices: a server may ship only one."""
        return _original_configured() or native_timing_enabled()

    def cache_version(self) -> str:
        """Native-timed recordings are keyed apart from stretched ones."""
        return NATIVE_CACHE_VERSION if native_timing_enabled() else ""

    async def voices(self) -> list[Voice]:
        return VOICES

    async def synthesize(self, text: str, voice: str, locale: str) -> SynthesisResult:
        global _synth_semaphore
        if _synth_semaphore is None:
            _synth_semaphore = asyncio.Semaphore(1)

        voice_id = voice if voice in _VOICE_IDS else DEFAULT_VOICE
        # Kokoro keys the phonemizer off the voice's first letter, and getting
        # this wrong is an accent slipping mid-sentence — or, for Spanish
        # read as English, gibberish.
        lang = _LANG_BY_PREFIX.get(voice_id[0], "en-us")

        async with _synth_semaphore:
            fell_back = False
            if native_timing_enabled():
                native = await _synthesize_native(text, voice_id, lang, locale)
                if native is not None:
                    return native
                if not _original_configured():
                    raise RuntimeError(
                        "the timestamped Kokoro model failed and no other Kokoro model is installed"
                    )
                fell_back = True
            audio, duration_ms = await asyncio.to_thread(_render, text, voice_id, lang)
        return SynthesisResult(
            audio=audio,
            audio_mime="audio/wav",
            duration_ms=duration_ms,
            # The rendered audio, so vowel openness is measured from
            # this voice rather than predicted from spelling stress.
            cues=cues_from_text(text, duration_ms, locale, audio=audio),
            # Keyed as a native recording (the timed model is installed), so
            # a fallback must not be kept: the next request tries native again.
            cacheable=not fell_back,
        )


def _original_configured() -> bool:
    """Is kokoro-v1.0.onnx installed, with the voices?"""
    import os

    settings = get_settings()
    return bool(
        settings.kokoro_model_path
        and settings.kokoro_voices_path
        and os.path.isfile(settings.kokoro_model_path)
        and os.path.isfile(settings.kokoro_voices_path)
    )


def native_timing_enabled() -> bool:
    """Speak with the timestamped model? Installed, and not switched off."""
    from app.services.tts import lab_timing

    return bool(get_settings().kokoro_native_timing) and lab_timing.configured()


async def _synthesize_native(
    text: str, voice_id: str, lang: str, locale: str
) -> SynthesisResult | None:
    """Speech from the timestamped model, timed by the model's own spans, or
    None when the model could not speak (the caller falls back to the
    original one). Spans the timings cannot use (an unmapped phoneme, spans
    out of order) keep this audio and time it the stretched way instead:
    the recording is good, only its timestamps are not."""
    from app.services.tts import lab_timing

    try:
        audio, duration_ms, spans = await asyncio.to_thread(
            lab_timing.render_timed, text, voice_id, lang
        )
    except Exception:
        logger.exception("timestamped Kokoro synthesis failed; using the original model")
        return None
    try:
        cues = lab_timing.native_cues(spans, duration_ms, audio)
    except ValueError as exc:
        logger.warning("native timings unusable (%s); fitting cues to the audio instead", exc)
        cues = cues_from_text(text, duration_ms, locale, audio=audio)
    return SynthesisResult(audio=audio, audio_mime="audio/wav", duration_ms=duration_ms, cues=cues)


def _render(text: str, voice_id: str, lang: str) -> tuple[bytes, int]:
    import numpy as np
    import soundfile as sf

    engine = _get_engine()
    samples, sample_rate = engine.create(text, voice=voice_id, speed=1.0, lang=lang)
    buffer = io.BytesIO()
    # 16-bit PCM: float32 WAV doubles the payload for nothing audible.
    sf.write(buffer, np.asarray(samples), sample_rate, format="WAV", subtype="PCM_16")
    return buffer.getvalue(), int(len(samples) * 1000 / sample_rate)
