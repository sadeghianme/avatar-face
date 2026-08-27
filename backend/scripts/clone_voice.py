"""Clone a voice on this machine and upload the rendered lines.

Cloning runs where the hardware is — an Apple Silicon laptop or a GPU box —
because it is two to three times slower than real time and cannot sit inside
a web request. This script does that work and hands the results to the
server, which stores them as speech-cache entries and serves them like any
other voice.

    python -m scripts.clone_voice \
        --reference me.wav \
        --lines lines.txt \
        --name sarah \
        --api https://avatar.example.com \
        --token "$LIVEFACE_TOKEN" \
        --org ORG_ID

`--reference` is ~10 seconds of clean speech from the person whose voice
this is. `--lines` is one line of text per line of file: every phrase the
avatar will be able to say in that voice. Anything not listed falls back to
a server voice at playback time, so the list is the vocabulary.

Setup (once)::

    pip install chatterbox-tts resemble-perth "setuptools<81" requests

The setuptools pin is not cosmetic: perth, which applies Chatterbox's
watermark, imports pkg_resources, and without it the model fails to load
with a bare "'NoneType' object is not callable".

On consent: cloning reproduces a real person's voice. Every upload carries
an attestation, and the server refuses without it. Use this on your own
voice, or on one you have written permission to use.
"""

from __future__ import annotations

import argparse
import io
import sys
import time
import wave
from pathlib import Path

SAMPLE_WIDTH = 2  # 16-bit PCM: half the bytes of Chatterbox's float32, no
                  # audible difference, and what every browser decodes.


def _to_wav_bytes(tensor, sample_rate: int) -> bytes:
    """Chatterbox returns float32 in [-1, 1]; browsers want PCM."""
    import numpy as np

    samples = tensor.squeeze().detach().cpu().numpy()
    clipped = np.clip(samples, -1.0, 1.0)
    pcm = (clipped * 32767).astype(np.int16)
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(SAMPLE_WIDTH)
        handle.setframerate(sample_rate)
        handle.writeframes(pcm.tobytes())
    return buffer.getvalue()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reference", required=True, help="~10s WAV of the voice")
    parser.add_argument("--lines", required=True, help="file with one phrase per line")
    parser.add_argument("--name", required=True, help="voice name, e.g. sarah")
    parser.add_argument(
        "--api",
        required=True,
        help="API base URL, including any prefix — e.g. https://host/api "
             "in production, http://localhost:7002 against the backend directly",
    )
    parser.add_argument("--token", required=True, help="dashboard access token")
    parser.add_argument("--org", required=True, help="organisation id")
    parser.add_argument("--locale", default="en-US")
    parser.add_argument("--device", default="mps", help="mps (Apple), cuda, or cpu")
    parser.add_argument(
        "--out", help="also write the WAVs here, so a failed upload is not a re-render"
    )
    parser.add_argument(
        "--yes-i-have-consent",
        action="store_true",
        help="attest that this voice is yours or you have the speaker's permission",
    )
    args = parser.parse_args()

    if not args.yes_i_have_consent:
        print(
            "Refusing: pass --yes-i-have-consent to attest that this voice is yours\n"
            "or that you have the speaker's written permission.",
            file=sys.stderr,
        )
        return 2

    reference = Path(args.reference)
    if not reference.is_file():
        print(f"No such reference audio: {reference}", file=sys.stderr)
        return 2
    lines = [
        line.strip()
        for line in Path(args.lines).read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    if not lines:
        print("The lines file is empty", file=sys.stderr)
        return 2

    import requests
    from chatterbox.tts import ChatterboxTTS

    print(f"loading model on {args.device} …", flush=True)
    started = time.time()
    model = ChatterboxTTS.from_pretrained(device=args.device)
    print(f"  ready in {time.time() - started:.0f}s", flush=True)

    # The clone itself: a speaker embedding, not a training run.
    started = time.time()
    model.prepare_conditionals(str(reference))
    print(f"cloned '{args.name}' from {reference.name} in {time.time() - started:.1f}s")

    out_dir = Path(args.out) if args.out else None
    if out_dir:
        out_dir.mkdir(parents=True, exist_ok=True)

    # No /api guessed here: it is part of --api or it is not there at all.
    # Guessing it cost a full re-render the first time this ran.
    endpoint = f"{args.api.rstrip('/')}/orgs/{args.org}/cloned-voices/{args.name}/lines"
    headers = {"Authorization": f"Bearer {args.token}"}
    failures = 0

    for index, text in enumerate(lines, start=1):
        started = time.time()
        # Reuse audio from a previous run when --out has it: a failed upload
        # should cost a retry, not another few seconds per line of GPU time.
        cached_path = out_dir / f"{index:03d}.wav" if out_dir else None
        if cached_path and cached_path.is_file():
            audio = cached_path.read_bytes()
            reused = True
        else:
            audio = _to_wav_bytes(model.generate(text), model.sr)
            reused = False
            if cached_path:
                cached_path.write_bytes(audio)
        seconds = len(audio) / (model.sr * SAMPLE_WIDTH)
        took = time.time() - started

        try:
            response = requests.post(
                endpoint,
                headers=headers,
                data={"text": text, "locale": args.locale, "consent": "true"},
                files={"audio": (f"{index:03d}.wav", audio, "audio/wav")},
                timeout=120,
            )
            response.raise_for_status()
            stored = response.json()
            status = f"uploaded ({stored['lines']} lines total)"
        except Exception as exc:  # keep going: one bad upload is not the batch
            failures += 1
            detail = getattr(getattr(exc, "response", None), "text", "")[:160]
            status = f"UPLOAD FAILED {exc}{' ' + detail if detail else ''}"

        how = "reused" if reused else f"rendered in {took:4.1f}s"
        print(f"  [{index}/{len(lines)}] {seconds:4.1f}s audio, {how} — {status}")
        print(f"        {text[:70]}")

    if failures:
        print(f"\n{failures} line(s) failed to upload.", file=sys.stderr)
        if out_dir:
            print(f"The audio is in {out_dir} — re-run to retry without re-rendering.")
        return 1
    print(f"\nDone. '{args.name}' can now speak {len(lines)} line(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
