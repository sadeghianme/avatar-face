"""The owner's marks: read from and written to JSON, merged region by
region, and opened on a mesh (where each handle starts)."""

from __future__ import annotations

import math
from collections.abc import Mapping
from dataclasses import dataclass, fields, replace
from typing import Any, cast

import numpy as np

from app.models.shapes import Marks
from app.services.anchor_fit.scheme import (
    CHIN,
    DIAGONALS,
    HEAD,
    HEAD_DIAGONALS,
    INNER_LOWER,
    INNER_UPPER,
    LEFT_EYE,
    LEFT_IRIS,
    MOUTH,
    MOUTH_LINE_POINTS,
    RIGHT_EYE,
    RIGHT_IRIS,
    SEAM,
    Point,
    marks_mouth_as_line,
    marks_pupils,
)


@dataclass(frozen=True)
class RegionMarks:
    """A region's extremes as FREE 2D points: a tilted eye or a curved mouth
    keeps its tilt. `center` is the mouth's seam centre, human line only.

    The head also has its diagonals (HEAD_DIAGONALS), each optional: marks
    saved before there were any have none, and a diagonal nobody marked is
    not pinned. The warp carries it with the rest of the face, exactly as it
    did before the head had diagonals, so those marks fit as they always did.
    """

    left: Point
    right: Point
    top: Point
    bottom: Point
    center: Point | None = None
    upper_left: Point | None = None
    upper_right: Point | None = None
    lower_right: Point | None = None
    lower_left: Point | None = None

    def diagonals(self) -> dict[str, Point]:
        """The diagonals that are marked, by name."""
        return {d: getattr(self, d) for d in DIAGONALS if getattr(self, d) is not None}


@dataclass(frozen=True)
class PupilMarks:
    """A pupil is a circle: its centre, and one point on its rim."""

    center: Point
    rim: Point


@dataclass(frozen=True)
class FaceMarks:
    """Everything the owner marked. A region left as None was not marked."""

    head: RegionMarks | None = None
    left_eye: RegionMarks | None = None
    right_eye: RegionMarks | None = None
    # Human line: the mouth's edges.
    mouth: RegionMarks | None = None
    # Animal and cartoon lines: corner, three points along the seam, corner.
    mouth_line: tuple[Point, ...] | None = None
    chin: Point | None = None
    left_pupil: PupilMarks | None = None
    right_pupil: PupilMarks | None = None


def _point(value) -> Point | None:
    if isinstance(value, dict) and value.get("x") is not None and value.get("y") is not None:
        return (float(value["x"]), float(value["y"]))
    return None


def _region(value, diagonals: bool = False) -> RegionMarks | None:
    """A region from JSON; with `diagonals` (the head), whichever of its
    diagonals are there too."""
    if not isinstance(value, dict):
        return None
    left, right, top, bottom = (_point(value.get(e)) for e in ("left", "right", "top", "bottom"))
    if left is None or right is None or top is None or bottom is None:
        return None
    extra = {d: _point(value.get(d)) for d in DIAGONALS} if diagonals else {}
    return RegionMarks(left, right, top, bottom, center=_point(value.get("center")), **extra)


def _pupil(value) -> PupilMarks | None:
    if not isinstance(value, dict):
        return None
    center, rim = _point(value.get("center")), _point(value.get("rim"))
    return PupilMarks(center, rim) if center and rim else None


def _line(value) -> tuple[Point, ...] | None:
    if not isinstance(value, list) or len(value) != MOUTH_LINE_POINTS:
        return None
    points: list[Point] = []
    for raw in value:
        point = _point(raw)
        if point is None:
            return None
        points.append(point)
    return tuple(points)


def _line_from_region(mouth: RegionMarks) -> tuple[Point, ...]:
    """A mouth marked by its edges (the only way before mouth lines), read
    as a line: the corners stay, the seam runs through the centre."""
    left, right = mouth.left, mouth.right
    mid = mouth.center or (
        (mouth.top[0] + mouth.bottom[0]) / 2,
        (mouth.top[1] + mouth.bottom[1]) / 2,
    )
    halfway = lambda a, b: ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)  # noqa: E731
    return (left, halfway(left, mid), mid, halfway(mid, right), right)


def for_face_type(marks: FaceMarks, face_type: str) -> FaceMarks:
    """The marks in the scheme `face_type` is marked in.

    Stored marks can predate the scheme (every animal marked before mouth
    lines has a four-edge mouth and pupils) or come from another line (the
    owner switched it). Nothing is refused for that: an edge-marked mouth
    reads as a line through its centre, and what a line does not mark is
    dropped.
    """
    if marks_mouth_as_line(face_type):
        line = marks.mouth_line or (_line_from_region(marks.mouth) if marks.mouth else None)
        marks = replace(marks, mouth=None, mouth_line=line)
    else:
        marks = replace(marks, mouth_line=None, chin=None)
    if not marks_pupils(face_type):
        marks = replace(marks, left_pupil=None, right_pupil=None)
    return marks


def marks_from_dict(data: Mapping[str, Any] | None, face_type: str) -> FaceMarks:
    """Marks as stored in `user_anchors` or sent by the client, in any past
    format, expressed in `face_type`'s scheme. Unknown keys are ignored."""
    data = data or {}
    marks = FaceMarks(
        head=_region(data.get("head"), diagonals=True),
        left_eye=_region(data.get("left_eye")),
        right_eye=_region(data.get("right_eye")),
        mouth=_region(data.get("mouth")),
        mouth_line=_line(data.get("mouth_line")),
        chin=_point(data.get("chin")),
        left_pupil=_pupil(data.get("left_pupil")),
        right_pupil=_pupil(data.get("right_pupil")),
    )
    return for_face_type(marks, face_type)


def saved_marks(rig: dict, face_type: str, rig_on_base: bool) -> FaceMarks:
    """The owner's marks stored in `rig`, in `face_type`'s scheme.

    Marks saved by this fit say so (`source: "owner"`) and are landmark
    positions. Anything older was saved by the panel this replaced, which
    sent every region on every save, each at the BOUNDING BOX of its points
    (the head's leftmost of all 478, an eye's topmost of lid and iris, a
    mouth centre at its box's centre) — not where 234, 159 or 13 sit. Read as
    landmark marks they drag the face (measured on a detected portrait
    re-saved unchanged: 234 up 52 px to the temple, the lids onto the iris
    top, the lip centre onto the cupid's bow). The old fit had already put
    its result into the rig's points, so where `rig_on_base` says those
    points are the base's landmarks (a detected face, or a rig that is its
    own base), the marks are read off them and a re-save changes nothing.
    A rig built on the synthetic mesh, whose numbering is not the base's,
    keeps its saved marks: they are the only reading of the owner's intent.
    """
    stored = rig.get("user_anchors") or {}
    if stored and stored.get("source") != "owner" and rig_on_base:
        return marks_from_mesh(np.array(rig["points"], dtype=np.float64), face_type)
    return marks_from_dict(stored, face_type)


def marks_to_dict(marks: FaceMarks) -> Marks:
    """JSON for `user_anchors` and the rig-anchors response. Only what is
    marked is written."""

    def pt(p: Point) -> dict:
        return {"x": round(p[0], 2), "y": round(p[1], 2)}

    out: dict = {}
    for name in ("head", "left_eye", "right_eye", "mouth"):
        region = getattr(marks, name)
        if region is not None:
            out[name] = {
                edge: pt(getattr(region, edge)) for edge in ("left", "right", "top", "bottom")
            }
            if region.center is not None:
                out[name]["center"] = pt(region.center)
            for diagonal, p in region.diagonals().items():
                out[name][diagonal] = pt(p)
    if marks.mouth_line is not None:
        out["mouth_line"] = [pt(p) for p in marks.mouth_line]
    if marks.chin is not None:
        out["chin"] = pt(marks.chin)
    for name in ("left_pupil", "right_pupil"):
        pupil = getattr(marks, name)
        if pupil is not None:
            out[name] = {"center": pt(pupil.center), "rim": pt(pupil.rim)}
    # Built key by key from the dataclass; exactly the Marks shape.
    return cast(Marks, out)


def merge(older: FaceMarks, newer: FaceMarks) -> FaceMarks:
    """Region by region, the newer marks win; a region the newer set leaves
    out keeps its older marking. Lets a client re-send only what moved.

    The head's diagonals one by one, but only under the same four edges: a
    head re-sent unchanged without them keeps the older head's (the marking
    panel sends a head it did not touch that way, so a head saved before
    there were diagonals saves exactly as it did), while a head whose edges
    moved leaves the ones it does not send to the warp, as every head did
    before there were diagonals: an outline pinned where the old edges had
    it would pull the new ones out of shape."""

    def pick(name: str) -> Any:
        value = getattr(newer, name)
        return value if value is not None else getattr(older, name)

    merged = FaceMarks(**{f.name: pick(f.name) for f in fields(FaceMarks)})
    if newer.head is not None and older.head is not None and _same_edges(newer.head, older.head):
        kept = {d: p for d, p in older.head.diagonals().items() if getattr(newer.head, d) is None}
        if kept:
            merged = replace(merged, head=replace(newer.head, **kept))
    return merged


# Marks are stored to the hundredth of a pixel (marks_to_dict): two edges
# closer than that are the same edge sent back.
SAME_MARK_PX = 0.01


def _same_edges(a: RegionMarks, b: RegionMarks) -> bool:
    return all(
        math.dist(getattr(a, e), getattr(b, e)) <= SAME_MARK_PX
        for e in ("left", "right", "top", "bottom")
    )


def with_head_outline(marks: FaceMarks, points: np.ndarray) -> FaceMarks:
    """`marks` with every head diagonal they lack read off `points`, the
    mesh those marks made: where the warp took the landmark while nothing
    pinned it, which is where a handle for it opens (the point finder names
    only the head's edges)."""
    head = marks.head
    if head is None:
        return marks
    missing = {
        d: (float(points[i][0]), float(points[i][1]))
        for d, i in HEAD_DIAGONALS.items()
        if getattr(head, d) is None
    }
    return replace(marks, head=replace(head, **missing)) if missing else marks


def seam_line(points: np.ndarray) -> tuple[Point, ...]:
    """The mouth line a mesh already has: its corners, and the middle of the
    inner-lip seam at a quarter, half and three quarters of the way across."""
    left, right = points[MOUTH["left"]], points[MOUTH["right"]]
    axis = right - left
    length2 = float(axis @ axis) or 1.0
    samples = [(0.0, left)]
    for upper, lower in zip(INNER_UPPER[1:-1], INNER_LOWER[1:-1]):
        mid = (points[upper] + points[lower]) / 2
        samples.append((float(np.clip((mid - left) @ axis / length2, 0.0, 1.0)), mid))
    samples.append((1.0, right))
    samples.sort(key=lambda s: s[0])
    ts = [s[0] for s in samples]
    xs = [float(s[1][0]) for s in samples]
    ys = [float(s[1][1]) for s in samples]
    inner = [(float(np.interp(t, ts, xs)), float(np.interp(t, ts, ys))) for t in (0.25, 0.5, 0.75)]
    return ((float(left[0]), float(left[1])), *inner, (float(right[0]), float(right[1])))


def marks_from_mesh(points: np.ndarray, face_type: str) -> FaceMarks:
    """Where the handles sit on a mesh nobody has marked: on the very
    landmarks the marks attach to, so opening and saving changes nothing a
    detection got right."""

    def at(i: int) -> Point:
        return (float(points[i][0]), float(points[i][1]))

    def region(idx: dict[str, int]) -> RegionMarks:
        return RegionMarks(at(idx["left"]), at(idx["right"]), at(idx["top"]), at(idx["bottom"]))

    head = replace(region(HEAD), **{d: at(i) for d, i in HEAD_DIAGONALS.items()})

    def pupil(ring: list[int]) -> PupilMarks:
        c = points[ring[0]]
        radius = max(float(np.mean([np.linalg.norm(points[j] - c) for j in ring[1:]])), 2.0)
        return PupilMarks(at(ring[0]), (float(c[0]) + radius, float(c[1])))

    seam = (points[SEAM[0]] + points[SEAM[1]]) / 2
    marks = FaceMarks(
        head=head,
        left_eye=region(LEFT_EYE),
        right_eye=region(RIGHT_EYE),
        mouth=replace(region(MOUTH), center=(float(seam[0]), float(seam[1]))),
        mouth_line=seam_line(points),
        chin=at(CHIN),
        left_pupil=pupil(LEFT_IRIS),
        right_pupil=pupil(RIGHT_IRIS),
    )
    return for_face_type(marks, face_type)
