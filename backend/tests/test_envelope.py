"""Loudness measured from the rendered audio, and what it may change."""

import io
import math
import struct
import wave

from app.services.tts.envelope import NOISE_FLOOR, Envelope, measure
from app.services.tts.timing import (
    ENVELOPE_MAX_FACTOR,
    ENVELOPE_MIN_FACTOR,
    ENVELOPE_VISEMES,
    MIN_AMPLITUDE,
    Segment,
    cues_from_segments,
)

RATE = 22050


def wav(spans: list[tuple[int, float]], rate: int = RATE, channels: int = 1) -> bytes:
    """WAV of (duration_ms, amplitude 0..1) spans — a 200Hz tone at each level."""
    frames = bytearray()
    phase = 0.0
    for duration_ms, level in spans:
        for _ in range(int(rate * duration_ms / 1000)):
            phase += 2 * math.pi * 200 / rate
            value = int(level * 32000 * math.sin(phase))
            for _c in range(channels):
                frames += struct.pack("<h", value)
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(channels)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes(bytes(frames))
    return buffer.getvalue()


class TestMeasure:
    def test_reads_levels_back_in_the_right_places(self):
        audio = wav([(300, 1.0), (300, 0.25), (300, 1.0)])
        env = measure(audio)
        assert env is not None
        loud_first = env.mean(50, 250)
        quiet = env.mean(350, 550)
        loud_last = env.mean(650, 850)
        assert loud_first > 0.9
        assert loud_last > 0.9
        # A quarter of the amplitude is a quarter of the loudness.
        assert 0.2 < quiet < 0.35

    def test_silence_reads_as_zero_not_as_noise(self):
        env = measure(wav([(200, 1.0), (300, 0.0), (200, 1.0)]))
        assert env is not None
        assert env.mean(250, 450) < NOISE_FLOOR

    def test_normalises_to_the_utterance_not_to_full_scale(self):
        """A quietly recorded voice still opens its mouth. The scale is
        relative to this utterance's own loud passages."""
        loud = measure(wav([(300, 0.9), (300, 0.3)]))
        quiet = measure(wav([(300, 0.09), (300, 0.03)]))
        assert loud is not None and quiet is not None
        assert abs(loud.mean(50, 250) - quiet.mean(50, 250)) < 0.05

    def test_one_burst_does_not_flatten_the_utterance(self):
        """A percussive click is not the reference — a high percentile is,
        so ordinary speech after it still measures as loud."""
        env = measure(wav([(20, 1.0), (400, 0.5), (400, 0.5)]))
        assert env is not None
        assert env.mean(100, 700) > 0.85

    def test_stereo_is_averaged_not_misread(self):
        env = measure(wav([(300, 1.0), (300, 0.25)], channels=2))
        assert env is not None
        assert env.mean(50, 250) > 0.9
        assert env.mean(350, 550) < 0.4

    def test_unreadable_audio_gives_no_envelope(self):
        assert measure(b"") is None
        assert measure(b"not a wav at all") is None
        assert measure(wav([])) is None

    def test_mean_is_bounded_and_total_silence_has_no_scale(self):
        assert measure(wav([(300, 0.0)])) is None
        env = measure(wav([(300, 1.0)]))
        assert env is not None
        assert 0.0 <= env.mean(-100, 10_000) <= 1.0


class TestAmplitudeFromEnvelope:
    def _segments(self):
        # "loud vowel, gap, quiet vowel" — one shape, two very different
        # deliveries, both planned as fully stressed.
        return [
            Segment("aa", 300, amplitude=1.0),
            Segment("sil", 300, amplitude=1.0),
            Segment("aa", 300, amplitude=1.0),
        ]

    def test_a_syllable_the_voice_rushed_is_a_smaller_mouth(self):
        env = measure(wav([(300, 1.0), (300, 0.0), (300, 0.2)]))
        cues = cues_from_segments(self._segments(), envelope=env)
        vowels = [c for c in cues if c["viseme"] == "aa"]
        assert len(vowels) == 2
        assert vowels[0]["a"] > 0.95
        assert vowels[1]["a"] < 0.75
        assert vowels[1]["a"] >= MIN_AMPLITUDE

    def test_without_audio_nothing_changes(self):
        planned = cues_from_segments(self._segments())
        assert [c["a"] for c in planned if c["viseme"] == "aa"] == [1.0, 1.0]

    def test_measurement_never_invents_a_shout(self):
        """The upper bound is deliberately near 1: alignment is good, not
        exact, so a mis-sampled window must not exaggerate a shape."""
        env = measure(wav([(300, 1.0), (300, 1.0), (300, 1.0)]))
        quiet_plan = [Segment("aa", 300, amplitude=0.5)]
        cues = cues_from_segments(quiet_plan, envelope=env)
        vowel = next(c for c in cues if c["viseme"] == "aa")
        assert vowel["a"] <= 0.5 * ENVELOPE_MAX_FACTOR + 1e-6
        assert vowel["a"] <= 1.0

    def test_consonants_are_never_scaled_by_loudness(self):
        """A /p/ IS a silence — the lips closing is what stops the sound.
        Scaling it by loudness would open the closure."""
        assert "PP" not in ENVELOPE_VISEMES
        assert "FF" not in ENVELOPE_VISEMES
        segments = [
            Segment("PP", 60, amplitude=1.0),
            Segment("aa", 300, amplitude=1.0),
        ]
        # Silence exactly where the closure is.
        env = measure(wav([(60, 0.0), (300, 1.0)]))
        cues = cues_from_segments(segments, envelope=env)
        closure = next(c for c in cues if c["viseme"] == "PP")
        assert closure["a"] == 1.0

    def test_the_track_is_otherwise_identical(self):
        """Only amplitudes may move: same cues, same times, same order."""
        env = measure(wav([(300, 1.0), (300, 0.1), (300, 0.6)]))
        planned = cues_from_segments(self._segments())
        measured = cues_from_segments(self._segments(), envelope=env)
        assert [c["t"] for c in planned] == [c["t"] for c in measured]
        assert [c["viseme"] for c in planned] == [c["viseme"] for c in measured]

    def test_bounds_hold_for_every_reachable_loudness(self):
        for level in (0.0, 0.05, 0.3, 0.7, 1.0):
            env = measure(wav([(400, max(level, 0.001)), (100, 1.0)]))
            if env is None:
                continue
            cues = cues_from_segments([Segment("aa", 400, amplitude=1.0)], envelope=env)
            amp = next(c for c in cues if c["viseme"] == "aa")["a"]
            assert MIN_AMPLITUDE <= amp <= 1.0
            assert amp >= ENVELOPE_MIN_FACTOR - 1e-6


class TestSilenceSupersede:
    """A word-initial plosive must actually shut the lips.

    Anticipation moves a /p/ up to 55ms earlier and a word gap is 55ms, so
    the closure lands exactly where the gap's silence starts. Clamping it
    to one millisecond after produced a 1ms silence with a plosive on top,
    which the client's cue tidying then deleted as a collision.
    """

    def _visemes_at(self, text: str, duration: int = 3600):
        from app.services.tts.timing import cues_for_duration

        return cues_for_duration(text, duration, "en-US")

    def test_word_initial_plosives_keep_a_real_span(self):
        cues = self._visemes_at("Peter picked a peck of pickled peppers by the pretty pool.")
        gaps = [
            cues[i]["t"] - cues[i - 1]["t"]
            for i in range(1, len(cues))
            if cues[i]["viseme"] == "PP"
        ]
        assert gaps, "the sentence should contain word-initial plosives"
        # 40ms is the client's transient floor; anything at or under it is
        # merged away and the closure is never drawn.
        assert min(gaps) > 40

    def test_punctuation_keeps_its_silence(self):
        """A comma is 180ms — long enough that an approaching closure still
        starts inside it, so the pause survives."""
        cues = self._visemes_at("Hello, please wait.", 2000)
        assert any(c["viseme"] == "sil" for c in cues[:-2])
        silences = [c for c in cues if c["viseme"] == "sil"]
        assert len(silences) >= 2

    def test_cue_times_stay_ordered_and_non_negative(self):
        for text in (
            "Peter picked a peck.",
            "Buy my pretty purple parrot, please.",
            "Mmm, pop.",
            "A.",
        ):
            cues = self._visemes_at(text, 2500)
            times = [c["t"] for c in cues]
            assert times == sorted(times)
            assert times[0] >= 0
            assert len(set(times)) == len(times)

    def test_a_track_still_ends_closed(self):
        cues = self._visemes_at("Peter picked a peck.", 2000)
        assert cues[-1]["viseme"] == "sil"
