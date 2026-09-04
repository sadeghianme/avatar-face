"""How loud the synthesized audio actually is, moment to moment.

The timing model predicts how far each mouth shape should be reached from
the stress digit the g2p produced: a stressed vowel is a wide mouth, a
schwa is a small one. That is a prediction about a voice we had not heard
yet, and it is wrong often enough to see — a TTS voice puts its own
emphasis where it likes, races an unstressed word it happens to find easy,
and swallows syllables at the end of a falling sentence. The face then
opens exactly as wide on a syllable the voice barely uttered.

Once the audio exists we no longer have to predict: we can measure it. This
module turns the rendered WAV into a loudness curve, and the timing model
uses it to scale vowel amplitude toward what the voice really did.

Two rules keep this from doing harm:

  * Only VOWELS are modulated. A /p/ is a silence — closing the lips stops
    the sound — so scaling shapes by loudness would open the very closures
    the engine works hardest to protect. Consonants keep their planned
    amplitude.
  * The measurement can reduce a shape a long way and enlarge it only
    slightly. Alignment between the model's clock and the audio is good but
    not exact, so a mis-sampled window should cost a little openness, never
    invent a shout.

Returns None whenever anything is unavailable or unreadable — a missing
envelope means the planned amplitudes stand, which is what shipped before.
"""

from __future__ import annotations

import io
import logging
import wave

logger = logging.getLogger("liveface.tts.envelope")

# Analysis window. Short enough to separate neighbouring syllables (a fast
# vowel is ~90ms), long enough that a pitch period does not read as silence.
WINDOW_MS = 10

# What the loudness scale is measured against: a high percentile of the
# voiced windows rather than the peak, so one plosive burst or a click at
# the start does not make the whole utterance look quiet by comparison.
REFERENCE_PERCENTILE = 90

# Loudness below this fraction of the reference is treated as silence and
# maps to 0. Room tone and breath should not open a mouth.
NOISE_FLOOR = 0.06


class Envelope:
    """Normalised loudness over time, queryable by span."""

    def __init__(self, levels: list[float], window_ms: float) -> None:
        self._levels = levels
        self._window_ms = window_ms

    @property
    def windows(self) -> int:
        return len(self._levels)

    def mean(self, start_ms: float, end_ms: float) -> float:
        """Mean loudness over a span, 0..1.

        The MEAN rather than the peak: a syllable's openness is how much
        sound it carried, not whether it contained one loud instant. Peak
        made every consonant-vowel pair look equally loud, because the
        stop's release burst is as tall as the vowel that follows it.
        """
        if not self._levels or end_ms <= start_ms:
            return 0.0
        first = max(0, int(start_ms / self._window_ms))
        last = min(len(self._levels), int(end_ms / self._window_ms) + 1)
        if last <= first:
            first = min(first, len(self._levels) - 1)
            return self._levels[first]
        window = self._levels[first:last]
        return sum(window) / len(window)


def measure(audio: bytes, window_ms: float = WINDOW_MS) -> Envelope | None:
    """Loudness curve for WAV audio, or None if it cannot be measured."""
    try:
        import numpy as np
    except Exception:  # pragma: no cover - numpy ships with the image
        return None

    try:
        with wave.open(io.BytesIO(audio), "rb") as handle:
            channels = handle.getnchannels()
            width = handle.getsampwidth()
            rate = handle.getframerate()
            frames = handle.readframes(handle.getnframes())
    except Exception:
        # Not a WAV (mp3 from a hosted provider, or a truncated file).
        return None

    if width != 2 or rate <= 0 or not frames:
        # 16-bit PCM is what every self-hosted provider here writes.
        return None

    samples = np.frombuffer(frames, dtype="<i2").astype("float32")
    if channels > 1:
        usable = (len(samples) // channels) * channels
        samples = samples[:usable].reshape(-1, channels).mean(axis=1)
    if samples.size == 0:
        return None

    per_window = max(1, int(rate * window_ms / 1000))
    usable = (samples.size // per_window) * per_window
    if usable == 0:
        return None
    blocks = samples[:usable].reshape(-1, per_window)
    rms = np.sqrt(np.mean(np.square(blocks / 32768.0), axis=1))

    voiced = rms[rms > rms.max() * NOISE_FLOOR] if rms.max() > 0 else rms
    reference = float(np.percentile(voiced, REFERENCE_PERCENTILE)) if voiced.size else 0.0
    if reference <= 0:
        return None

    levels = np.clip(rms / reference, 0.0, 1.0)
    levels[levels < NOISE_FLOOR] = 0.0
    return Envelope([float(v) for v in levels], window_ms)
