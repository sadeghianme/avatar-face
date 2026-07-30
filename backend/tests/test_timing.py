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
    cues = cues_for_duration("", 1000)
    assert len(cues) == 1
    assert cues[0]["t"] == 0
    assert cues[0]["viseme"] == "sil"


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


def test_word_marks_align_with_segment_clock() -> None:
    """Word offsets must agree with the cue clock, since `onboundary`
    corrections are applied to the same timeline the cues run on."""
    from app.services.tts.timing import plan_utterance, total_duration_ms

    text = "Hello there, this is a test."
    segments, marks = plan_utterance(text)

    # "Hello there, this is a test."
    #   0     6      13   18 21 23
    assert [m["char"] for m in marks] == [0, 6, 13, 18, 21, 23]
    assert marks[0]["t"] == 0
    # Strictly increasing, and never past the end of the utterance.
    assert all(b["t"] > a["t"] for a, b in zip(marks, marks[1:]))
    assert marks[-1]["t"] < total_duration_ms(segments)


def test_word_marks_handles_leading_space_and_empty() -> None:
    from app.services.tts.timing import plan_utterance

    assert plan_utterance("")[1] == []
    assert plan_utterance("   ")[1] == []
    assert plan_utterance("  hi")[1][0]["char"] == 2


def test_unstressed_syllables_get_a_smaller_mouth() -> None:
    """English reduces unstressed syllables, and a reduced vowel is a small
    mouth. Without this the face opens exactly as wide on "-ket" as on "MAR-",
    which is the most mechanical-looking thing a talking head can do."""
    from app.services.tts.timing import plan_utterance

    segments, _ = plan_utterance("The market opened.")
    amplitudes = {s.viseme: s.amplitude for s in segments}

    # "The" is a reduced function word; the stressed vowel of "market" is full.
    assert min(s.amplitude for s in segments) < 0.5
    assert max(s.amplitude for s in segments) == 1.0
    assert amplitudes["aa"] == 1.0  # stressed MAR-

    # Amplitude reaches the cue track the engine actually reads.
    from app.services.tts.timing import cues_from_segments

    assert any(c["a"] < 0.5 for c in cues_from_segments(segments))
    assert all("a" in c for c in cues_from_segments(segments))


def test_character_path_is_full_amplitude() -> None:
    """Non-English text has no stress model, so nothing should be damped."""
    from app.services.tts.timing import plan_utterance

    segments, _ = plan_utterance("Привет мир", "ru-RU")
    assert all(s.amplitude == 1.0 for s in segments)
