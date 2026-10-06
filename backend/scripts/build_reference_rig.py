"""Rebuild the bundled fictional lab portrait's rig; refuse synthetic fallback.

Run from backend: .venv/bin/python scripts/build_reference_rig.py
Uses the existing local MediaPipe model; no database or remote service writes.
"""
import argparse
import json
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

from app.core import config  # noqa: E402

settings = config.Settings(_env_file=None, rig_model_path=str(BACKEND / "models/face_landmarker.task"))
config.get_settings = lambda: settings

from app.services.rig import build_rig, landmarks_from_image  # noqa: E402


def main() -> None:
    assets = BACKEND.parent / "frontend/public/lab/reference"
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", type=Path, default=assets / "portrait.png")
    parser.add_argument("--output", type=Path, default=assets / "rig.json")
    args = parser.parse_args()
    points, blendshapes, size, detected = landmarks_from_image(args.image.read_bytes())
    if not detected:
        raise SystemExit("No detected face: refusing to ship a synthetic reference rig.")
    args.output.write_text(json.dumps(build_rig(points, size, blendshapes), separators=(",", ":")))
    print(f"Built detected reference rig: {len(points)} landmarks, image {size[0]} x {size[1]}.")


if __name__ == "__main__":
    main()
