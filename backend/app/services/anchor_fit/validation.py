"""The validator: what makes a fitted mesh unsaveable, with a reason the
owner can act on."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy.spatial import Delaunay

from app.services.anchor_fit.scheme import (
    EYE_SLACK,
    FLIP_EPSILON,
    HEAD,
    HEAD_OUTLINE,
    HEAD_SLACK,
    IRIS,
    LEFT_EYE,
    LEFT_IRIS,
    MOUTH,
    RIGHT_EYE,
    RIGHT_IRIS,
    SEAM,
)


@dataclass(frozen=True)
class FitProblem:
    """Why a fit cannot be saved. `code` is stable for clients to translate;
    `count` carries the number where one applies."""

    code: str
    detail: str
    count: int | None = None


def _signed_areas(points: np.ndarray, triangles: np.ndarray) -> np.ndarray:
    a, b, c = points[triangles[:, 0]], points[triangles[:, 1]], points[triangles[:, 2]]
    return (b[:, 0] - a[:, 0]) * (c[:, 1] - a[:, 1]) - (b[:, 1] - a[:, 1]) * (c[:, 0] - a[:, 0])


def flipped_triangles(
    base: np.ndarray, fitted: np.ndarray, triangles: np.ndarray | None = None
) -> int:
    """How many triangles of the base triangulation the fit turned over.

    Triangles with an iris vertex do not count: the iris lies under the
    lids, not in the skin, and in every detection its ring already reaches
    past both of them, so a lid moved over it, or a smaller pupil, would
    "fold" a triangle between two layers that never touch.
    """
    if triangles is None:
        triangles = Delaunay(base).simplices
    skin: np.ndarray = triangles[~np.isin(triangles, IRIS).any(axis=1)]
    before = _signed_areas(base, skin)
    after = _signed_areas(fitted, skin)
    box = np.ptp(base, axis=0)
    eps = FLIP_EPSILON * float(box[0] * box[1]) * 2  # signed areas are doubled
    measurable = (np.abs(before) > eps) & (np.abs(after) > eps)
    return int(np.sum(measurable & (np.sign(before) != np.sign(after))))


def _cross(o: np.ndarray, a: np.ndarray, b: np.ndarray) -> float:
    return float((a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]))


def _segments_cross(p1, p2, q1, q2) -> bool:
    """Whether two segments cross at a point inside both (touching ends, or
    running along each other, is not crossing: a mark nudged onto its
    neighbour's line is a degenerate outline, not a crossed one)."""
    d1, d2 = _cross(q1, q2, p1), _cross(q1, q2, p2)
    d3, d4 = _cross(p1, p2, q1), _cross(p1, p2, q2)
    return d1 * d2 < 0 and d3 * d4 < 0


def outline_crossed(ring: np.ndarray) -> bool:
    """Whether a closed polygon crosses itself: any two edges that do not
    share a corner intersect."""
    n = len(ring)
    for i in range(n):
        for j in range(i + 2, n):
            if i == 0 and j == n - 1:
                continue  # the closing edge shares corner 0 with the first
            if _segments_cross(ring[i], ring[(i + 1) % n], ring[j], ring[(j + 1) % n]):
                return True
    return False


def _turns(ring: np.ndarray) -> np.ndarray:
    """The angle each corner of a closed ring turns on to the next, as seen
    from the ring's centre, in (-pi, pi]."""
    centre = ring.mean(axis=0)
    angles = np.arctan2(ring[:, 1] - centre[1], ring[:, 0] - centre[0])
    steps: np.ndarray = np.diff(np.append(angles, angles[0]))
    return (steps + np.pi) % (2 * np.pi) - np.pi


def outline_in_order(base_ring: np.ndarray, ring: np.ndarray) -> bool:
    """Whether the corners of `ring` go round its centre one way, the way
    the base's do. A temple dragged past the top of the head can leave the
    outline uncrossed (it zigzags back) yet out of order, and the warp then
    stretches the forehead across itself."""
    direction = np.sign(_turns(base_ring).sum())
    return bool(np.all(_turns(ring) * direction > 0))


def validate(base: np.ndarray, fitted: np.ndarray, pupils: bool = True) -> list[FitProblem]:
    """Everything wrong with a fit, or nothing. Shared by preview and save.
    `pupils` is whether the line has pupils to check (an animal's are never
    marked, so no owner could correct them)."""
    problems: list[FitProblem] = []
    flips = flipped_triangles(base, fitted)
    if flips:
        problems.append(
            FitProblem(
                "folded_mesh",
                f"{flips} triangle{'s' if flips != 1 else ''} of the face would fold over; "
                "move the marks so the eyes, mouth and head do not cross each other",
                flips,
            )
        )

    x, y = fitted[:, 0], fitted[:, 1]
    if y[LEFT_EYE["top"]] > y[LEFT_EYE["bottom"]] or y[RIGHT_EYE["top"]] > y[RIGHT_EYE["bottom"]]:
        problems.append(FitProblem("lids_inverted", "An eye's top mark is below its bottom mark"))
    order = [x[LEFT_EYE["left"]], x[LEFT_EYE["right"]], x[RIGHT_EYE["left"]], x[RIGHT_EYE["right"]]]
    if not all(a < b for a, b in zip(order, order[1:])):
        problems.append(
            FitProblem(
                "eyes_out_of_order",
                "The eye corners are out of order; each eye's left mark must be left of its right "
                "mark, and the left eye left of the right eye",
            )
        )
    if not x[MOUTH["left"]] < x[MOUTH["right"]]:
        problems.append(
            FitProblem("mouth_reversed", "The mouth's left corner is right of its right corner")
        )

    head = [HEAD["left"], HEAD["right"], HEAD["top"], HEAD["bottom"]]
    x0, x1 = float(x[head].min()), float(x[head].max())
    y0, y1 = float(y[head].min()), float(y[head].max())
    slack = HEAD_SLACK * max(x1 - x0, y1 - y0)
    features = [*LEFT_EYE.values(), *RIGHT_EYE.values(), *MOUTH.values(), *SEAM]
    outside = [
        i
        for i in features
        if not (x0 - slack <= x[i] <= x1 + slack and y0 - slack <= y[i] <= y1 + slack)
    ]
    if outside:
        problems.append(
            FitProblem("outside_head", "The eyes and the mouth must be inside the head")
        )

    # The head's eight marks are drawn as one closed curve; a curve that
    # crosses itself, or goes round the face out of order, is a head turned
    # inside out somewhere, whether or not a triangle there is big enough
    # for the fold count to see it.
    ring = fitted[HEAD_OUTLINE]
    if outline_crossed(ring):
        problems.append(FitProblem("outline_crossed", "The head's outline crosses itself"))
    elif not outline_in_order(base[HEAD_OUTLINE], ring):
        problems.append(
            FitProblem(
                "outline_out_of_order",
                "The head's outline points must go round the face in order: top, temple, side, "
                "jaw corner, chin, and back up the other side",
            )
        )

    # The fold count no longer sees the iris, so a pupil dragged onto the
    # cheek is caught here: its centre must lie within its eye's marks.
    def in_eye(iris: int, eye: dict[str, int]) -> bool:
        xs = [x[eye["left"]], x[eye["right"]]]
        ys = [y[eye["top"]], y[eye["bottom"]]]
        slack = EYE_SLACK * abs(xs[1] - xs[0])
        return (
            min(xs) - slack <= x[iris] <= max(xs) + slack
            and min(ys) - slack <= y[iris] <= max(ys) + slack
        )

    if pupils and not (in_eye(LEFT_IRIS[0], LEFT_EYE) and in_eye(RIGHT_IRIS[0], RIGHT_EYE)):
        problems.append(
            FitProblem("pupil_outside_eye", "Each pupil's centre must be inside its eye")
        )
    return problems
