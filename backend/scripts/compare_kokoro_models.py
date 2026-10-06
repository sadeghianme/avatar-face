"""Do kokoro-v1.0.onnx and kokoro-timed.onnx make the same speech?

The Kokoro provider speaks with the timestamped model when it is installed
(services.tts.kokoro), and loads the original model only when that fails.
Whether the original can go from the image entirely depends on this answer,
so it is measured, not assumed: both models read the same sentences with
the same voice, through the same runtime path, and the waveforms are
compared.

Two comparisons per sentence:

- `raw`: one batch through the model graph alone (`_create_audio`), no
  pause insertion. Equal lengths and a correlation near 1 mean the same
  weights; Kokoro's vocoder adds noise, so bit equality is not expected even
  between two runs of one model, and the script runs the original twice to
  show that floor.
- `served`: `create`, what the provider serves. kokoro-onnx inserts pauses
  after every comma and full stop when a model reports timings, so the
  timed model's served audio is longer wherever the text has clause marks,
  whatever the weights.

Needs both models and the voices on disk; downloads nothing. Run from
backend/ with the paths the Dockerfile uses:

    KOKORO_MODEL_PATH=models/kokoro-v1.0.onnx \\
    KOKORO_LIPSYNC_MODEL_PATH=models/kokoro-timed.onnx \\
    KOKORO_VOICES_PATH=models/voices-v1.0.bin \\
    .venv/bin/python -m scripts.compare_kokoro_models
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

import numpy as np

SENTENCES = (
    "Hello.",
    "Peter bought a blue paper bag.",
    "Please pause, then read the next line slowly.",
    "Five very vivid flowers, a tiny green frog, and three bright blue boats.",
)


def _correlation(a: np.ndarray, b: np.ndarray) -> float:
    n = min(len(a), len(b))
    if n == 0:
        return 0.0
    a, b = a[:n] - a[:n].mean(), b[:n] - b[:n].mean()
    denominator = float(np.sqrt((a * a).sum() * (b * b).sum())) or 1.0
    return float((a * b).sum()) / denominator


def _envelope_correlation(a: np.ndarray, b: np.ndarray, frame: int = 240) -> float:
    """Correlation of 10 ms RMS envelopes: robust to vocoder noise and phase."""

    def envelope(x: np.ndarray) -> np.ndarray:
        usable = len(x) // frame * frame
        return np.sqrt((x[:usable].reshape(-1, frame) ** 2).mean(axis=1))

    return _correlation(envelope(a), envelope(b))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--voice", default="af_heart")
    parser.add_argument("--lang", default="en-us")
    args = parser.parse_args()
    original = os.environ.get("KOKORO_MODEL_PATH")
    timed = os.environ.get("KOKORO_LIPSYNC_MODEL_PATH")
    voices = os.environ.get("KOKORO_VOICES_PATH")
    if not all(path and Path(path).is_file() for path in (original, timed, voices)):
        print("Set KOKORO_MODEL_PATH, KOKORO_LIPSYNC_MODEL_PATH and KOKORO_VOICES_PATH "
              "to existing files.", file=sys.stderr)
        return 2

    from kokoro_onnx import Kokoro

    first = Kokoro(original, voices)
    second = Kokoro(timed, voices)
    # The export names its duration output in the plural (lab_timing).
    if [o.name for o in second.sess.get_outputs()] == ["waveform", "durations"]:
        second.has_timings = True
    style = first.get_voice_style(args.voice)

    for sentence in SENTENCES:
        phonemes = first.tokenizer.phonemize(sentence, args.lang)
        raw_a, _ = first._create_audio(phonemes, style, 1.0)
        raw_again, _ = first._create_audio(phonemes, style, 1.0)
        raw_b, _ = second._create_audio(phonemes, style, 1.0)
        served_a, _ = first.create(sentence, voice=args.voice, lang=args.lang)
        served_b, _ = second.create(sentence, voice=args.voice, lang=args.lang)
        print(f"\n{sentence!r}")
        print(f"  raw    samples {len(raw_a)} vs {len(raw_b)}  "
              f"corr {_correlation(raw_a, raw_b):.4f}  env {_envelope_correlation(raw_a, raw_b):.4f}  "
              f"(same model twice: corr {_correlation(raw_a, raw_again):.4f}, "
              f"identical {np.array_equal(raw_a, raw_again)})")
        print(f"  served samples {len(served_a)} vs {len(served_b)}  "
              f"({(len(served_b) - len(served_a)) / 24:.0f} ms longer)  "
              f"env {_envelope_correlation(served_a, served_b):.4f}  "
              f"identical {np.array_equal(served_a, served_b)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
