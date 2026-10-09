"""Small folds smoothed away: the landmarks of a folded triangle that no
mark pins are moved back into the shape the reference gives them.

A mark moved a few pixels can turn over a triangle a pixel thin between it
and the next ring of landmarks (the lips' rings, the oval's, a lid's) while
every mark is where it belongs. That is not the owner's to fix, and they
cannot see it: refusing it left them dragging points until something
passed. Two ways back, each repeated until nothing is folded:

- the triangle's own: a corner no mark pins is put where it sits on the
  opposite edge in the reference (the similarity, a rotation and a scale,
  never a mirror, that takes that edge from its reference place to its
  fitted one), so the triangle has the reference's shape and orientation;
- its neighbours': each such landmark goes where the similarity that best
  takes its neighbours from the reference to their fitted places puts it,
  which is how it sat among them, widening ring by ring when that is not
  enough.

Marked landmarks never move. A fold that needs a landmark moved further
than SMOOTH_LIMIT of the face is marks crossing each other (an eye dragged
into the mouth), and is left for the validator to refuse.
"""

from __future__ import annotations

from collections.abc import Callable

import numpy as np

from app.services.anchor_fit.scheme import ORIENTATION_PX, SMOOTH_LIMIT
from app.services.anchor_fit.validation import folded, skin_triangles

# Rounds of each way before giving up; the neighbours' way also widens the
# moved set by a ring of neighbours every few rounds, up to a few rings.
_ROUNDS = 40
_WIDEN_AFTER = 8
_MAX_RINGS = 3

Step = Callable[[np.ndarray, np.ndarray], dict[int, np.ndarray] | None]


def _complex(p: np.ndarray) -> np.ndarray:
    return p[..., 0] + 1j * p[..., 1]


def _point(z: complex) -> np.ndarray:
    return np.array([z.real, z.imag])


def _neighbours(triangles: np.ndarray, count: int) -> list[np.ndarray]:
    sets: list[set[int]] = [set() for _ in range(count)]
    for a, b, c in triangles.tolist():
        sets[a].update((b, c))
        sets[b].update((a, c))
        sets[c].update((a, b))
    return [np.fromiter(s, dtype=np.int64) for s in sets]


def _on_edge(ref: np.ndarray, cur: np.ndarray, v: int, a: int, b: int) -> np.ndarray | None:
    """Where `v` sits on edge a-b as it does in the reference, at least a
    few ORIENTATION_PX off it so the rounding keeps its side."""
    pa, pb, pv = (complex(*ref[i]) for i in (a, b, v))
    qa, qb = complex(*cur[a]), complex(*cur[b])
    if abs(pb - pa) < 1e-9 or abs(qb - qa) < 1e-9:
        return None
    s = (qb - qa) / (pb - pa)
    z = qa + s * (pv - pa)
    # Its height off the edge, kept clear of the rounding.
    edge = (qb - qa) / abs(qb - qa)
    height = ((z - qa) / edge).imag
    least = 4 * ORIENTATION_PX
    if abs(height) < least:
        side = 1.0 if ((pv - pa) / (pb - pa)).imag >= 0 else -1.0
        z += edge * 1j * (side * least - height)
    return _point(z)


def _by_triangle(triangles: np.ndarray, free: np.ndarray, reference: np.ndarray) -> Step:
    def step(current: np.ndarray, bad: np.ndarray) -> dict[int, np.ndarray] | None:
        proposals: dict[int, list[np.ndarray]] = {}
        for tri in triangles[bad].tolist():
            corners = [v for v in tri if free[v]]
            if not corners:
                return None  # marks crossing each other: nothing to move
            # The corner across the longest edge: moving it changes least.
            pts = current[tri]
            lengths = [np.linalg.norm(pts[(k + 1) % 3] - pts[(k + 2) % 3]) for k in range(3)]
            order = sorted(range(3), key=lambda k: -lengths[k])
            v = next(tri[k] for k in order if free[tri[k]])
            a, b = (u for u in tri if u != v)
            placed = _on_edge(reference, current, v, a, b)
            if placed is not None:
                proposals.setdefault(v, []).append(placed)
        return {v: np.mean(ps, axis=0) for v, ps in proposals.items()} or None

    return step


def _by_neighbours(triangles: np.ndarray, free: np.ndarray, reference: np.ndarray) -> Step:
    neighbours = _neighbours(triangles, len(reference))
    moving: set[int] = set()
    rounds = [0]

    def placed(current: np.ndarray, v: int) -> np.ndarray:
        ring = neighbours[v]
        p, q = _complex(reference[ring]), _complex(current[ring])
        pm, qm = p.mean(), q.mean()
        p, q = p - pm, q - qm
        norm = float(np.sum(np.abs(p) ** 2))
        a = complex(np.sum(np.conj(p) * q) / norm) if norm > 1e-12 else 1.0
        return _point(qm + a * (complex(*reference[v]) - pm))

    def step(current: np.ndarray, bad: np.ndarray) -> dict[int, np.ndarray] | None:
        moving.update(int(v) for v in np.unique(triangles[bad]) if free[v])
        rounds[0] += 1
        if rounds[0] % _WIDEN_AFTER == 0 and rounds[0] // _WIDEN_AFTER <= _MAX_RINGS:
            moving.update(int(n) for v in list(moving) for n in neighbours[v] if free[n])
        return {v: placed(current, v) for v in moving} or None

    return step


def smooth_folds(
    base: np.ndarray,
    reference: np.ndarray,
    fitted: np.ndarray,
    pinned: set[int],
) -> tuple[np.ndarray, int] | None:
    """`fitted` with its folds smoothed away, and how many triangles were
    folded; None when that cannot be done without moving a pinned landmark
    or moving one further than SMOOTH_LIMIT of the face.

    Folds are counted as `validate` counts them (against `base` and
    `reference`), and the result is rounded as a fit is stored, so it
    validates exactly as returned.
    """
    triangles = skin_triangles(base)
    bad = folded(base, fitted, reference, triangles)
    count = int(bad.sum())
    if not count:
        return fitted, 0
    limit = SMOOTH_LIMIT * float(np.ptp(reference, axis=0).max())
    free = np.ones(len(base), dtype=bool)
    free[list(pinned)] = False
    for make in (_by_triangle, _by_neighbours):
        step = make(triangles, free, reference)
        current, bad = fitted.copy(), folded(base, fitted, reference, triangles)
        for _ in range(_ROUNDS):
            moves = step(current, bad)
            if moves is None:
                break
            for v, p in moves.items():
                current[v] = p
            current = np.round(current, 2)
            if np.linalg.norm(current - fitted, axis=1).max() > limit:
                break
            bad = folded(base, current, reference, triangles)
            if not bad.any():
                return current, count
    return None
