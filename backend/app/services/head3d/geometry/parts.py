"""The parts beside the face: the neck, the hair and body cards, and the
mouth interior (teeth, tongue, cavity)."""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from app.services.head3d import topology as T
from app.services.head3d.geometry.constants import (
    CAVITY,
    HEAD_BOX_ABOVE,
    HEAD_BOX_BELOW,
    HEAD_BOX_SIDE,
    LOWER_TEETH,
    LOWER_TEETH_JAW_SHARE,
    NECK_BEHIND_CARD,
    NECK_LENGTH,
    NECK_RADIUS,
    NECK_SEGMENTS,
    TEETH_ARCH_DEPTH,
    TEETH_WIDTH,
    TONGUE,
    TONGUE_JAW_SHARE,
    TONGUE_UNDER_SKIN,
    UPPER_TEETH,
    smoothstep,
)
from app.services.head3d.geometry.face import FaceFrame, to_model
from app.services.head3d.geometry.meshes import (
    Mesh,
    grid_triangles,
    orient_outward,
)

# --- The neck -----------------------------------------------------------------


def neck_mesh(face: np.ndarray, frame: FaceFrame, scale: float, card_z: float) -> Mesh:
    """A cylinder under the head, its front NECK_BEHIND_CARD face widths
    behind the hair card at `card_z`, from inside the skull to NECK_LENGTH
    below the chin. UV u runs around it with the front at 0.5, v down it."""
    face_w = frame.width * scale
    radius = NECK_RADIUS * face_w
    axis_z = card_z - NECK_BEHIND_CARD * face_w - radius
    face_h = frame.height * scale
    top = float(face[T.CHIN, 1]) + 0.12 * face_h
    bottom = float(face[T.CHIN, 1]) - NECK_LENGTH * face_h
    rows = 4
    positions, uvs = [], []
    for r in range(rows):
        y = top + (bottom - top) * r / (rows - 1)
        for i in range(NECK_SEGMENTS + 1):
            u = i / NECK_SEGMENTS
            angle = (u - 0.5) * 2 * math.pi  # u = 0.5 faces the camera
            positions.append((radius * math.sin(angle), y, axis_z + radius * math.cos(angle)))
            uvs.append((u, r / (rows - 1)))
    P = np.array(positions)
    tri = orient_outward(P, grid_triangles(rows, NECK_SEGMENTS + 1), np.array((0.0, (top + bottom) / 2, axis_z)))
    return Mesh(positions=P, uvs=np.array(uvs), triangles=tri)


# --- Cards --------------------------------------------------------------------


def head_box(frame: FaceFrame, image_size: tuple[int, int]) -> tuple[float, float, float, float]:
    """The 2D engine's head layer box (image px): the face box grown by
    HEAD_BOX_* shares, clipped to the picture."""
    x0, y0, x1, y1 = frame.box
    fw, fh = x1 - x0, y1 - y0
    w, h = image_size
    return (
        max(0.0, x0 - fw * HEAD_BOX_SIDE), max(0.0, y0 - fh * HEAD_BOX_ABOVE),
        min(float(w), x1 + fw * HEAD_BOX_SIDE), min(float(h), y1 + fh * HEAD_BOX_BELOW),
    )


def card_mesh(box: tuple[float, float, float, float], z: float, pivot: tuple[float, float, float], scale: float) -> Mesh:
    """A quad over an image box at depth `z` (head frame), UVs over the box."""
    x0, y0, x1, y1 = box
    corners = np.array([(x0, y0), (x1, y0), (x1, y1), (x0, y1)], dtype=np.float64)
    positions = to_model(corners, np.zeros(4), pivot, scale)
    positions[:, 2] = z
    uvs = np.array([(0, 0), (1, 0), (1, 1), (0, 1)], dtype=np.float64)
    tris = np.array([(0, 2, 1), (0, 3, 2)])  # counter-clockwise seen from +z
    return Mesh(positions=positions, uvs=uvs, triangles=tris)


# --- The mouth interior -------------------------------------------------------


@dataclass
class InteriorPart:
    name: str
    mesh: Mesh
    #: Share of the chin's jaw drop every vertex of the part takes.
    jaw_share: float
    #: For a part that hugs the skin (the cavity backdrop): where each vertex
    #: sits on the face, so every face target carries it along. None for a
    #: part fixed to the skull (teeth) or hung from the jaw (tongue).
    skin: tuple[np.ndarray, np.ndarray] | None = None


def mouth_frame(face: np.ndarray) -> tuple[np.ndarray, float]:
    """(seam position, mouth width) in the head frame."""
    seam = (face[T.UPPER_INNER_LIP] + face[T.LOWER_INNER_LIP]) / 2
    width = float(max(np.linalg.norm(face[T.MOUTH_RIGHT] - face[T.MOUTH_LEFT]), 1e-6))
    return seam, width


def surface_weights(face: np.ndarray, xy: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Where each (x, y) sits on the face: three vertex indices and their
    barycentric weights (n, 3), from the canonical triangle under the point,
    or the nearest vertex alone outside them (and inside the mouth hole)."""
    p = np.asarray(face, dtype=np.float64)
    q = np.asarray(xy, dtype=np.float64).reshape(-1, 2)
    tris = T.face_triangles().astype(np.int64)
    a, b, c = p[tris[:, 0], :2], p[tris[:, 1], :2], p[tris[:, 2], :2]
    det = (b[:, 0] - a[:, 0]) * (c[:, 1] - a[:, 1]) - (c[:, 0] - a[:, 0]) * (b[:, 1] - a[:, 1])
    ok = np.abs(det) > 1e-12
    safe = np.where(ok, det, 1)
    indices = np.zeros((len(q), 3), dtype=np.int64)
    weights = np.zeros((len(q), 3))
    for k, (x, y) in enumerate(q):
        l1 = ((b[:, 0] - x) * (c[:, 1] - y) - (c[:, 0] - x) * (b[:, 1] - y)) / safe
        l2 = ((c[:, 0] - x) * (a[:, 1] - y) - (a[:, 0] - x) * (c[:, 1] - y)) / safe
        l3 = 1 - l1 - l2
        hits = np.flatnonzero(ok & (l1 >= -1e-6) & (l2 >= -1e-6) & (l3 >= -1e-6))
        if len(hits):
            t = hits[0]
            indices[k] = tris[t]
            weights[k] = (l1[t], l2[t], l3[t])
        else:
            nearest = int(np.argmin(np.hypot(p[:T.NUM_MESH_VERTICES, 0] - x, p[:T.NUM_MESH_VERTICES, 1] - y)))
            indices[k] = nearest
            weights[k] = (1.0, 0.0, 0.0)
    return indices, weights


def surface_depth(face: np.ndarray, xy: np.ndarray) -> np.ndarray:
    """The face surface's z at each (x, y)."""
    indices, weights = surface_weights(face, xy)
    return np.einsum("ij,ij->i", np.asarray(face, dtype=np.float64)[indices][..., 2], weights)


def surface_delta(delta: np.ndarray, indices: np.ndarray, weights: np.ndarray) -> np.ndarray:
    """A face target's delta carried to points on the surface (n, 3)."""
    return np.einsum("ijk,ij->ik", np.asarray(delta, dtype=np.float64)[indices], weights)


def _shell(face: np.ndarray, xy: np.ndarray, behind: np.ndarray | float) -> np.ndarray:
    """Positions (n, 3) on the face surface at `xy`, set `behind` it."""
    xy = np.asarray(xy, dtype=np.float64).reshape(-1, 2)
    return np.column_stack((xy, surface_depth(face, xy) - np.asarray(behind, dtype=np.float64)))


def _teeth_arch(face: np.ndarray, seam: np.ndarray, width: float, spec: dict[str, float], columns: int = 7) -> Mesh:
    """A row of teeth: a strip `columns` wide on the face's own depth, a
    little behind it, bending back a touch more toward the corners. UV u
    left to right, v top to bottom."""
    xy, behind, uvs = [], [], []
    for yv, v in ((spec["top"], 0.0), (spec["bottom"], 1.0)):
        for c in range(columns):
            u = c / (columns - 1)
            xy.append((seam[0] + (u - 0.5) * TEETH_WIDTH * width, seam[1] + yv * width))
            behind.append((spec["behind"] + TEETH_ARCH_DEPTH * (2 * abs(u - 0.5)) ** 2) * width)
            uvs.append((u, v))
    P = _shell(face, np.array(xy), np.array(behind))
    tris = orient_outward(P, grid_triangles(2, columns), seam + np.array((0, 0, -width)))
    return Mesh(positions=P, uvs=np.array(uvs), triangles=tris)


def _cavity(face: np.ndarray, seam: np.ndarray, width: float, columns: int = 7, rows: int = 5) -> InteriorPart:
    """The dark backdrop: a grid on the face's depth, CAVITY["behind"] widths
    behind it above the seam and CAVITY["behind_low"] below, where the
    lower lip travels back as the jaw opens. It hugs the skin: every face
    target carries it, so a pucker that slides the curved corner skin over
    it cannot bring the skin behind it. UV v top to bottom."""
    xy, behind, uvs = [], [], []
    for r in range(rows):
        v = r / (rows - 1)
        y = CAVITY["top"] + (CAVITY["bottom"] - CAVITY["top"]) * v
        depth = CAVITY["behind"] + (CAVITY["behind_low"] - CAVITY["behind"]) * float(smoothstep(-y / 0.25))
        for c in range(columns):
            u = c / (columns - 1)
            xy.append((seam[0] + (u - 0.5) * CAVITY["width"] * width, seam[1] + y * width))
            behind.append(depth * width)
            uvs.append((u, v))
    grid = np.array(xy)
    P = _shell(face, grid, np.array(behind))
    tris = orient_outward(P, grid_triangles(rows, columns), seam + np.array((0, 0, -width)))
    return InteriorPart("Cavity", Mesh(positions=P, uvs=np.array(uvs), triangles=tris), jaw_share=0.0,
                        skin=surface_weights(face, grid))


def _ellipsoid(centre: np.ndarray, radii: np.ndarray, lat: int = 6, lon: int = 12) -> Mesh:
    positions, uvs = [], []
    for i in range(lat + 1):
        phi = math.pi * i / lat
        for j in range(lon + 1):
            lam = 2 * math.pi * j / lon
            n = np.array((math.sin(phi) * math.cos(lam), math.cos(phi), math.sin(phi) * math.sin(lam)))
            positions.append(centre + n * radii)
            uvs.append((j / lon, i / lat))
    P = np.array(positions)
    tris = orient_outward(P, grid_triangles(lat + 1, lon + 1), centre)
    return Mesh(positions=P, uvs=np.array(uvs), triangles=tris)


def mouth_interior(face: np.ndarray, teeth: str, tongue: bool) -> list[InteriorPart]:
    """The interior behind the lips: a dark cavity backdrop, the teeth rows
    the look wears ("both", "upper", "none"), and a tongue, each a shell on
    the face's own depth. Positions in the head frame, sized by the mouth
    width."""
    if teeth not in ("both", "upper", "none"):
        raise ValueError(f"unknown teeth {teeth!r}")
    seam, width = mouth_frame(face)
    parts: list[InteriorPart] = [_cavity(face, seam, width)]
    if teeth in ("both", "upper"):
        parts.append(InteriorPart("TeethUpper", _teeth_arch(face, seam, width, UPPER_TEETH), jaw_share=0.0))
    if teeth == "both":
        parts.append(InteriorPart("TeethLower", _teeth_arch(face, seam, width, LOWER_TEETH), jaw_share=LOWER_TEETH_JAW_SHARE))
    if tongue:
        cx, cy, cz = TONGUE["centre"]
        xy = np.array([[seam[0] + cx * width, seam[1] + cy * width]])
        centre = _shell(face, xy, -cz * width)[0]
        blob = _ellipsoid(centre, np.array(TONGUE["radii"]) * width)
        # It lies on the floor of the mouth: nowhere nearer the camera than
        # the skin over it (the chin crease comes back behind its centre).
        floor = surface_depth(face, blob.positions[:, :2]) - TONGUE_UNDER_SKIN * width
        blob.positions[:, 2] = np.minimum(blob.positions[:, 2].astype(np.float64), floor)
        parts.append(InteriorPart("Tongue", blob, jaw_share=TONGUE_JAW_SHARE))
    return parts
