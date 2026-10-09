"""The skull: fitted round the face oval and the picture's silhouette,
and its mesh (the skirt behind the face, the back of the head)."""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from app.services.head3d import topology as T
from app.services.head3d.geometry.constants import (
    BACK_RINGS,
    CROWN_ABOVE_FOREHEAD,
    HEAD_BACK,
    HEAD_BREADTH,
    SKIRT_BULGE,
    SKIRT_RINGS,
)
from app.services.head3d.geometry.face import FaceFrame
from app.services.head3d.geometry.meshes import (
    Mesh,
    grid_triangles,
    orient_outward,
)


@dataclass(frozen=True)
class SkullFit:
    """A cranium behind the face, head frame. The ellipsoid is centred at the
    pivot (ear level, ear plane): half-width `a_x`, `b_top` up to the crown,
    `b_bottom` down to chin level, `c` back to the occiput. `theta` is each
    oval column's angle about the centre (atan2(y, x), y up), `oval` the 36
    oval landmarks, `equator` where each column meets the ellipsoid's widest
    ring (z = 0), pulled in to the cut-out's silhouette where the picture is
    narrower than the ellipse and pushed out to clear the face edge where
    the ellipse would cut it; `k` is that per-column factor (1 = the
    ellipse), which the back rings share so the whole cranium follows."""

    a_x: float
    b_top: float
    b_bottom: float
    c: float
    theta: np.ndarray
    oval: np.ndarray
    equator: np.ndarray
    k: np.ndarray


#: The equator stays this many face widths inside the silhouette, and at
#: least this far outside the oval landmark (as a factor of its radius).
SILHOUETTE_MARGIN = 0.015
EQUATOR_PAST_OVAL = 1.03


def oval_directions(face: np.ndarray) -> np.ndarray:
    """Each oval column's unit direction from the pivot in the head frame's
    x, y (36, 2) — along which the ellipse's equator point lies."""
    fit = fit_skull(face, _frame_of(face), 1.0, None)
    q = fit.equator[:, :2]
    return q / np.linalg.norm(q, axis=1)[:, None]


def _frame_of(face: np.ndarray) -> FaceFrame:
    """A face frame in the head frame's own units (for direction-only uses)."""
    width = float(abs(face[T.EAR_RIGHT, 0] - face[T.EAR_LEFT, 0]))
    height = float(abs(face[T.CHIN, 1] - face[T.FOREHEAD, 1]))
    return FaceFrame(
        width=width,
        height=height,
        centre_x=0.0,
        ear_y=0.0,
        chin_y=float(-face[T.CHIN, 1]),
        forehead_y=float(-face[T.FOREHEAD, 1]),
        mouth_width=1.0,
        seam=(0.0, 0.0),
        box=(0, 0, 1, 1),
    )


def fit_skull(
    face: np.ndarray,
    frame: FaceFrame,
    scale: float,
    hair_top_y: float | None,
    silhouette: np.ndarray | None = None,
) -> SkullFit:
    """Fit the cranium to the face (head-frame positions (478, 3)).

    `hair_top_y` is the cut-out's topmost opaque row at the head's centre,
    image px, or None for an opaque picture; the crown reaches it within
    CROWN_ABOVE_FOREHEAD of the forehead landmark. `silhouette` is how far
    the cut-out reaches from the pivot along each oval column's equator
    direction (36, head units; texture.silhouette_reach), or None: the
    equator never leaves the picture, so the cranium wears the picture's
    own outline rather than a generic ellipse poking out beside it."""
    half_width = frame.width * scale / 2
    forehead = float(face[T.FOREHEAD, 1])
    face_h = frame.height * scale
    low, high = (forehead + k * face_h for k in CROWN_ABOVE_FOREHEAD)
    # The hair's top, from image y to head y; without one, 0.4 face heights.
    crown = forehead + 0.4 * face_h if hair_top_y is None else (frame.ear_y - hair_top_y) * scale
    b_top = float(np.clip(crown, low, high))
    b_bottom = float(max(-face[T.CHIN, 1], 0.3 * face_h))
    a_x = HEAD_BREADTH * half_width
    c = HEAD_BACK * half_width
    oval = face[T.FACE_OVAL]
    theta = np.arctan2(oval[:, 1], oval[:, 0])
    b = np.where(np.sin(theta) >= 0, b_top, b_bottom)
    ellipse = np.column_stack((a_x * np.cos(theta), b * np.sin(theta)))
    radius = np.linalg.norm(ellipse, axis=1)
    direction = ellipse / radius[:, None]
    # The equator always clears the face edge (the generic ellipse can fall
    # inside a wide jaw's oval on the diagonals), and never leaves the
    # silhouette where one is known.
    floor = np.einsum("ij,ij->i", oval[:, :2], direction) * EQUATOR_PAST_OVAL
    k = np.ones(len(theta))
    if silhouette is not None:
        reach = np.asarray(silhouette, dtype=np.float64) - SILHOUETTE_MARGIN * frame.width * scale
        k = np.minimum(1.0, reach / radius)
    k = np.maximum(k, floor / radius)
    equator = np.column_stack((ellipse * k[:, None], np.zeros(len(theta))))
    return SkullFit(
        a_x=a_x, b_top=b_top, b_bottom=b_bottom, c=c, theta=theta, oval=oval, equator=equator, k=k
    )


@dataclass
class SkullMesh(Mesh):
    """The skull with, per vertex, its oval column (-1 for the pole) and its
    surface parameter s (0 at the face edge, SKIRT_RINGS/(rings) at the
    equator, 1 at the back pole) — what the texture and the morph share key on."""

    column: np.ndarray
    s: np.ndarray
    skirt_share: np.ndarray


def skirt_ring(fit: SkullFit, t: float) -> np.ndarray:
    """The skirt's ring at `t` (0 the oval landmarks, 1 the equator): the
    chord between them, bulged outward so the skull is convex. (36, 3)."""
    n_cols = len(fit.theta)
    chord = fit.equator - fit.oval
    bulge = SKIRT_BULGE * np.linalg.norm(chord, axis=1) * math.sin(math.pi * t)
    outward = np.column_stack((np.cos(fit.theta), np.sin(fit.theta), np.zeros(n_cols)))
    return fit.oval + chord * t + outward * bulge[:, None]


def back_ring(fit: SkullFit, psi: float) -> np.ndarray:
    """The cranium's ring `psi` radians behind the equator (pi/2 the pole),
    narrowed per column as the equator was. (36, 3)."""
    n_cols = len(fit.theta)
    b = np.where(np.sin(fit.theta) >= 0, fit.b_top, fit.b_bottom)
    return np.column_stack(
        (
            fit.k * fit.a_x * math.cos(psi) * np.cos(fit.theta),
            fit.k * b * math.cos(psi) * np.sin(fit.theta),
            np.full(n_cols, -fit.c * math.sin(psi)),
        )
    )


def skull_mesh(fit: SkullFit) -> SkullMesh:
    """Rings of 36 columns + a wrap column: SKIRT_RINGS+1 rings from the oval
    landmarks to the equator (a bulged chord), BACK_RINGS-1 rings around the
    back, and the pole."""
    n_cols = len(fit.theta)
    rings = SKIRT_RINGS + BACK_RINGS  # ring rows before the pole
    positions, uvs, column, s_param, share = [], [], [], [], []
    for r in range(rings):
        if r <= SKIRT_RINGS:
            t = r / SKIRT_RINGS
            ring = skirt_ring(fit, t)
            ring_share = (1 - t) ** 1.5
        else:
            ring = back_ring(fit, (r - SKIRT_RINGS) / BACK_RINGS * (math.pi / 2))
            ring_share = 0.0
        s = r / rings
        for i in range(n_cols + 1):  # the wrap column repeats column 0
            k = i % n_cols
            positions.append(ring[k])
            uvs.append((i / n_cols, s))
            column.append(k)
            s_param.append(s)
            share.append(ring_share)
    pole_index = len(positions)
    positions.append((0.0, 0.0, -fit.c))
    uvs.append((0.5, 1.0))
    column.append(-1)
    s_param.append(1.0)
    share.append(0.0)
    tris = list(grid_triangles(rings, n_cols + 1, wrap=False))
    last = (rings - 1) * (n_cols + 1)
    for i in range(n_cols):
        tris.append((last + i, last + i + 1, pole_index))
    P = np.array(positions)
    tri = orient_outward(P, np.array(tris), np.array((0.0, 0.0, -0.4 * fit.c)))
    return SkullMesh(
        positions=P,
        uvs=np.array(uvs),
        triangles=tri,
        column=np.array(column, dtype=np.int32),
        s=np.array(s_param),
        skirt_share=np.array(share),
    )
