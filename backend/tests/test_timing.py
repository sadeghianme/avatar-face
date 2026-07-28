"""Phoneme-class speech timing model."""
import io
import wave

import pytest

from app.services.tts.offline import OfflineTTSProvider
from app.services.tts.timing import (
    PAUSE_MS,
    cues_for_duration,
    cues_from_segments,
    segment_text,
    total_duration_ms,
)


def _duration_of(text: str, viseme: str) -> int:
    return next(s.duration_ms for s in segment_text(text) if s.viseme == viseme)


def test_vowels_last_longer_than_stops():
    assert _duration_of("a", "aa") > _duration_of("t", "DD") * 2


def test_punctuation_buys_silence():
    segments = segment_text("hi. there")
    pause = max(s.duration_ms for s in segments if s.viseme == "sil")
    assert pause >= PAUSE_MS["."]


def test_word_gap_shorter_than_sentence_pause():
    gap = total_duration_ms(segment_text("a b")) - total_duration_ms(segment_text("ab"))
    stop = total_duration_ms(segment_text("a.b")) - total_duration_ms(segment_text("ab"))
    assert 0 < gap < stop


def test_whitespace_runs_collapse():
    assert total_duration_ms(segment_text("a    b")) == total_duration_ms(segment_text("a b"))


def test_cues_are_monotonic_and_end_silent():
    cues = cues_from_segments(segment_text("Hello there. How are you?"))
    assert all(cues[i]["t"] < cues[i + 1]["t"] for i in range(len(cues) - 1))
    assert cues[-1]["viseme"] == "sil"
    assert cues[0]["t"] == 0


def test_anticipation_leads_rounded_vowels():
    """The rounded shape for 'oo' should start before its slot begins."""
    cues = cues_from_segments(segment_text("sooo"))
    rounded = next(c for c in cues if c["viseme"] in ("oh", "ou"))
    # 's' occupies the first 100ms; anticipation pulls rounding earlier.
    assert rounded["t"] < 100


def test_cues_for_duration_scales_to_audio():
    cues = cues_for_duration("Hello there, friend.", 2000)
    assert cues[-1]["t"] <= 2001
    assert cues[-1]["t"] > 1500  # actually fills the audio


def test_cues_for_duration_handles_empty():
    assert cues_for_duration("", 1000) == [{"t": 0, "viseme": "sil"}]


@pytest.mark.asyncio
async def test_offline_audio_matches_cue_clock():
    result = await OfflineTTSProvider().synthesize(
        "Hello there. How are you today?", "offline-warm", "en-US"
    )
    with wave.open(io.BytesIO(result.audio)) as wav:
        audio_ms = int(wav.getnframes() * 1000 / wav.getframerate())
    # Audio and cues are generated from one segment list.
    assert abs(audio_ms - result.duration_ms) <= 5
    assert abs(cues_end(result.cues) - result.duration_ms) <= 5


def cues_end(cues: list[dict]) -> int:
    return cues[-1]["t"]


@pytest.mark.asyncio
async def test_offline_timing_is_not_uniform():
    """The old model spread every character evenly; real speech doesn't."""
    result = await OfflineTTSProvider().synthesize("aaa ttt", "offline-warm", "en-US")
    gaps = [result.cues[i + 1]["t"] - result.cues[i]["t"] for i in range(len(result.cues) - 1)]
    assert max(gaps) > min(gaps) * 2
