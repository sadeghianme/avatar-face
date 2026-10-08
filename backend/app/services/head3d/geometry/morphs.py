"""Morph targets: the face's targets from the 2D rig's, split by side,
carried onto the skirt and the mouth interior; and the camera framing."""

from __future__ import annotations

import numpy as np

from app.services.head3d import topology as T
from app.services.head3d.geometry.constants import (
    CORNER_RECESS,
    JAW_BACK,
    LIP_PROTRUSION,
    SIDE_BLEND,
    smoothstep,
)
from app.services.head3d.geometry.face import FaceFrame
from app.services.head3d.geometry.parts import InteriorPart, surface_delta
from app.services.head3d.geometry.skull import SkullMesh


def side_weights(points: np.ndarray, frame: FaceFrame) -> np.ndarray:
    """How much of a symmetric target each landmark gives to the ARKit LEFT
    target (the subject's left: image right), 0..1, crossing over smoothly
    about the face's centre line. Left + right = the whole delta."""
    p = np.asarray(points, dtype=np.float64)
    x = (p[:, 0] - frame.centre_x) / (SIDE_BLEND * frame.mouth_width)
    return np.asarray(smoothstep(x + 0.5))


def lip_forward_weights(points: np.ndarray, frame: FaceFrame) -> np.ndarray:
    """Where a pucker pushes forward: 1 on the lip rows at the centre, fading
    toward the corners, 0.5 at the corners, and a smooth falloff over the
    skin to 0.35 mouth widths from the seam."""
    p = np.asarray(points, dtype=np.float64)
    sx, sy = frame.seam
    w = frame.mouth_width
    nx = np.abs(p[:, 0] - sx) / (w / 2)
    dist = np.hypot(p[:, 0] - sx, (p[:, 1] - sy) * 1.35) / w
    out = np.asarray(1 - smoothstep(dist / 0.35)) * 0.4
    for i in T.LIP_VERTICES:
        out[i] = 1.0 - 0.6 * min(1.0, nx[i]) ** 2
    for i in T.LIP_CORNERS:
        out[i] = 0.5
    return out


def morph_delta(
    name: str, dx: np.ndarray, dy: np.ndarray, points: np.ndarray, frame: FaceFrame, scale: float
) -> np.ndarray:
    """A symmetric target's head-frame delta (478, 3) from the baked image-px
    deltas per unit weight, with z from the rules above."""
    dx = np.asarray(dx, dtype=np.float64)
    dy = np.asarray(dy, dtype=np.float64)
    out = np.column_stack((dx * scale, -dy * scale, np.zeros(len(dx))))
    if name == "jawOpen":
        out[:, 2] = -JAW_BACK * np.maximum(0.0, -out[:, 1])
    elif name in LIP_PROTRUSION:
        out[:, 2] = (
            LIP_PROTRUSION[name] * frame.mouth_width * scale * lip_forward_weights(points, frame)
        )
    elif name in ("mouthStretch", "mouthSmile"):
        out[:, 2] = -CORNER_RECESS * np.abs(out[:, 0])
    return out


def viseme_delta(
    dx: np.ndarray,
    dy: np.ndarray,
    weights: dict[str, float],
    points: np.ndarray,
    frame: FaceFrame,
    scale: float,
) -> np.ndarray:
    """A whole viseme shape's head-frame delta (478, 3) from its baked
    image-px deltas, with z from the same rules as the symmetric targets,
    weighted by the viseme's own table weights."""
    dx = np.asarray(dx, dtype=np.float64)
    dy = np.asarray(dy, dtype=np.float64)
    out = np.column_stack((dx * scale, -dy * scale, np.zeros(len(dx))))
    out[:, 2] = -JAW_BACK * np.maximum(0.0, -out[:, 1])
    forward = sum(LIP_PROTRUSION[k] * weights.get(k, 0.0) for k in LIP_PROTRUSION)
    if forward > 0:
        out[:, 2] += forward * frame.mouth_width * scale * lip_forward_weights(points, frame)
    spread = min(1.0, weights.get("mouthStretch", 0.0) + weights.get("mouthSmile", 0.0))
    if spread > 0:
        out[:, 2] -= CORNER_RECESS * spread * np.abs(out[:, 0])
    return out


def split_sides(delta: np.ndarray, left_weight: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """(left, right) halves of a symmetric delta; they sum to the whole."""
    w = np.asarray(left_weight)[:, None]
    return delta * w, delta * (1 - w)


def skirt_morph(skull: SkullMesh, face_delta: np.ndarray) -> np.ndarray:
    """The skull's delta for a face target: each skirt vertex follows its
    oval landmark by its share (1 at the face edge, 0 at the equator)."""
    out = np.zeros((len(skull.positions), 3))
    oval = np.array(T.FACE_OVAL)
    mask = skull.column >= 0
    out[mask] = face_delta[oval[skull.column[mask]]] * skull.skirt_share[mask][:, None]
    return out


def interior_morphs(
    part: InteriorPart, face_targets: dict[str, np.ndarray]
) -> list[tuple[str, np.ndarray]]:
    """A mouth part's morph targets: a skin-hugging part takes every face
    target at its own points; a jaw-hung part takes the chin's jawOpen by
    its share; a skull-fixed part none."""
    if part.skin is not None:
        indices, weights = part.skin
        return [
            (name, surface_delta(delta, indices, weights)) for name, delta in face_targets.items()
        ]
    if part.jaw_share > 0:
        chin = np.asarray(face_targets["jawOpen"][T.CHIN], dtype=np.float64) * part.jaw_share
        return [("jawOpen", np.tile(chin, (len(part.mesh.positions), 1)))]
    return []


#: The view: this many face heights tall, centred this far above the face's
#: middle (hair takes more room than a chin) — about the 2D engine's face
#: framing, so the two can be compared.
FRAME_HEIGHTS = 2.0
FRAME_LIFT = 0.12


def frame_box(
    face: np.ndarray, frame: FaceFrame, scale: float
) -> tuple[tuple[float, float, float], float]:
    """Where a camera should look and how tall the view is, head frame."""
    face_h = frame.height * scale
    middle = (float(face[T.FOREHEAD, 1]) + float(face[T.CHIN, 1])) / 2
    centre = (
        float(face[:, 0].mean()),
        middle + FRAME_LIFT * face_h,
        float(face[T.NOSE_TIP, 2]) / 2,
    )
    return centre, FRAME_HEIGHTS * face_h
