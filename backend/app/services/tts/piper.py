"""Piper: self-hosted voices for the languages Kokoro does not speak.

Kokoro covers nine languages well. Piper covers roughly thirty adequately,
and the gap between those two sets is the point of this provider — Persian
above all, but also Arabic, Turkish, Russian, German, Dutch and Polish.
Both run on our own CPU, so neither costs anything per character.

Quality is honestly below Kokoro: Piper is clearly synthetic where Kokoro
is close to a paid API. That ordering is why the registry lists Kokoro
first and why the picker prefers it when both can speak a locale. Piper is
what makes the difference between "your language works" and "your language
is not supported", which matters far more than the last increment of
naturalness.

Voices are per-language ONNX files (~63MB each), downloaded in the
Dockerfile alongside the other models. Only the ones actually present on
disk are advertised, so an image built without them degrades to "provider
unconfigured" instead of offering voices that 500.

Piper phonemizes with espeak — the same front end this project already
uses for lip-sync in ~100 languages — so the visemes and the audio are
derived from the same phonemization of the same text.
"""
from __future__ import annotations

import asyncio
import io
import os
import threading
import wave

from app.core.config import get_settings
from app.services.tts.base import SynthesisResult, TTSProvider, Voice
from app.services.tts.visemes import cues_from_text

# id -> (filename stem, display name, locale). Deliberately small: one or two
# voices per language beats a list nobody can choose from.
#
# ORDER MATTERS. resolve() takes the first voice matching a locale, so the
# first entry per language is that language's default. Persian leads with
# Amir by the owner's choice after hearing all three fa_IR voices; a test
# pins it so a future reorder cannot silently change which voice every
# Persian avatar speaks in.
CATALOGUE: dict[str, tuple[str, str, str]] = {
    "fa_amir": ("fa_IR-amir-medium", "Amir · Persian male", "fa-IR"),
    "fa_gyro": ("fa_IR-gyro-medium", "Gyro · Persian male", "fa-IR"),
    "ar_kareem": ("ar_JO-kareem-medium", "Kareem · Arabic male", "ar-JO"),
    "tr_dfki": ("tr_TR-dfki-medium", "DFKI · Turkish male", "tr-TR"),
    "ru_dmitri": ("ru_RU-dmitri-medium", "Dmitri · Russian male", "ru-RU"),
    "de_thorsten": ("de_DE-thorsten-medium", "Thorsten · German male", "de-DE"),
    "nl_mls": ("nl_NL-mls-medium", "MLS · Dutch", "nl-NL"),
    "pl_darkman": ("pl_PL-darkman-medium", "Darkman · Polish male", "pl-PL"),
}

_voices: dict[str, object] = {}
_load_lock = threading.Lock()
_synth_semaphore: asyncio.Semaphore | None = None


def _model_path(stem: str) -> str:
    directory = get_settings().piper_voices_dir or ""
    return os.path.join(directory, f"{stem}.onnx")


def _installed() -> list[str]:
    """Voice ids whose model file is actually on disk."""
    if not get_settings().piper_voices_dir:
        return []
    return [vid for vid, (stem, _, _) in CATALOGUE.items() if os.path.isfile(_model_path(stem))]


def _get_voice(stem: str):
    """Load a voice once and keep it. Each is ~63MB resident, which is why
    only the handful in CATALOGUE are ever loadable."""
    with _load_lock:
        if stem not in _voices:
            from piper import PiperVoice

            _voices[stem] = PiperVoice.load(_model_path(stem))
        return _voices[stem]


class PiperTTSProvider(TTSProvider):
    name = "piper"
    display_name = "Server voice · more languages"

    def is_configured(self) -> bool:
        return bool(_installed())

    async def voices(self) -> list[Voice]:
        out = []
        for vid in _installed():
            _, name, locale = CATALOGUE[vid]
            gender = "male" if "male" in name else "neutral"
            out.append(Voice(id=vid, name=name, locale=locale, gender=gender))
        return out

    async def synthesize(self, text: str, voice: str, locale: str) -> SynthesisResult:
        global _synth_semaphore
        if _synth_semaphore is None:
            _synth_semaphore = asyncio.Semaphore(1)

        installed = _installed()
        if not installed:
            raise RuntimeError("No Piper voices are installed on this server")
        # An unknown id must not 500 a visitor's page: prefer a voice for the
        # requested locale, else the first installed one.
        if voice not in installed:
            voice = next(
                (v for v in installed if CATALOGUE[v][2] == locale), installed[0]
            )
        stem, _, voice_locale = CATALOGUE[voice]

        async with _synth_semaphore:
            audio, duration_ms = await asyncio.to_thread(_render, text, stem)
        return SynthesisResult(
            audio=audio,
            audio_mime="audio/wav",
            duration_ms=duration_ms,
            # The voice's own locale, not the caller's: the phonemes that
            # produced this audio are that language's, so the visemes must be
            # derived the same way or the mouth drifts from the sound.
            cues=cues_from_text(text, duration_ms, voice_locale, audio=audio),
        )


def _render(text: str, stem: str) -> tuple[bytes, int]:
    voice = _get_voice(stem)
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as handle:
        voice.synthesize_wav(text, handle)
    data = buffer.getvalue()
    with wave.open(io.BytesIO(data), "rb") as handle:
        duration_ms = int(handle.getnframes() * 1000 / handle.getframerate())
    return data, duration_ms
