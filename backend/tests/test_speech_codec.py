"""The speech cache's recording format (app.services.tts.speech_codec).

The cues are timed against the WAV a provider made, and the cache stores it
as MP3, which starts late by its encoder's delay unless the decoder trims
it. Browsers trim what the LAME header names (measured in Chromium, Firefox
and WebKit by embed/browser-tests/speech-timing.test.ts, which plays what
scripts/encode_speech.py writes): so the header must name the delay and the
padding exactly, the decoded samples must sit where the WAV's did, and the
script the browser test runs must write what the cache stores.
"""

import io
import struct
import subprocess
import sys
import wave
from pathlib import Path

import numpy as np
import soundfile

from app.core.config import Settings
from app.services.tts import speech_cache, speech_codec

BACKEND = Path(__file__).resolve().parents[1]
RATE = 24000
# An MPEG-2 Layer III frame (24 kHz): 576 samples.
FRAME = 576
CLICKS = (1_920, 12_000, 36_017, 60_001)


def _wav(samples: np.ndarray, rate: int = RATE) -> bytes:
    out = io.BytesIO()
    with wave.open(out, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes(samples.astype(np.int16).tobytes())
    return out.getvalue()


def _clicks(length: int = 72_013) -> np.ndarray:
    """Quiet noise with sharp 2 kHz bursts starting at CLICKS. An odd length,
    so the last frame's padding is not a whole frame."""
    rng = np.random.default_rng(3)
    samples = rng.standard_normal(length) * 30
    burst = np.sin(2 * np.pi * 2000 * np.arange(96) / RATE) * np.hanning(96) * 26_000
    for at in CLICKS:
        samples[at : at + 96] += burst
    return samples


def _lame_tag(mp3: bytes) -> tuple[int, int, int]:
    """(frames, encoder delay, padding) from the first frame's Xing (or Info)
    tag and the LAME extension after it."""
    start = max(mp3.find(b"Xing", 0, 64), mp3.find(b"Info", 0, 64))
    assert start >= 0, "no Xing/Info tag in the first frame"
    flags = struct.unpack(">I", mp3[start + 4 : start + 8])[0]
    assert flags & 1, "the tag does not count the frames"
    frames = struct.unpack(">I", mp3[start + 8 : start + 12])[0]
    # Frames, then bytes (flag 2), a 100-byte table of contents (4), a quality (8).
    lame = (
        start + 12 + (4 if flags & 2 else 0) + (100 if flags & 4 else 0) + (4 if flags & 8 else 0)
    )
    assert mp3[lame : lame + 4] == b"LAME", "no LAME extension after the tag"
    a, b, c = mp3[lame + 21 : lame + 24]
    return frames, (a << 4) | (b >> 4), ((b & 0x0F) << 8) | c


def test_the_mp3_names_its_delay_and_padding_exactly():
    """What the browsers trim: the delay before the first sample and the
    padding after the last, which leave exactly the WAV's samples."""
    samples = _clicks()
    encoded, mime = speech_codec.encode(_wav(samples), "audio/wav")
    assert mime == "audio/mpeg"
    frames, delay, padding = _lame_tag(encoded)
    assert frames * FRAME - delay - padding == len(samples)
    # LAME's own delay, 576 samples, and less than a frame of padding past
    # the decoder's: an encoder that named none would leave 46 ms of
    # silence in front of every line.
    assert delay == FRAME
    assert 0 < padding < 2 * FRAME


def test_the_mp3_decodes_on_the_wavs_own_samples():
    """Every burst where it was, to the sample (libsndfile honours the header
    as the browsers do)."""
    samples = _clicks()
    encoded, _ = speech_codec.encode(_wav(samples), "audio/wav")
    decoded, rate = soundfile.read(io.BytesIO(encoded), dtype="float64")
    assert rate == RATE and len(decoded) == len(samples)
    source = samples / 32768
    # The lag that best lines the two up, from the whole signal (by FFT).
    size = 1 << (2 * len(source) - 1).bit_length()
    product = np.fft.rfft(decoded, size) * np.conj(np.fft.rfft(source, size))
    correlation = np.fft.irfft(product, size)
    lag = int(np.argmax(correlation))
    assert (lag if lag < size // 2 else lag - size) == 0
    for at in CLICKS:
        window = np.abs(decoded[at - 200 : at + 300])
        assert abs(int(np.argmax(window)) - 200 - 48) <= 3


def test_the_browser_test_plays_what_the_cache_stores(tmp_path):
    """scripts/encode_speech.py (the browser test's encoder) writes the bytes
    the speech cache stores at the default level, and needs nothing of the
    backend but this module: the embed CI job runs it with soundfile and
    numpy alone."""
    source = tmp_path / "line.wav"
    source.write_bytes(_wav(_clicks()))
    target = tmp_path / "line.out"
    result = subprocess.run(
        [sys.executable, str(BACKEND / "scripts" / "encode_speech.py"), str(source), str(target)],
        capture_output=True,
        text=True,
        check=True,
    )
    stored, mime = speech_cache.encode(source.read_bytes(), "audio/wav")
    assert result.stdout.strip() == mime == "audio/mpeg"
    assert target.read_bytes() == stored
    assert Settings.model_fields["speech_cache_mp3_level"].default == speech_codec.DEFAULT_MP3_LEVEL

    loaded = subprocess.run(
        [
            sys.executable,
            "-c",
            "import sys; import app.services.tts.speech_codec; "
            "print(' '.join(sorted(m.split('.')[0] for m in sys.modules)))",
        ],
        cwd=BACKEND,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.split()
    assert not {"sqlalchemy", "pydantic", "pydantic_settings", "fastapi", "starlette"} & set(loaded)
