"""Encode a WAV exactly as the speech cache stores it, and print its type.

For embed/browser-tests/speech-timing.test.ts, which plays what this writes
in real browsers and measures where its sound is: the production encoder
(app.services.tts.speech_codec, at the setting's default level), run alone.
It needs soundfile and numpy and nothing else of the backend, so the embed
CI job installs only those two, at backend/constraints.txt's versions.

    python scripts/encode_speech.py IN.wav OUT    # writes OUT, prints e.g. audio/mpeg
"""

from __future__ import annotations

import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
# This checkout's `app`, whatever else the interpreter has installed.
if str(BACKEND) not in sys.path[:1]:
    sys.path.insert(0, str(BACKEND))

from app.services.tts.speech_codec import encode  # noqa: E402


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    source, target = (Path(arg) for arg in argv)
    audio, mime = encode(source.read_bytes(), "audio/wav")
    target.write_bytes(audio)
    print(mime)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
