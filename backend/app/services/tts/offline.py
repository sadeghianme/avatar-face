"""Always-on offline TTS.

Generates deterministic, speech-like audio (formant-ish hum shaped per
viseme) plus per-character viseme cues, so preview and embed work with zero
API keys. Not meant to sound human — meant to be free, instant, and to drive
the lip-sync exactly like a real provider would.
"""
from __future__ import annotations

import io
import math
import struct
import wave

from app.services.tts.base import SynthesisResult, TTSProvider, Voice
from app.services.tts.timing import cues_from_segments, segment_text, total_duration_ms

SAMPLE_RATE = 22050

# Rough formant frequency per viseme: vowels low+loud, fricatives noisy-ish.
VISEME_PITCH: dict[str, float] = {
    "sil": 0.0, "PP": 130, "FF": 480, "TH": 420, "DD": 300, "kk": 260,
    "CH": 380, "SS": 520, "nn": 200, "RR": 240, "aa": 140, "E": 200,
    "ih": 260, "oh": 160, "ou": 150,
}

VOICES = [
    Voice(id="offline-warm", name="Offline · Warm", locale="en-US", gender="neutral"),
    Voice(id="offline-bright", name="Offline · Bright", locale="en-US", gender="neutral"),
]


class OfflineTTSProvider(TTSProvider):
    name = "offline"
    display_name = "Offline (built-in)"

    def is_configured(self) -> bool:
        return True

    async def voices(self) -> list[Voice]:
        return VOICES

    async def synthesize(self, text: str, voice: str, locale: str) -> SynthesisResult:
        pitch_mul = 1.25 if voice == "offline-bright" else 1.0
        # Audio and cues are generated from ONE segment list, so the mouth
        # can never drift from the sound.
        segments = segment_text(text)
        samples: list[float] = []
        phase = 0.0

        for segment in segments:
            n = int(SAMPLE_RATE * segment.duration_ms / 1000)
            freq = VISEME_PITCH.get(segment.viseme, 180) * pitch_mul
            if freq <= 0 or segment.viseme == "sil":
                samples.extend([0.0] * n)
                continue
            for i in range(n):
                # Envelope per articulation so syllables pulse audibly.
                env = math.sin(math.pi * i / n) * 0.35
                phase += 2 * math.pi * freq / SAMPLE_RATE
                # Base tone + a quiet octave for timbre.
                samples.append(env * (math.sin(phase) + 0.35 * math.sin(2 * phase)))

        t_ms = total_duration_ms(segments)
        if not samples:  # empty text still returns valid audio
            samples = [0.0] * int(SAMPLE_RATE * 0.2)
            t_ms = 200
        cues = cues_from_segments(segments)

        buf = io.BytesIO()
        with wave.open(buf, "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(SAMPLE_RATE)
            frames = b"".join(
                struct.pack("<h", int(max(-1.0, min(1.0, s)) * 32767)) for s in samples
            )
            wav.writeframes(frames)

        return SynthesisResult(
            audio=buf.getvalue(),
            audio_mime="audio/wav",
            duration_ms=t_ms,
            cues=cues,
        )
