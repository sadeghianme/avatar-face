"""Native phoneme timing: cues from the timestamped Kokoro model's own spans.

The lip-sync lab introduced it; the Kokoro provider (services.tts.kokoro)
now speaks through the same model and `native_cues`, so what visitors hear
is timed by the model that made it rather than by a duration table
stretched to the audio's length. The lab keeps its own uncached comparison
path (`synthesize_native`), which also returns the stretched baseline.
Never changes a stored avatar.
"""

from __future__ import annotations

import asyncio
import io
import math
import threading
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from app.core.config import get_settings
from app.services.tts.envelope import measure
from app.services.tts.ipa import ipa_to_visemes
from app.services.tts.kokoro_voices import DEFAULT_VOICE, LANG_BY_PREFIX, VOICES
from app.services.tts.timing import ENVELOPE_VISEMES, cues_from_text


@dataclass(frozen=True)
class PhoneSpan:
    phoneme: str
    start: float  # seconds in the FINAL (trimmed, concatenated) audio
    end: float


def native_cues(spans: list[PhoneSpan], duration_ms: int, audio: bytes) -> list[dict]:
    """Keep model timestamps, including gaps; never globally stretch the track.

    Reject invalid metadata rather than advertise guessed timing as native.
    Affricates can be emitted as separate model tokens; combine their spans.
    """
    if not spans or duration_ms <= 0:
        raise ValueError("No native phoneme timings")
    # Duration outputs include stress/length tokens. They are articulation
    # modifiers, not silent sounds: attach stress to the following phone and
    # length to the preceding one, without moving actual word/pause gaps.
    normalized: list[PhoneSpan] = []
    previous_end = 0.0
    stress_start: float | None = None
    for span in spans:
        if (
            not math.isfinite(span.start)
            or not math.isfinite(span.end)
            or span.start < 0
            or span.end < span.start
            or span.start < previous_end - 0.002
            or span.end * 1000 > duration_ms + 2
        ):
            raise ValueError("Invalid native phoneme timestamps")
        contiguous = abs(span.start - previous_end) <= 0.002
        previous_end = span.end
        if span.phoneme in {"ˈ", "ˌ"}:
            if stress_start is None or not contiguous:
                stress_start = span.start
            continue
        if span.phoneme in {"ː", "ˑ", "̯", "̃", "͡"} and normalized and contiguous:
            prior = normalized[-1]
            normalized[-1] = PhoneSpan(prior.phoneme, prior.start, span.end)
            continue
        start = stress_start if stress_start is not None and contiguous else span.start
        normalized.append(PhoneSpan(span.phoneme, start, span.end))
        stress_start = None
    spans = normalized
    envelope = measure(audio)
    events: dict[int, dict] = {0: {"t": 0, "viseme": "sil", "a": 1.0}}
    previous_end = 0.0
    recognised = 0
    i = 0
    while i < len(spans):
        span = spans[i]
        start, end = span.start, span.end
        if (
            not math.isfinite(start)
            or not math.isfinite(end)
            or start < 0
            or end < start
            or start < previous_end - 0.002
            or end * 1000 > duration_ms + 2
        ):
            raise ValueError("Invalid native phoneme timestamps")
        previous_end = end
        symbol = span.phoneme
        # Validate each original span even when combining an affricate.
        if i + 1 < len(spans) and symbol + spans[i + 1].phoneme in {
            "tʃ",
            "dʒ",
            "ts",
            "dz",
            "tɕ",
            "dʑ",
        }:
            following = spans[i + 1]
            if (
                math.isfinite(following.start)
                and math.isfinite(following.end)
                and abs(following.start - end) <= 0.002
                and following.end >= following.start
                and following.end * 1000 <= duration_ms + 2
            ):
                symbol += following.phoneme
                end = following.end
                previous_end = end
                i += 1
        i += 1
        # Kokoro/espeak emits rhotic vowels and the reduced KIT vowel, plus
        # single-codepoint affricates in some voice vocabularies.
        aliases = {"ɚ": "RR", "ɝ": "RR", "ᵻ": "ih", "ʤ": "CH", "ʧ": "CH", "ʦ": "SS"}
        shapes = [aliases[symbol]] if symbol in aliases else ipa_to_visemes(symbol)
        if not shapes:
            # Stress/length/diacritic tokens carry no independent mouth pose.
            if symbol.strip() and all(c in "ˈˌːˑ̯̃͡" for c in symbol):
                continue
            if symbol.strip() and any(c.isalpha() for c in symbol):
                raise ValueError(f"Unmapped native phoneme: {symbol}")
            shapes = ["sil"]
        if len(shapes) != 1:
            raise ValueError("Expected one phoneme per timing span")
        viseme = shapes[0]
        recognised += viseme != "sil"
        at, until = max(0, round(start * 1000)), min(duration_ms, round(end * 1000))
        if until <= at:
            continue
        amplitude = 1.0
        if envelope is not None and viseme in ENVELOPE_VISEMES:
            amplitude = max(0.25, min(1.0, 0.5 + 0.65 * envelope.mean(at, until)))
        events[at] = {"t": at, "viseme": viseme, "a": round(amplitude, 3)}
        events[until] = {"t": until, "viseme": "sil", "a": 1.0}
    if not recognised:
        raise ValueError("No recognised native phonemes")
    events[duration_ms] = {"t": duration_ms, "viseme": "sil", "a": 1.0}
    result: list[dict] = []
    for at in sorted(events):
        item = events[at]
        if not result or item["viseme"] != result[-1]["viseme"] or at == duration_ms:
            result.append(item)
    return result


_engine = None
_lock = threading.Lock()
_render_lock = threading.Lock()
_semaphore: asyncio.Semaphore | None = None


def configured() -> bool:
    """Are the timestamped model and the voices installed?"""
    settings = get_settings()
    return bool(
        settings.kokoro_lipsync_model_path
        and Path(settings.kokoro_lipsync_model_path).is_file()
        and settings.kokoro_voices_path
        and Path(settings.kokoro_voices_path).is_file()
    )


def _get_engine():
    global _engine
    with _lock:
        if _engine is None:
            # The ONNX runtime and its model: heavy, loaded on first speech.
            from kokoro_onnx import Kokoro

            settings = get_settings()
            model, voices = settings.kokoro_lipsync_model_path, settings.kokoro_voices_path
            assert model and voices  # callers check is_configured() first
            engine = Kokoro(model, voices)
            # The ONNX Community export calls the output "durations"; the
            # runtime checks the singular spelling. It consumes output #1,
            # so accept the plural only after validating the full order.
            outputs = [o.name for o in engine.sess.get_outputs()]
            if outputs == ["waveform", "durations"]:
                engine.has_timings = True
            if not getattr(engine, "has_timings", False) or not hasattr(engine, "create_timed"):
                raise ValueError("Lab model/runtime does not expose phoneme durations")
            _engine = engine
        return _engine


def render_timed(text: str, voice_id: str, lang: str) -> tuple[bytes, int, list[PhoneSpan]]:
    """One synthesis with the timestamped model: 16-bit WAV, its length in
    ms, and the phoneme spans the model placed in it. Blocking CPU work,
    one inference at a time (the lab and the provider share the engine)."""
    import soundfile as sf  # libsndfile: only where Kokoro speaks

    with _render_lock:
        samples, rate, timings = _get_engine().create_timed(
            text,
            voice=voice_id,
            speed=1.0,
            lang=lang,
        )
    buffer = io.BytesIO()
    sf.write(buffer, np.asarray(samples), rate, format="WAV", subtype="PCM_16")
    duration = round(len(samples) * 1000 / rate)
    return buffer.getvalue(), duration, [PhoneSpan(t.phoneme, t.start, t.end) for t in timings]


def render_native(text: str, voice: str) -> tuple[bytes, int, list[dict], list[dict]]:
    chosen = next(
        (v for v in VOICES if v.id == voice), next(v for v in VOICES if v.id == DEFAULT_VOICE)
    )
    audio, duration, spans = render_timed(text, chosen.id, LANG_BY_PREFIX[chosen.id[0]])
    cues = native_cues(spans, duration, audio)
    baseline = cues_from_text(text, duration, chosen.locale, audio=audio)
    return audio, duration, cues, baseline


def reset_slot() -> None:
    """Forget the inference slot; the next speech makes a new one (tests: a
    semaphore belongs to the event loop that first waited on it)."""
    global _semaphore
    _semaphore = None


async def synthesize_native(text: str, voice: str):
    global _semaphore
    if _semaphore is None:
        _semaphore = asyncio.Semaphore(1)
    semaphore = _semaphore
    await semaphore.acquire()
    # Cancelling an HTTP stream cannot interrupt ONNX in a worker thread.
    # Keep the slot until that inference really finishes; repeated Stop clicks
    # must not accumulate abandoned workers waiting on the render lock.
    task = asyncio.create_task(asyncio.to_thread(render_native, text, voice))
    try:
        return await asyncio.shield(task)
    finally:
        if task.done():
            semaphore.release()
        else:

            def release(finished):
                semaphore.release()
                if not finished.cancelled():
                    finished.exception()  # consume a failed abandoned inference

            task.add_done_callback(release)


async def warm_native() -> None:
    """Warm the optional lab model off the startup/health-check critical path."""
    if configured():
        await synthesize_native("Hello.", DEFAULT_VOICE)
