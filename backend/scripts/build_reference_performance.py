"""Detect and register the authored reference poses into a shared morph mesh.

No database or service credentials are used. Images remain unmodified; the
manifest records source UVs separately from registered destination landmarks.
Run from the repository root after placing the six poses in the assets folder.
"""
import json
import sys
from pathlib import Path

import numpy as np
from scipy.spatial import Delaunay

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

from app.core import config  # noqa: E402

settings = config.Settings(_env_file=None, rig_model_path=str(BACKEND / "models/face_landmarker.task"))
config.get_settings = lambda: settings

from app.services.rig import landmarks_from_image  # noqa: E402

ASSETS = BACKEND.parent / "frontend/public/lab/reference"
MASTERS = BACKEND.parent / "assets/reference-performance"
POSES = ("rest", "aa", "ee", "oo", "oh", "fv", "th")
# Stable eye corners / nose bridge. Mouth/chin cannot bias registration.
ANCHORS = [33, 133, 362, 263, 168, 6, 197, 195]


def register(source: np.ndarray, target: np.ndarray) -> np.ndarray:
    """Least-squares similarity, including rotation but never shear."""
    a, b = source[ANCHORS], target[ANCHORS]
    ac, bc = a.mean(axis=0), b.mean(axis=0)
    u, singular, vt = np.linalg.svd((a - ac).T @ (b - bc))
    rotation = u @ vt
    if np.linalg.det(rotation) < 0:
        raise ValueError("Mirrored reference pose")
    scale = singular.sum() / np.square(a - ac).sum()
    return (source - ac) @ rotation * scale + bc


def build() -> None:
    neutral = json.loads((ASSETS / "rig.json").read_text())
    size = np.asarray(neutral["image_size"])
    base = np.asarray(neutral["points"]) / size
    outer = np.asarray(neutral["outer_lip_ring"])
    width = float(np.ptp(base[outer, 0]))
    cx = float((base[outer, 0].max() + base[outer, 0].min()) / 2)
    cy = float(base[outer, 1].mean())
    poses = []
    for name in POSES:
        image = "portrait.png" if name == "rest" else f"performance-{name}.png"
        if name == "rest":
            source, destination = base, base
        else:
            points, _, image_size, detected = landmarks_from_image((MASTERS / image).read_bytes())
            if not detected or len(points) != len(base):
                raise ValueError(f"{name}: a complete detected face is required")
            source = np.asarray(points) / np.asarray(image_size)
            destination = register(source, base)
        error = float(np.sqrt(np.square(destination[ANCHORS] - base[ANCHORS]).mean()))
        if error > .007:
            raise ValueError(f"{name}: registration error {error:.4f} exceeds tolerance")
        delivery = image if name == "rest" else f"performance-{name}.webp"
        if not (ASSETS / delivery).exists():
            raise ValueError(f"Missing delivery image: {delivery}")
        poses.append({"id": name, "image": delivery, "source": source.round(7).tolist(),
                      "points": destination.round(7).tolist(), "registration_rms": round(error, 6)})
        gap = float(np.linalg.norm(destination[13] - destination[14]))
        print(f"{name}: detected; registration RMS {error:.5f}; mouth gap {gap / width:.3f} widths")

    # One common topology for all seven UV maps. Neutral Delaunay has extremely
    # thin mouth triangles; use the average open shapes for a stable tessellation.
    mean = np.mean([p["points"] for p in poses], axis=0)
    triangles = Delaunay(mean).simplices
    # Keep the lips and adjacent cheek/chin. The outer contour is a fixed,
    # feathered boundary; eyes/hair/lighting are always from the original photo.
    local = ((base[:, 0] - cx) / (width * 1.12)) ** 2 + ((base[:, 1] - cy) / (width * 1.02)) ** 2
    selected = [t.tolist() for t in triangles if np.min(local[t]) < 1.6]
    manifest = {"version": 1, "character": "lab-reference-v1", "poses": poses,
                "triangles": selected, "center": [cx, cy], "mouth_width": width,
                "inner_ring": neutral["inner_lip_ring"], "outer_ring": neutral["outer_lip_ring"]}
    (ASSETS / "performance.json").write_text(json.dumps(manifest, separators=(",", ":")))
    print(f"Wrote {len(poses)} registered poses; {len(selected)} shared triangles")


if __name__ == "__main__":
    build()
