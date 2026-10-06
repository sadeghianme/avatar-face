"""2a. Registration on stable anchors, shared with
scripts/build_reference_performance.py; the Reference's own motion; and the
manifest frame every kit is measured in."""

from __future__ import annotations

import json
import math
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from app.services.performance_kit.constants import (
    FACE_LEFT,
    FACE_RIGHT,
    MOUTH_LEFT,
    MOUTH_RIGHT,
    POSES,
    REFERENCE_CHARACTER,
    SHAPES,
)

# --- 2a. Registration, shared with scripts/build_reference_performance.py ------------

# Stable eye corners and nose bridge. The mouth and chin cannot bias the
# registration, because they are what each pose changes.
ANCHORS = [33, 133, 362, 263, 168, 6, 197, 195]
# RMS of the anchors after registration, in manifest units. The Reference's
# gate: its six poses registered between 0.0004 and 0.0019.
MAX_REGISTRATION_RMS = 0.007


class MirroredPose(ValueError):
    """The best rotation onto the anchors is a reflection: not the same face."""


@dataclass(frozen=True)
class Similarity:
    """A least-squares similarity onto anchors: rotation, scale, and the two
    centroids it maps between. Row vectors: p' = (p - source_centre) @
    rotation * scale + target_centre."""

    rotation: np.ndarray
    scale: float
    source_centre: np.ndarray
    target_centre: np.ndarray

    @property
    def degrees(self) -> float:
        return math.degrees(math.atan2(self.rotation[0, 1], self.rotation[0, 0]))

    def apply(self, points: np.ndarray) -> np.ndarray:
        # Exactly the Reference builder's arithmetic, in the same order: the
        # Reference manifest is rebuilt byte for byte from this.
        return (points - self.source_centre) @ self.rotation * self.scale + self.target_centre


def similarity_on_anchors(
    source: np.ndarray, target: np.ndarray, anchors: Sequence[int] = ANCHORS
) -> Similarity:
    """Least-squares similarity from `source` onto `target` over `anchors`,
    including rotation but never shear. Raises MirroredPose on a reflection."""
    a, b = source[anchors], target[anchors]
    ac, bc = a.mean(axis=0), b.mean(axis=0)
    u, singular, vt = np.linalg.svd((a - ac).T @ (b - bc))
    rotation = u @ vt
    if np.linalg.det(rotation) < 0:
        raise MirroredPose("Mirrored reference pose")
    scale = singular.sum() / np.square(a - ac).sum()
    return Similarity(rotation, float(scale), ac, bc)


def register(source: np.ndarray, target: np.ndarray, anchors: Sequence[int] = ANCHORS) -> np.ndarray:
    """Every point of `source`, carried onto `target` by the anchors' similarity."""
    return similarity_on_anchors(source, target, anchors).apply(source)


def registration_rms(
    registered: np.ndarray, target: np.ndarray, anchors: Sequence[int] = ANCHORS
) -> float:
    return float(np.sqrt(np.square(registered[anchors] - target[anchors]).mean()))


def mouth_frame(base: np.ndarray, outer: Sequence[int]) -> tuple[float, float, float]:
    """(mouth width, centre x, centre y) as the manifest records them: the
    outer ring's horizontal extent, its middle, and its mean height."""
    width = float(np.ptp(base[outer, 0]))
    cx = float((base[outer, 0].max() + base[outer, 0].min()) / 2)
    cy = float(base[outer, 1].mean())
    return width, cx, cy


def shared_triangles(
    pose_points: Sequence, base: np.ndarray, center: tuple[float, float], width: float
) -> list[list[int]]:
    """One topology for every pose: Delaunay of the mean pose (the neutral
    one has extremely thin mouth triangles), kept to the lips and the cheek
    and chin next to them."""
    from scipy.spatial import Delaunay

    cx, cy = center
    mean = np.mean(pose_points, axis=0)
    triangles = Delaunay(mean).simplices
    local = ((base[:, 0] - cx) / (width * 1.12)) ** 2 + ((base[:, 1] - cy) / (width * 1.02)) ** 2
    return [t.tolist() for t in triangles if np.min(local[t]) < 1.6]


# --- The Reference ----------------------------------------------------------------------


@dataclass(frozen=True)
class ReferenceMotion:
    """The Reference's manifest, as the retarget and the fit read it."""

    rest: np.ndarray
    poses: dict[str, np.ndarray]

    @property
    def face_width(self) -> float:
        return float(np.linalg.norm(self.rest[FACE_RIGHT] - self.rest[FACE_LEFT]))

    @property
    def corner_mid(self) -> np.ndarray:
        return (self.rest[MOUTH_LEFT] + self.rest[MOUTH_RIGHT]) / 2

    @classmethod
    def from_manifest(cls, manifest: dict) -> ReferenceMotion:
        if manifest.get("version") != 1 or manifest.get("character") != REFERENCE_CHARACTER:
            raise ValueError("not the Reference's motion manifest")
        poses = {p["id"]: np.asarray(p["points"], dtype=np.float64) for p in manifest["poses"]}
        if tuple(poses) != POSES or any(p.shape != (478, 2) for p in poses.values()):
            raise ValueError("the Reference manifest is incomplete")
        return cls(rest=poses["rest"], poses={s: poses[s] for s in SHAPES})


def _reference_paths() -> list[Path]:
    # Development: the embed's bundled copy. The API image: the built widget
    # directory, where /mouth-motion.json is served from (see app.main).
    # The repository root (the image's /): this file is
    # backend/app/services/performance_kit/registration.py.
    root = Path(__file__).resolve().parents[4]
    return [root / "embed" / "assets" / "mouth-motion.json",
            root / "embed" / "dist" / "mouth-motion.json"]


def load_reference(path: Path | None = None) -> ReferenceMotion:
    """The bundled Reference motion (mouth-motion.json)."""
    for candidate in [path] if path else _reference_paths():
        if candidate.exists():
            return ReferenceMotion.from_manifest(json.loads(candidate.read_text()))
    raise FileNotFoundError("mouth-motion.json not found")


# --- Frame ---------------------------------------------------------------------------------


def _level(theta: float) -> np.ndarray:
    """R(-theta) for column vectors: turns a line at `theta` horizontal."""
    c, s = math.cos(theta), math.sin(theta)
    return np.array([[c, s], [-s, c]])


def _corner_angle(points: np.ndarray) -> float:
    d = points[MOUTH_RIGHT] - points[MOUTH_LEFT]
    return math.atan2(float(d[1]), float(d[0]))


@dataclass(frozen=True)
class ManifestFrame:
    """Base-photo pixels to manifest units (see the module docstring)."""

    matrix: np.ndarray  # 2x3
    image_size: tuple[int, int]

    @property
    def units_per_px(self) -> float:
        return math.sqrt(abs(float(np.linalg.det(self.matrix[:, :2]))))

    def apply(self, points: np.ndarray) -> np.ndarray:
        return np.asarray(points, dtype=np.float64) @ self.matrix[:, :2].T + self.matrix[:, 2]

    @classmethod
    def from_base(
        cls, base_points: np.ndarray, image_size: tuple[int, int], reference: ReferenceMotion
    ) -> ManifestFrame:
        face = float(np.linalg.norm(base_points[FACE_RIGHT] - base_points[FACE_LEFT]))
        if face <= 0:
            raise ValueError("the base face has no width")
        linear = reference.face_width / face * _level(_corner_angle(base_points))
        middle = (base_points[MOUTH_LEFT] + base_points[MOUTH_RIGHT]) / 2
        offset = reference.corner_mid - linear @ middle
        return cls(np.hstack((linear, offset[:, None])), (int(image_size[0]), int(image_size[1])))
