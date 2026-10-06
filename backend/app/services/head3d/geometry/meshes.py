"""Meshes: the type every part is, and the normals, winding and grids
they are built with."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass
class Mesh:
    """Positions (n, 3) in the head frame, UVs (n, 2) with the origin at the
    image's top-left (the glTF convention), triangles (m, 3)."""
    positions: np.ndarray
    uvs: np.ndarray
    triangles: np.ndarray

    def __post_init__(self) -> None:
        self.positions = np.ascontiguousarray(self.positions, dtype=np.float32)
        self.uvs = np.ascontiguousarray(self.uvs, dtype=np.float32)
        self.triangles = np.ascontiguousarray(self.triangles, dtype=np.uint32)


def orient_outward(positions: np.ndarray, triangles: np.ndarray, centre: np.ndarray) -> np.ndarray:
    """Wind every triangle so its normal points away from `centre`."""
    p = np.asarray(positions, dtype=np.float64)
    tris = np.array(triangles, dtype=np.int64)
    a, b, c = p[tris[:, 0]], p[tris[:, 1]], p[tris[:, 2]]
    normal = np.cross(b - a, c - a)
    outward = (a + b + c) / 3 - np.asarray(centre, dtype=np.float64)
    flip = np.einsum("ij,ij->i", normal, outward) < 0
    tris[flip, 1], tris[flip, 2] = tris[flip, 2], tris[flip, 1]
    return tris


def vertex_normals(positions: np.ndarray, triangles: np.ndarray) -> np.ndarray:
    """Area-weighted vertex normals (n, 3); an unreferenced vertex faces +z."""
    p = np.asarray(positions, dtype=np.float64)
    tris = np.asarray(triangles, dtype=np.int64)
    normals = np.zeros_like(p)
    face = np.cross(p[tris[:, 1]] - p[tris[:, 0]], p[tris[:, 2]] - p[tris[:, 0]])
    for k in range(3):
        np.add.at(normals, tris[:, k], face)
    length = np.linalg.norm(normals, axis=1)
    normals[length < 1e-12] = (0, 0, 1)
    length = np.linalg.norm(normals, axis=1)
    return normals / length[:, None]


def grid_triangles(rows: int, columns: int, wrap: bool = False) -> np.ndarray:
    """Two triangles per cell of a rows x columns vertex grid (row-major).
    `wrap` closes the last column onto the first."""
    tris = []
    cols = columns if wrap else columns - 1
    for r in range(rows - 1):
        for c in range(cols):
            c1 = (c + 1) % columns
            a, b = r * columns + c, r * columns + c1
            d, e = (r + 1) * columns + c, (r + 1) * columns + c1
            tris.append((a, b, e))
            tris.append((a, e, d))
    return np.array(tris, dtype=np.int64).reshape(-1, 3)
