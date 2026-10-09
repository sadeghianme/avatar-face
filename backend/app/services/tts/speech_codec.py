"""How the speech cache stores a recording: a WAV as MP3, kept only when it
decodes in place.

MP3 is VBR from libsndfile's LAME (soundfile, already a dependency), about a
tenth of the WAV. Every MP3 starts late by its encoder's delay (576 samples,
plus the decoder's 529: 46 ms at Kokoro's 24 kHz) and ends with padding;
libsndfile writes the LAME header that names both, and a decoder that
honours it gives back exactly the WAV's samples, so the cues, timed against
the WAV, stay on time. One that ignored it would play every line 46 ms late,
the mouth ahead of the voice.

Measured on 2026-10-09 (embed/browser-tests/speech-timing.test.ts, which CI
runs on every change with this module's own output): Chromium, Firefox and
WebKit (Safari's media stack) all honour it, through the audio element the
widget and the share page play speech with and through decodeAudioData.
decodeAudioData puts every mark on its source sample; through the element an
MP3 and its WAV are within 3 ms of each other. `encode` still checks every
line with libsndfile's decoder, and keeps the WAV when its samples would not
come back in full.

No application imports: the browser test runs this module alone
(scripts/encode_speech.py), with soundfile and numpy and nothing else of the
backend.
"""

from __future__ import annotations

import io
import logging

logger = logging.getLogger("liveface.speech_cache")

MP3 = "audio/mpeg"
WAV_MIMES = frozenset({"audio/wav", "audio/x-wav", "audio/wave"})
# libsndfile's VBR compression level, 0 (best) to 1 (smallest): the default
# of the SPEECH_CACHE_MP3_LEVEL setting.
DEFAULT_MP3_LEVEL = 0.5

_mp3_unavailable_logged = False


def encode(audio: bytes, mime: str, level: float = DEFAULT_MP3_LEVEL) -> tuple[bytes, str]:
    """`audio` as the cache stores it: a WAV as MP3, anything else as it is.

    The MP3 is kept only if it decodes to exactly the WAV's samples (the
    LAME header's delay and padding honoured): otherwise the cues would be
    late by the encoder's delay, and the original is kept instead. CPU work:
    call it on a thread.
    """
    global _mp3_unavailable_logged
    if mime not in WAV_MIMES:
        return audio, mime
    import soundfile  # optional runtime (tests.test_layering.LAZY)

    try:
        samples, rate = soundfile.read(io.BytesIO(audio), dtype="int16")
        out = io.BytesIO()
        soundfile.write(
            out,
            samples,
            rate,
            format="MP3",
            subtype="MPEG_LAYER_III",
            compression_level=level,
            bitrate_mode="VARIABLE",
        )
        encoded = out.getvalue()
        decoded = soundfile.info(io.BytesIO(encoded)).frames
    except (soundfile.LibsndfileError, RuntimeError, ValueError, TypeError) as error:
        if not _mp3_unavailable_logged:
            _mp3_unavailable_logged = True
            logger.warning("speech is cached as it came, not as MP3: %s", error)
        return audio, mime
    if decoded != len(samples):
        logger.warning("an MP3 decoded to %d samples, not %d: kept as WAV", decoded, len(samples))
        return audio, mime
    return encoded, MP3


def as_wav(audio: bytes, mime: str) -> bytes:
    """`audio` as 16-bit PCM WAV, for a caller that reads samples (the
    dashboard's phrase stream). CPU work: call it on a thread."""
    if mime in WAV_MIMES:
        return audio
    import soundfile  # optional runtime (tests.test_layering.LAZY)

    samples, rate = soundfile.read(io.BytesIO(audio), dtype="int16")
    out = io.BytesIO()
    soundfile.write(out, samples, rate, format="WAV", subtype="PCM_16")
    return out.getvalue()
