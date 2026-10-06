"""The face: its frame in the image, its depth calibrated and smoothed,
the head's pivot, and the change between image and head coordinates."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from app.services.head3d import topology as T
from app.services.head3d.geometry.constants import (
    FACE_WIDTH_M,
    NOSE_PROTRUSION,
    OVAL_SMOOTH_PASSES,
)


@dataclass(frozen=True)
class FaceFrame:
    """Measurements of the rest face, image pixels."""
    width: float       # ear-level landmark to landmark
    height: float      # forehead (10) to chin (152)
    centre_x: float    # between the ear-level landmarks
    ear_y: float       # their mean height
    chin_y: float
    forehead_y: float
    mouth_width: float  # corner to corner
    seam: tuple[float, float]  # between the inner lips
    box: tuple[float, float, float, float]  # bounding box of all landmarks


def face_frame(points: np.ndarray) -> FaceFrame:
    p = np.asarray(points, dtype=np.float64)
    if p.shape != (T.NUM_LANDMARKS, 2):
        raise ValueError("expected 478 landmarks")
    width = float(abs(p[T.EAR_RIGHT, 0] - p[T.EAR_LEFT, 0]))
    height = float(abs(p[T.CHIN, 1] - p[T.FOREHEAD, 1]))
    if width < 2 or height < 2:
        raise ValueError("degenerate face")
    return FaceFrame(
        width=width,
        height=height,
        centre_x=float((p[T.EAR_RIGHT, 0] + p[T.EAR_LEFT, 0]) / 2),
        ear_y=float((p[T.EAR_RIGHT, 1] + p[T.EAR_LEFT, 1]) / 2),
        chin_y=float(p[T.CHIN, 1]),
        forehead_y=float(p[T.FOREHEAD, 1]),
        mouth_width=float(max(np.hypot(*(p[T.MOUTH_RIGHT] - p[T.MOUTH_LEFT])), 1.0)),
        seam=(float((p[13, 0] + p[14, 0]) / 2), float((p[13, 1] + p[14, 1]) / 2)),
        box=(float(p[:, 0].min()), float(p[:, 1].min()), float(p[:, 0].max()), float(p[:, 1].max())),
    )


def calibrate_depth(points: np.ndarray, z: np.ndarray) -> tuple[np.ndarray, float]:
    """MediaPipe z -> relief in image pixels, toward the camera positive, with
    the mid-cheek plane at 0 and the nose tip NOSE_PROTRUSION face widths
    ahead of it. Returns (relief, the scale applied to MediaPipe's z)."""
    frame = face_frame(points)
    z = np.asarray(z, dtype=np.float64)
    cheek = float(np.mean(z[T.CHEEK_LANDMARKS]))
    nose = float(z[T.NOSE_TIP])
    raw = cheek - nose  # MediaPipe: smaller z is nearer, so this is positive on a face
    if raw <= 1e-6:
        raise ValueError("the nose is not ahead of the cheeks: not a frontal face")
    scale = NOSE_PROTRUSION * frame.width / raw
    return (cheek - z) * scale, scale


def smooth_oval_depth(relief: np.ndarray, passes: int = OVAL_SMOOTH_PASSES) -> np.ndarray:
    """Smooth the relief ALONG the face oval (a 1-2-1 pass round the ring,
    `passes` times); the rest of the face keeps its measured depth.

    Along the ring, not over the mesh: the oval is the face's deepest rim
    and every neighbour it has lies forward of it, so a Laplacian pass over
    the mesh pulled the whole rim toward the cheeks (measured: a 5 px noise
    became a 17 px bias) instead of taking the jitter out of it."""
    out = np.array(relief, dtype=np.float64)
    ring = np.array(T.FACE_OVAL)
    for _ in range(passes):
        z = out[ring]
        out[ring] = (np.roll(z, 1) + 2 * z + np.roll(z, -1)) / 4
    return out


def head_pivot(points: np.ndarray, relief: np.ndarray) -> tuple[float, float, float]:
    """The pivot in image space (x, y, relief): between the ear-level
    landmarks, on their depth."""
    p = np.asarray(points, dtype=np.float64)
    ears = [T.EAR_LEFT, T.EAR_RIGHT]
    return (
        float(p[ears, 0].mean()),
        float(p[ears, 1].mean()),
        float(np.asarray(relief)[ears].mean()),
    )


def model_scale(frame: FaceFrame) -> float:
    """Metres per image pixel."""
    return FACE_WIDTH_M / frame.width


def to_model(points: np.ndarray, relief: np.ndarray, pivot: tuple[float, float, float], scale: float) -> np.ndarray:
    """Image (x, y) + relief -> head-frame positions (n, 3)."""
    p = np.asarray(points, dtype=np.float64)
    r = np.asarray(relief, dtype=np.float64)
    return np.column_stack((
        (p[:, 0] - pivot[0]) * scale,
        (pivot[1] - p[:, 1]) * scale,
        (r - pivot[2]) * scale,
    ))


def to_image(positions: np.ndarray, pivot: tuple[float, float, float], scale: float) -> np.ndarray:
    """Head-frame (x, y, *) -> image (x, y)."""
    q = np.asarray(positions, dtype=np.float64)
    return np.column_stack((q[:, 0] / scale + pivot[0], pivot[1] - q[:, 1] / scale))
