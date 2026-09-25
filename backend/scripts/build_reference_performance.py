"""Detect and register the authored reference poses into a shared morph mesh.

No database or service credentials are used. Images remain unmodified; the
manifest records source UVs separately from registered destination landmarks.
Run from the repository root after placing the six poses in the assets folder.

The registration, the mouth frame and the shared topology live in
app.services.performance_kit, which builds the same kind of manifest for
every avatar from its own photo; this script is their first user and must
keep writing the identical performance.json (tests/test_performance_kit.py
rebuilds it from recorded detections and compares the bytes).
"""
import json
import sys
from collections.abc import Callable
from pathlib import Path

import numpy as np

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

from app.services.performance_kit import (  # noqa: E402
    ANCHORS,
    MAX_REGISTRATION_RMS,
    mouth_frame,
    register,
    registration_rms,
    shared_triangles,
)

ASSETS = BACKEND.parent / "frontend/public/lab/reference"
MASTERS = BACKEND.parent / "assets/reference-performance"
POSES = ("rest", "aa", "ee", "oo", "oh", "fv", "th")

__all__ = ["ANCHORS", "POSES", "build", "build_manifest", "register"]


def build_manifest(detect: Callable[[str], np.ndarray]) -> dict:
    """The Reference manifest. `detect(image_name)` returns the pose master's
    478 landmarks as fractions of its size, and raises when there is no
    complete detected face."""
    neutral = json.loads((ASSETS / "rig.json").read_text())
    size = np.asarray(neutral["image_size"])
    base = np.asarray(neutral["points"]) / size
    outer = np.asarray(neutral["outer_lip_ring"])
    width, cx, cy = mouth_frame(base, outer)
    poses = []
    for name in POSES:
        image = "portrait.png" if name == "rest" else f"performance-{name}.png"
        if name == "rest":
            source, destination = base, base
        else:
            source = detect(image)
            if len(source) != len(base):
                raise ValueError(f"{name}: a complete detected face is required")
            destination = register(source, base)
        error = registration_rms(destination, base)
        if error > MAX_REGISTRATION_RMS:
            raise ValueError(f"{name}: registration error {error:.4f} exceeds tolerance")
        delivery = image if name == "rest" else f"performance-{name}.webp"
        if not (ASSETS / delivery).exists():
            raise ValueError(f"Missing delivery image: {delivery}")
        poses.append({"id": name, "image": delivery, "source": source.round(7).tolist(),
                      "points": destination.round(7).tolist(), "registration_rms": round(error, 6)})
        gap = float(np.linalg.norm(destination[13] - destination[14]))
        print(f"{name}: detected; registration RMS {error:.5f}; mouth gap {gap / width:.3f} widths")

    # One common topology for all seven UV maps. The outer contour is a fixed,
    # feathered boundary; eyes/hair/lighting are always from the original photo.
    selected = shared_triangles([p["points"] for p in poses], base, (cx, cy), width)
    return {"version": 1, "character": "lab-reference-v1", "poses": poses,
            "triangles": selected, "center": [cx, cy], "mouth_width": width,
            "inner_ring": neutral["inner_lip_ring"], "outer_ring": neutral["outer_lip_ring"]}


def _mediapipe_detect() -> Callable[[str], np.ndarray]:
    # The model path is forced here, not at import: importing this module
    # (as the rebuild test does) must not replace the app's settings.
    from app.core import config

    settings = config.Settings(_env_file=None, rig_model_path=str(BACKEND / "models/face_landmarker.task"))
    config.get_settings = lambda: settings

    from app.services.rig import landmarks_from_image

    def detect(image: str) -> np.ndarray:
        points, _, image_size, detected = landmarks_from_image((MASTERS / image).read_bytes())
        if not detected:
            raise ValueError(f"{image}: a complete detected face is required")
        return np.asarray(points) / np.asarray(image_size)

    return detect


def build() -> None:
    manifest = build_manifest(_mediapipe_detect())
    (ASSETS / "performance.json").write_text(json.dumps(manifest, separators=(",", ":")))
    print(f"Wrote {len(manifest['poses'])} registered poses; {len(manifest['triangles'])} shared triangles")


if __name__ == "__main__":
    build()
