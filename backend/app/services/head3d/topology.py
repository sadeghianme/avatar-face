"""The face mesh every head shares: MediaPipe's canonical 468-point topology.

Vendored from the face landmarker's own bundle by
scripts/extract_canonical_face_mesh.py (898 triangles, the FACEMESH
tessellation, with the canonical UVs and 3D shape). The rig's Delaunay
triangles differ per face; one fixed topology means every head's buffers
line up, so a morph target or a tool written for one head fits all.

The canonical mesh closes the eyes and the mouth with triangles (its one
boundary loop is the face oval). The mouth fill is removed here so the lips
can part over the interior; the eyes stay closed, as in the 2D engine, where
a blink moves the lid vertices over the eye texture.

Landmarks 468..477 (the irises) have no triangles of their own; they are
kept as vertices so morph deltas keep the 2D engine's indexing.
"""
from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

import numpy as np

from app.services.rig import INNER_LIP_RING, OUTER_LIP_RING

MESH_PATH = Path(__file__).with_name("canonical_face_mesh.json")

NUM_LANDMARKS = 478
NUM_MESH_VERTICES = 468

# MediaPipe's face oval, from the forehead clockwise in the image (the same
# order the 2D engine's jaw rig walks it).
# fmt: off
FACE_OVAL = [
    10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377,
    152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109,
]
# fmt: on
# The lip rows, corner to corner, inner row first (jaw-rig.ts).
UPPER_LIP_ROWS = [
    [191, 80, 81, 82, 13, 312, 311, 310, 415],
    [183, 42, 41, 38, 12, 268, 271, 272, 407],
    [184, 74, 73, 72, 11, 302, 303, 304, 408],
    [185, 40, 39, 37, 0, 267, 269, 270, 409],
]
LOWER_LIP_ROWS = [
    [95, 88, 178, 87, 14, 317, 402, 318, 324],
    [96, 89, 179, 86, 15, 316, 403, 319, 325],
    [77, 90, 180, 85, 16, 315, 404, 320, 307],
    [146, 91, 181, 84, 17, 314, 405, 321, 375],
]
LIP_CORNERS = [61, 76, 62, 78, 291, 306, 292, 308]
LIP_VERTICES = frozenset(
    i for row in UPPER_LIP_ROWS + LOWER_LIP_ROWS for i in row
) | frozenset(LIP_CORNERS)

# Lid rings: image-left eye (the subject's right) and image-right eye.
LEFT_EYE_RING = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246]
RIGHT_EYE_RING = [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466]

# Key landmarks.
NOSE_TIP = 1
CHIN = 152
FOREHEAD = 10
EAR_LEFT, EAR_RIGHT = 234, 454  # the oval at ear level, image left and right
MOUTH_LEFT, MOUTH_RIGHT = 61, 291
UPPER_INNER_LIP, LOWER_INNER_LIP = 13, 14
# Mid-cheek skin, the plane the nose protrudes from (the 2D engine's CHEEK_LANDMARKS).
CHEEK_LANDMARKS = [50, 280, 205, 425, 101, 330]

__all__ = [
    "CHEEK_LANDMARKS", "CHIN", "EAR_LEFT", "EAR_RIGHT", "FACE_OVAL", "FOREHEAD", "INNER_LIP_RING",
    "LEFT_EYE_RING", "LIP_CORNERS", "LIP_VERTICES", "LOWER_INNER_LIP", "LOWER_LIP_ROWS",
    "MOUTH_LEFT", "MOUTH_RIGHT", "NOSE_TIP", "NUM_LANDMARKS", "NUM_MESH_VERTICES",
    "OUTER_LIP_RING", "RIGHT_EYE_RING", "UPPER_INNER_LIP", "UPPER_LIP_ROWS",
    "canonical_shape", "canonical_uv", "canonical_triangles", "face_triangles",
    "mouth_fill_triangles", "vertex_neighbours",
]


@lru_cache(maxsize=1)
def _mesh() -> tuple[np.ndarray, np.ndarray]:
    data = json.loads(MESH_PATH.read_text())
    vertices = np.array(data["vertices"], dtype=np.float64)
    triangles = np.array(data["triangles"], dtype=np.int32)
    if vertices.shape != (NUM_MESH_VERTICES, 5) or triangles.shape[1] != 3:
        raise ValueError("canonical face mesh has an unexpected shape")
    vertices.setflags(write=False)
    triangles.setflags(write=False)
    return vertices, triangles


def canonical_shape() -> np.ndarray:
    """The canonical face's x, y, z (468, 3): y up, z toward the camera,
    in MediaPipe's centimetre-ish units. Read-only."""
    return _mesh()[0][:, :3]


def canonical_uv() -> np.ndarray:
    """The canonical UVs (468, 2), origin top-left. Read-only."""
    return _mesh()[0][:, 3:]


def canonical_triangles() -> np.ndarray:
    """All 898 canonical triangles (eyes and mouth closed). Read-only."""
    return _mesh()[1]


@lru_cache(maxsize=1)
def mouth_fill_triangles() -> np.ndarray:
    """The triangles that close the mouth: those with every corner on the
    inner lip ring. Read-only."""
    inner = frozenset(INNER_LIP_RING)
    tris = canonical_triangles()
    mask = np.array([all(int(v) in inner for v in tri) for tri in tris])
    fill = tris[mask]
    fill.setflags(write=False)
    return fill


@lru_cache(maxsize=1)
def face_triangles() -> np.ndarray:
    """The face's triangles: canonical minus the mouth fill. Read-only."""
    inner = frozenset(INNER_LIP_RING)
    tris = canonical_triangles()
    mask = np.array([not all(int(v) in inner for v in tri) for tri in tris])
    face = tris[mask]
    face.setflags(write=False)
    return face


@lru_cache(maxsize=1)
def vertex_neighbours() -> tuple[tuple[int, ...], ...]:
    """Each mesh vertex's neighbours along canonical edges (468 entries;
    iris points have none)."""
    adjacency: list[set[int]] = [set() for _ in range(NUM_LANDMARKS)]
    for a, b, c in canonical_triangles():
        adjacency[a].update((int(b), int(c)))
        adjacency[b].update((int(a), int(c)))
        adjacency[c].update((int(a), int(b)))
    return tuple(tuple(sorted(n)) for n in adjacency)
