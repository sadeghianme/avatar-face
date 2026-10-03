"""Fit a face mesh to the marks its owner placed by hand.

Every landmark the engine trusts either came from MediaPipe, which fits a
HUMAN face, or — for an animal or a cartoon nothing detects — from the face
template. Either way it is a guess until the owner has placed the head, the
eyes and the mouth, and this turns those marks into the rig.

These decisions carry the module.

**One global warp, always from the base.** The fit this replaces corrected
region by region, each correction a local warp chained on the last one's
output. Local warps pull in different directions where their falloffs
overlap, and on an animal — a big head, small eyes, a wide muzzle, all far
from where a human template put them — they folded 37 to 147 of the mesh's
918 triangles over themselves. Folded triangles render as texture flipped
inside out. Here ALL marks feed one thin-plate-spline warp, the smoothest
map that puts every marked landmark where it was marked, applied to all 478
points at once. It always starts from the unmodified base mesh (the
detection, or the template), never from a previous fit, so saving the same
marks twice stores the same rig.

**The mouth is a line on animals and cartoons.** A muzzle has no lips whose
edges could be marked, and a toon's mouth is often a single stroke. There
the owner marks the corners and three points along the seam, and every
inner-lip landmark is put ON that line at the fraction of the mouth width it
occupies in the base mesh — the upper ring a hair above the lower one, so no
lip triangle collapses to nothing — with the lip rings behind it following
in their order. A human mouth is still marked by its edges and its centre.

**The iris is not skin.** A marked pupil is placed after the warp, moved
and scaled as one piece, and never pins it. The iris ring overlaps both
lids in every detection (an eye shows part of its iris), so as a warp
constraint it counted any lid moved past its rim, or any pupil drawn
smaller than the detected one, as skin folded over the eye.

**The head is its outline.** Eight marks round the face (its four edges,
the temples and the jaw corners), and with all eight marked every oval
landmark between them goes on the smooth curve the owner sees through them
(`_outline_pairs`), so the mesh's edge is that outline. Marks saved with a
four-point head pin those four only and fit exactly as they always did.

**A fit that folds is refused, not saved.** `validate` names what is wrong
(folded triangles, lids upside down, eyes or mouth corners out of order,
features outside the head, a head outline that crosses itself or goes round
the face out of order, a pupil outside its eye) and rig-fit refuses to
store such a rig. The preview still returns it, with the reasons, so the
owner sees what to move.

The base mesh is kept beside the rig in storage (fit-base.json), never in
rig.json: the rig is published to every visitor, the base is only needed
here. It records the frame it was taken in (image size and crop origin), so
a base that no longer matches its rig — after an undo, say — is detected and
rebuilt rather than silently misapplied.
"""

from __future__ import annotations

import json
import logging
import math
from dataclasses import dataclass, fields, replace

import numpy as np
from scipy.interpolate import RBFInterpolator
from scipy.spatial import Delaunay

logger = logging.getLogger("liveface.anchor_fit")

Point = tuple[float, float]

NUM_POINTS = 478

# The landmarks the marks attach to, in MediaPipe's index order. "Left" and
# "right" are the IMAGE's: 33 is the outer corner of the eye on the image's
# left, which is the subject's right eye.
HEAD = {"left": 234, "right": 454, "top": 10, "bottom": 152}
# MediaPipe's face oval, clockwise on screen from the top of the forehead.
FACE_OVAL = [
    10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377,
    152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109,
]
# The head's outline between its four edges: the temples above, the jaw
# corners below. Four edges alone drew the head as a diamond, and a warp
# pinned only there was free to bulge or pinch the cheeks and the jaw
# wherever a face is not diamond-shaped, which is every face and every muzzle.
#
# Each is the oval landmark nearest the DIAGONAL of the head's box, seen
# from its centre, on the face template. On an ellipse the point halfway
# round between two edges (parameter 45 degrees) lies exactly on that
# diagonal, so the eight marks are an ellipse's eight points and a smooth
# closed curve through them draws the oval. The two sides are MediaPipe's
# mirror pairs (54 and 284, 136 and 365); tests/test_anchor_fit pins them.
HEAD_DIAGONALS = {"upper_left": 54, "upper_right": 284, "lower_right": 365, "lower_left": 136}
DIAGONALS = tuple(HEAD_DIAGONALS)
# The eight head marks in order around the face, clockwise on screen from
# the top: the order the outline is drawn in, and checked in.
HEAD_OUTLINE_EDGES = (
    "top", "upper_right", "right", "lower_right", "bottom", "lower_left", "left", "upper_left",
)
HEAD_OUTLINE = [{**HEAD, **HEAD_DIAGONALS}[edge] for edge in HEAD_OUTLINE_EDGES]
LEFT_EYE = {"left": 33, "right": 133, "top": 159, "bottom": 145}
RIGHT_EYE = {"left": 362, "right": 263, "top": 386, "bottom": 374}
MOUTH = {"left": 61, "right": 291, "top": 0, "bottom": 17}
SEAM = (13, 14)
CHIN = HEAD["bottom"]
# Inner lip, corner to corner, image left to right. The corners are shared.
INNER_UPPER = [78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308]
INNER_LOWER = [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308]
# The rings behind the inner lip, seam outward, as MediaPipe's lip contours
# run them: semi-inner, semi-outer, outer. Corner to corner, image left to
# right, like the inner rings; their ends are the commissure below.
LIP_ROWS_UPPER = [
    INNER_UPPER,
    [62, 183, 42, 41, 38, 12, 268, 271, 272, 407, 292],
    [76, 184, 74, 73, 72, 11, 302, 303, 304, 408, 306],
    [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291],
]
LIP_ROWS_LOWER = [
    INNER_LOWER,
    [62, 96, 89, 179, 86, 15, 316, 403, 319, 325, 292],
    [76, 77, 90, 180, 85, 16, 315, 404, 320, 307, 306],
    [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291],
]
# The commissure, outer corner to inner corner. MediaPipe runs two more
# landmarks between them (76 and 62, 306 and 292), in a line; when a mouth
# line puts the inner corner on the outer one they must go there too, or
# they are left outside it and the triangles around them fold.
LEFT_COMMISSURE = [61, 76, 62, 78]
RIGHT_COMMISSURE = [291, 306, 292, 308]
# Iris centre, then four rim points.
LEFT_IRIS = [468, 469, 470, 471, 472]
RIGHT_IRIS = [473, 474, 475, 476, 477]
IRIS = LEFT_IRIS + RIGHT_IRIS
# The landmark each commissure is drawn with on a mouth line, where all four
# of a corner's landmarks sit on one point and a triangulation can only keep
# one of them: the inner corner, which the engine moves with the inner lip
# on closed-mouth shapes, so the drawn corner follows the seam it ends.
# Fixed, and the same on both sides; left to Qhull, the survivor differed
# from layout to layout and side to side, and one corner of the mouth moved
# on M/B/P while the other stayed.
LINE_CORNERS = {i: LEFT_COMMISSURE[-1] for i in LEFT_COMMISSURE} | {
    i: RIGHT_COMMISSURE[-1] for i in RIGHT_COMMISSURE
}

# How far the upper inner lip sits above the lower one on a marked mouth
# line, as a fraction of the mouth width. Zero collapses the lip triangles
# between them to no area at all, and one of them then flips on rounding
# alone (measured: every prototype layout folded exactly that one sliver).
SEAM_GAP = 0.004
MOUTH_LINE_POINTS = 5
# A chin this close to the head's bottom edge (fraction of head height) is
# the same mark: many faces end at the chin, and two correspondences a pixel
# apart would pull the jaw against itself.
CHIN_MERGE = 0.01
# Regularisation of the warp, in coordinates normalised to the face size.
# Only there to keep the solve well conditioned when two marked landmarks
# nearly coincide; small enough that every mark lands within a tenth of a
# pixel on a 1000px face.
SMOOTHING = 1e-7
# Triangles smaller than this (fraction of the face box area) are ignored by
# the fold count: a collapsed sliver, like the one between an outer mouth
# corner and the inner corner the mouth line puts on top of it, has no
# orientation to lose.
FLIP_EPSILON = 1e-7
# Slack on "inside the head", as a fraction of the head's size: a detected
# face turned slightly away can put the far eye corner a pixel past the
# cheek contour.
HEAD_SLACK = 0.02
# Slack on "the pupil is in its eye", as a fraction of the eye's width: a
# heavy upper lid can cover the iris down to its centre, which a detection
# then places on, or a hair above, the lid mark.
EYE_SLACK = 0.1

# The lines whose mouth is marked as a line, and the one without pupils.
LINE_FACE_TYPES = frozenset({"animal", "cartoon"})
NO_PUPIL_FACE_TYPES = frozenset({"animal"})
# Versioned renderer settings a fitted rig carries (see embed KindProfile).
# Absent means the classic human renderer, which humans keep.
#
# A new fit names the line's current profile: "toon@1" for the Animation and
# Cartoon looks (face type cartoon) and "animal@2" for animals, both of which
# move and paint the mouth as a character's (embed/src/character-mouth.ts).
# A rig fitted before them keeps the profile it was saved with ("animal@1", or
# none) until its owner fits it again or switches its mouth style
# (LEGACY_PROFILES is what "classic" means), so nothing live changes by itself.
RENDER_PROFILES = {"animal": "animal@2", "cartoon": "toon@1"}
LEGACY_PROFILES = {"animal": "animal@1"}
# The mouth styles an owner may choose between on those lines.
MOUTH_STYLES = ("character", "classic")


def marks_mouth_as_line(face_type: str) -> bool:
    return face_type in LINE_FACE_TYPES


def marks_pupils(face_type: str) -> bool:
    return face_type not in NO_PUPIL_FACE_TYPES


def render_profile_for(face_type: str, style: str = "character") -> str | None:
    """The profile a rig of `face_type` is saved with, in the owner's mouth
    `style`: the line's current one, or (classic) the one the line had before
    the character mouth, which is none for animation and humans."""
    if style == "classic":
        return LEGACY_PROFILES.get(face_type)
    return RENDER_PROFILES.get(face_type)


# --- Marks --------------------------------------------------------------------


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
    edges = [_point(value.get(edge)) for edge in ("left", "right", "top", "bottom")]
    if any(edge is None for edge in edges):
        return None
    extra = {d: _point(value.get(d)) for d in DIAGONALS} if diagonals else {}
    return RegionMarks(*edges, center=_point(value.get("center")), **extra)


def _pupil(value) -> PupilMarks | None:
    if not isinstance(value, dict):
        return None
    center, rim = _point(value.get("center")), _point(value.get("rim"))
    return PupilMarks(center, rim) if center and rim else None


def _line(value) -> tuple[Point, ...] | None:
    if not isinstance(value, list) or len(value) != MOUTH_LINE_POINTS:
        return None
    points = [_point(p) for p in value]
    return None if any(p is None for p in points) else tuple(points)


def _line_from_region(mouth: RegionMarks) -> tuple[Point, ...]:
    """A mouth marked by its edges (the only way before mouth lines), read
    as a line: the corners stay, the seam runs through the centre."""
    left, right = mouth.left, mouth.right
    mid = mouth.center or (
        (mouth.top[0] + mouth.bottom[0]) / 2, (mouth.top[1] + mouth.bottom[1]) / 2
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


def marks_from_dict(data: dict | None, face_type: str) -> FaceMarks:
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


def marks_to_dict(marks: FaceMarks) -> dict:
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
    return out


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
    def pick(name: str) -> object:
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


# --- The warp -------------------------------------------------------------------


def _head_carry(base: np.ndarray, head: RegionMarks | None):
    """Where an UNMARKED region goes: along with the head.

    The least-squares affine taking the base's head landmarks to the head
    marks, so an eye the owner never touched still sits where it sat relative
    to the head they moved. Without head marks, unmarked regions stay put.
    Marked diagonals take part: they say where the cheeks and the jaw went.
    """
    if head is None:
        return lambda p: p
    edges = {e: HEAD[e] for e in ("left", "right", "top", "bottom")}
    edges.update({d: HEAD_DIAGONALS[d] for d in head.diagonals()})
    src = np.array([base[i] for i in edges.values()])
    dst = np.array([getattr(head, e) for e in edges])
    design = np.column_stack((src, np.ones(len(src))))
    affine, *_ = np.linalg.lstsq(design, dst, rcond=None)
    return lambda p: np.append(p, 1.0) @ affine


def _polyline_frame(line: np.ndarray, t: float) -> tuple[np.ndarray, np.ndarray]:
    """The point a fraction `t` of the way along a polyline, by length — so a
    seam point dragged off-centre does not stretch one side of the lip — and
    the unit normal there, pointing up for a line drawn left to right.

    The normal turns smoothly between segments (blended from the vertex
    normals), so rings offset along it follow a curved mouth as bands
    instead of shearing across each other where the line bends.
    """
    seg_vec = np.diff(line, axis=0)
    seg_len = np.linalg.norm(seg_vec, axis=1)
    # A zero-length segment (two marks dropped on the same pixel) has no
    # direction; it contributes a zero normal and its neighbours decide.
    seg_normal = np.stack((seg_vec[:, 1], -seg_vec[:, 0]), axis=1) / np.maximum(seg_len, 1e-9)[:, None]
    seg_normal[seg_len <= 1e-9] = 0.0
    vertex_normal = np.vstack((seg_normal[:1], seg_normal[:-1] + seg_normal[1:], seg_normal[-1:]))
    vertex_normal /= np.maximum(np.linalg.norm(vertex_normal, axis=1, keepdims=True), 1e-9)

    total = float(seg_len.sum())
    target = t * total
    for k, length in enumerate(seg_len):
        if target <= length or k == len(seg_len) - 1:
            f = 0.0 if length < 1e-9 else min(1.0, target / length)
            normal = vertex_normal[k] * (1 - f) + vertex_normal[k + 1] * f
            norm = float(np.linalg.norm(normal))
            normal = normal / norm if norm > 1e-9 else np.array([0.0, -1.0])
            return line[k] + seg_vec[k] * f, normal
        target -= length
    return line[-1], vertex_normal[-1]


def _mouth_line_pairs(
    base: np.ndarray, line: tuple[Point, ...], targets: dict[int, np.ndarray]
) -> list[tuple[int, np.ndarray]]:
    """Every lip landmark, placed off the marked line.

    The commissures go onto the marked corners. The inner lip goes ON the
    line, at the fraction of the mouth width it occupies in the base, the
    upper ring half a SEAM_GAP above it and the lower ring half below. The
    three rings behind each lip keep their place relative to the seam in the
    base, in order and never closer than half a gap to the ring in front.
    That place scales with the mouth's width, but never by more
    than the face does between the mouth and the eyes (upper lip) or the
    mouth and the chin (lower lip): a wide grin low on a face has no room for
    lips as thick as its width would make them, and a lip pushed into the
    chin folds the chin.

    The outer rings are pinned too, not left to the warp, because a closed
    mouth's rings lie within a pixel or two of each other in a detection:
    moving the seam tens of pixels while a ring behind it is only carried
    turns the lip inside out (measured: 20 folded triangles on a detected
    face given a dog's mouth line, all in that band).
    """
    pts = np.array(line, dtype=np.float64)
    first, last = pts[0], pts[-1]
    chord = last - first
    width = float(np.linalg.norm(chord))
    # Up from the corner-to-corner chord: the direction the eyes and the
    # chin are measured along.
    up = np.array([chord[1], -chord[0]]) / width if width > 1e-9 else np.array([0.0, -1.0])
    step = SEAM_GAP * width / 2

    pairs = [(i, first) for i in LEFT_COMMISSURE] + [(i, last) for i in RIGHT_COMMISSURE]
    # Places across the mouth are measured in the base between the inner
    # corners (the same corners the line's ends pin), distances from the
    # seam along the base's own chord normal.
    a, b = base[INNER_UPPER[0]], base[INNER_UPPER[-1]]
    axis = b - a
    base_width = float(np.linalg.norm(axis)) or 1.0
    base_up = np.array([axis[1], -axis[0]]) / base_width

    # How far the eyes and the chin sit from the middle of the mouth, along
    # the mouth's normal, marked against base. `targets` holds where the
    # warp is taking them (marked, or carried with the head).
    seam_mid, _ = _polyline_frame(pts, 0.5)
    base_mid = (base[SEAM[0]] + base[SEAM[1]]) / 2
    eyes = [LEFT_EYE["top"], LEFT_EYE["bottom"], RIGHT_EYE["top"], RIGHT_EYE["bottom"]]
    eye_level = np.mean([targets[i] for i in eyes], axis=0)
    base_eye_level = np.mean([base[i] for i in eyes], axis=0)

    def room(marked: float, based: float) -> float:
        return marked / based if based > 1e-9 and marked > 0 else 0.0

    width_scale = width / base_width
    to_eyes = room(float((eye_level - seam_mid) @ up), float((base_eye_level - base_mid) @ base_up))
    to_chin = room(float((seam_mid - targets[CHIN]) @ up), float((base_mid - base[CHIN]) @ base_up))
    scales = {1.0: min(width_scale, to_eyes), -1.0: min(width_scale, to_chin)}

    def across(p: np.ndarray) -> float:
        return float(np.clip((p - a) @ axis / base_width**2, 0.0, 1.0))

    tangent = axis / base_width
    for rows, sign in ((LIP_ROWS_UPPER, 1.0), (LIP_ROWS_LOWER, -1.0)):
        scale = scales[sign]
        for k in range(1, len(rows[0]) - 1):
            # A column of the lip, inner ring outward, is carried as one
            # piece: the seam point it hangs from moves to the marked line,
            # and the rings keep their shape around it at the lip's scale.
            # Placing each ring by its own position across the mouth instead
            # shears a thin lip on a steep grin until one ring passes another.
            seam = (base[INNER_UPPER[k]] + base[INNER_LOWER[k]]) / 2
            on, normal = _polyline_frame(pts, across(seam))
            along = np.array([-normal[1], normal[0]])
            offset = 0.0
            for depth, row in enumerate(rows):
                i = row[k]
                if depth == 0:
                    shift, offset = 0.0, step
                else:
                    shift = float((base[i] - seam) @ tangent) * scale
                    offset = max(abs(float((base[i] - seam) @ base_up)) * scale, offset + step)
                pairs.append((i, on + along * shift + normal * sign * offset))
    return pairs


def part_lips(points: np.ndarray) -> np.ndarray:
    """A copy of a mesh whose upper inner lip is above its lower one by at
    least SEAM_GAP of the mouth width, each pair pulled apart about its middle.

    A closed mouth, detected, has its inner rings within a fraction of a
    pixel of each other and often crossed (the demo portrait's 13 sits BELOW
    its 14). The triangles between them then have an orientation that is
    noise, and a mouth line, which parts them properly, would be counted as
    folding them. The face template is built with this, and a mouth-line fit
    starts from a base put through it.
    """
    out = np.array(points, dtype=np.float64)
    gap = SEAM_GAP * float(np.linalg.norm(out[MOUTH["right"]] - out[MOUTH["left"]]))
    for upper, lower in zip(INNER_UPPER[1:-1], INNER_LOWER[1:-1]):
        mid = (out[upper] + out[lower]) / 2
        if out[upper][1] > mid[1] - gap / 2:
            out[upper][1] = mid[1] - gap / 2
        if out[lower][1] < mid[1] + gap / 2:
            out[lower][1] = mid[1] + gap / 2
    return out


def _iris_pairs(
    base: np.ndarray, ring: list[int], pupil: PupilMarks
) -> list[tuple[int, np.ndarray]]:
    """The iris ring moved to the marked circle: its shape kept, its centre
    and mean radius set. A rim dropped on the centre is a slip, not a pupil
    of no size: the ring then keeps the base's."""
    center = np.array(pupil.center)
    base_center = base[ring[0]]
    base_radius = float(np.mean([np.linalg.norm(base[j] - base_center) for j in ring[1:]]))
    radius = math.dist(pupil.center, pupil.rim)
    scale = radius / base_radius if base_radius > 1e-6 and radius >= 0.5 else 1.0
    return [(j, center + (base[j] - base_center) * scale) for j in ring]


def pupil_pairs(
    base: np.ndarray, marks: FaceMarks, face_type: str
) -> list[tuple[int, np.ndarray]]:
    """Where the marked pupils put the iris rings. Applied AFTER the warp,
    not through it (see the module docstring): an unmarked pupil is simply
    carried by the warp, like the skin around it."""
    if not marks_pupils(face_type):
        return []
    pairs: list[tuple[int, np.ndarray]] = []
    for ring, pupil in ((LEFT_IRIS, marks.left_pupil), (RIGHT_IRIS, marks.right_pupil)):
        if pupil is not None:
            pairs.extend(_iris_pairs(base, ring, pupil))
    return pairs


def catmull_rom(p0, p1, p2, p3, t: float) -> np.ndarray:
    """The uniform Catmull-Rom curve from p1 to p2 at `t` in [0, 1]: the
    curve the marking panel draws through the head's eight marks (as the
    Bezier segments this is equal to; features/avatars/face-marks.ts)."""
    p0, p1, p2, p3 = (np.asarray(p, dtype=np.float64) for p in (p0, p1, p2, p3))
    t2, t3 = t * t, t * t * t
    return 0.5 * (
        2 * p1
        + (p2 - p0) * t
        + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2
        + (3 * p1 - p0 - 3 * p2 + p3) * t3
    )


def _outline_pairs(base: np.ndarray, ring: np.ndarray) -> list[tuple[int, np.ndarray]]:
    """Every face-oval landmark between the head's eight marks, placed on
    the closed curve through `ring` (HEAD_OUTLINE order).

    Eight pinned points alone leave the 28 oval landmarks between them to
    the warp, and a toon's wide grin then pushes the cheek past a jaw corner
    marked where the face really turns (measured: one fold on the "toon big
    grin" layout, with the corners on the head's ellipse). Placed on the
    drawn curve instead, the mesh's edge is the outline the owner sees.

    Each landmark keeps its place along the curve between its two marks (by
    length along the base's oval) and its offset from the base's own curve,
    scaled with the head: a detection's oval is not exactly a Catmull-Rom
    curve, and marks left where they were detected must move nothing.
    """
    base_ring = base[HEAD_OUTLINE]

    def perimeter(r: np.ndarray) -> float:
        return float(np.linalg.norm(r - np.roll(r, -1, axis=0), axis=1).sum())

    scale = perimeter(ring) / max(perimeter(base_ring), 1e-9)
    n, k = len(FACE_OVAL), len(HEAD_OUTLINE)
    position = {i: FACE_OVAL.index(i) for i in HEAD_OUTLINE}
    pairs: list[tuple[int, np.ndarray]] = []
    for s in range(k):
        start, end = position[HEAD_OUTLINE[s]], position[HEAD_OUTLINE[(s + 1) % k]]
        chain = [FACE_OVAL[(start + j) % n] for j in range((end - start) % n + 1)]
        lengths = np.linalg.norm(np.diff(base[chain], axis=0), axis=1)
        along = np.cumsum(lengths) / max(float(lengths.sum()), 1e-9)
        quad = [(s - 1) % k, s, (s + 1) % k, (s + 2) % k]
        for i, t in zip(chain[1:-1], along[:-1]):
            on_base = catmull_rom(*base_ring[quad], float(t))
            on_marks = catmull_rom(*ring[quad], float(t))
            pairs.append((i, on_marks + (base[i] - on_base) * scale))
    return pairs


def correspondences(
    base: np.ndarray, marks: FaceMarks, face_type: str
) -> list[tuple[int, np.ndarray]]:
    """(landmark index, where it must go) for every landmark the warp pins.
    The pupils are not among them (`pupil_pairs`)."""
    carry = _head_carry(base, marks.head)
    pairs: list[tuple[int, np.ndarray]] = []

    def carried(indices) -> None:
        pairs.extend((i, np.asarray(carry(base[i]), dtype=np.float64)) for i in indices)

    def marked(idx: dict[str, int], region: RegionMarks, skip: tuple[str, ...] = ()) -> None:
        edges = [e for e in ("left", "right", "top", "bottom") if e not in skip]
        pairs.extend((idx[e], np.array(getattr(region, e))) for e in edges)

    line = marks_mouth_as_line(face_type)
    head = marks.head
    chin = marks.chin if line else None
    if head is not None:
        height = max(abs(head.bottom[1] - head.top[1]), 1.0)
        # A distinct chin takes 152; the head's bottom edge then only bounds
        # the head (a dog's jowls or ruff hang below its jaw, and no landmark
        # of a face mesh sits there).
        distinct_chin = chin is not None and math.dist(chin, head.bottom) > CHIN_MERGE * height
        if distinct_chin:
            marked(HEAD, head, skip=("bottom",))
            pairs.append((CHIN, np.array(chin)))
        else:
            marked(HEAD, head)
        # The outline between the edges, where it is marked; a diagonal left
        # out (marks from before there were any) rides with the warp.
        diagonals = head.diagonals()
        pairs.extend((HEAD_DIAGONALS[d], np.array(p)) for d, p in diagonals.items())
        if len(diagonals) == len(DIAGONALS):
            # The whole oval follows the curve the owner sees. Its bottom is
            # the chin where one is marked apart: the mesh ends at the jaw,
            # never at the ruff below it.
            ring = {e: getattr(head, e) for e in HEAD_OUTLINE_EDGES}
            if distinct_chin:
                ring["bottom"] = chin
            pairs.extend(_outline_pairs(base, np.array([ring[e] for e in HEAD_OUTLINE_EDGES])))
    else:
        carried([HEAD["left"], HEAD["right"], HEAD["top"]])
        if chin is not None:
            pairs.append((CHIN, np.array(chin)))
        else:
            carried([CHIN])

    for idx, region in ((LEFT_EYE, marks.left_eye), (RIGHT_EYE, marks.right_eye)):
        if region is not None:
            marked(idx, region)
        else:
            carried(idx.values())

    if line and marks.mouth_line is not None:
        pairs.extend(_mouth_line_pairs(base, marks.mouth_line, dict(pairs)))
    elif not line and marks.mouth is not None:
        marked(MOUTH, marks.mouth)
        if marks.mouth.center is not None:
            # The seam centre moves the seam and keeps its two lips' own
            # separation: pinning 13 and 14 to one point would close a mouth
            # that was photographed open.
            mid = (base[SEAM[0]] + base[SEAM[1]]) / 2
            center = np.array(marks.mouth.center)
            pairs += [(i, center + base[i] - mid) for i in SEAM]
    else:
        carried([*MOUTH.values(), *SEAM])
    return pairs


def warp(base: np.ndarray, pairs: list[tuple[int, np.ndarray]]) -> np.ndarray:
    """One thin-plate-spline warp of every base point, pinning `pairs`.

    Solved in coordinates normalised to the face, so SMOOTHING means the same
    on a 300px thumbnail and a 2000px photo.
    """
    # One target per landmark (a later pair for the same index wins), and
    # landmarks at the same base position share the average of their
    # targets — two identical rows would make the system singular.
    by_index = {i: np.asarray(p, dtype=np.float64) for i, p in pairs}
    grouped: dict[tuple[float, float], list[np.ndarray]] = {}
    for i, target in by_index.items():
        grouped.setdefault((float(base[i][0]), float(base[i][1])), []).append(target)
    src = np.array(list(grouped.keys()))
    dst = np.array([np.mean(targets, axis=0) for targets in grouped.values()])

    origin = base.min(axis=0)
    scale = max(float(np.ptp(base, axis=0).max()), 1.0)
    spline = RBFInterpolator(
        (src - origin) / scale, (dst - origin) / scale,
        kernel="thin_plate_spline", smoothing=SMOOTHING, degree=1,
    )
    return spline((base - origin) / scale) * scale + origin


# --- The validator --------------------------------------------------------------


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
    triangles = triangles[~np.isin(triangles, IRIS).any(axis=1)]
    before = _signed_areas(base, triangles)
    after = _signed_areas(fitted, triangles)
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
    steps = np.diff(np.append(angles, angles[0]))
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
        problems.append(FitProblem(
            "folded_mesh",
            f"{flips} triangle{'s' if flips != 1 else ''} of the face would fold over; "
            "move the marks so the eyes, mouth and head do not cross each other",
            flips,
        ))

    x, y = fitted[:, 0], fitted[:, 1]
    if y[LEFT_EYE["top"]] > y[LEFT_EYE["bottom"]] or y[RIGHT_EYE["top"]] > y[RIGHT_EYE["bottom"]]:
        problems.append(FitProblem(
            "lids_inverted", "An eye's top mark is below its bottom mark"
        ))
    order = [x[LEFT_EYE["left"]], x[LEFT_EYE["right"]], x[RIGHT_EYE["left"]], x[RIGHT_EYE["right"]]]
    if not all(a < b for a, b in zip(order, order[1:])):
        problems.append(FitProblem(
            "eyes_out_of_order",
            "The eye corners are out of order; each eye's left mark must be left of its right "
            "mark, and the left eye left of the right eye",
        ))
    if not x[MOUTH["left"]] < x[MOUTH["right"]]:
        problems.append(FitProblem(
            "mouth_reversed", "The mouth's left corner is right of its right corner"
        ))

    head = [HEAD["left"], HEAD["right"], HEAD["top"], HEAD["bottom"]]
    x0, x1 = float(x[head].min()), float(x[head].max())
    y0, y1 = float(y[head].min()), float(y[head].max())
    slack = HEAD_SLACK * max(x1 - x0, y1 - y0)
    features = [*LEFT_EYE.values(), *RIGHT_EYE.values(), *MOUTH.values(), *SEAM]
    outside = [
        i for i in features
        if not (x0 - slack <= x[i] <= x1 + slack and y0 - slack <= y[i] <= y1 + slack)
    ]
    if outside:
        problems.append(FitProblem(
            "outside_head", "The eyes and the mouth must be inside the head"
        ))

    # The head's eight marks are drawn as one closed curve; a curve that
    # crosses itself, or goes round the face out of order, is a head turned
    # inside out somewhere, whether or not a triangle there is big enough
    # for the fold count to see it.
    ring = fitted[HEAD_OUTLINE]
    if outline_crossed(ring):
        problems.append(FitProblem(
            "outline_crossed", "The head's outline crosses itself"
        ))
    elif not outline_in_order(base[HEAD_OUTLINE], ring):
        problems.append(FitProblem(
            "outline_out_of_order",
            "The head's outline points must go round the face in order: top, temple, side, "
            "jaw corner, chin, and back up the other side",
        ))

    # The fold count no longer sees the iris, so a pupil dragged onto the
    # cheek is caught here: its centre must lie within its eye's marks.
    def in_eye(iris: int, eye: dict[str, int]) -> bool:
        xs = [x[eye["left"]], x[eye["right"]]]
        ys = [y[eye["top"]], y[eye["bottom"]]]
        slack = EYE_SLACK * abs(xs[1] - xs[0])
        return (min(xs) - slack <= x[iris] <= max(xs) + slack
                and min(ys) - slack <= y[iris] <= max(ys) + slack)

    if pupils and not (in_eye(LEFT_IRIS[0], LEFT_EYE) and in_eye(RIGHT_IRIS[0], RIGHT_EYE)):
        problems.append(FitProblem(
            "pupil_outside_eye", "Each pupil's centre must be inside its eye"
        ))
    return problems


# --- The rig ----------------------------------------------------------------------


def fit_rig(
    rig: dict, base: np.ndarray, marks: FaceMarks, face_type: str
) -> tuple[dict, list[FitProblem]]:
    """The rig these marks make from `base`, and what is wrong with it.

    Everything that is not geometry (visemes, lip rings, crop origin) is
    carried over. The triangulation is redone on the fitted points: the
    base's triangles describe the base's shape, and on a face the fit has
    reshaped heavily they are no longer its best triangulation. The engine
    takes any triangle list, and the lip rings are index lists, still valid.
    """
    if marks_mouth_as_line(face_type):
        base = part_lips(base)
    pairs = correspondences(base, marks, face_type)
    fitted = warp(base, pairs)
    # Marked landmarks land exactly on their marks. The warp's smoothing
    # leaves them a hundredth of a pixel off, which is nothing — except where
    # several landmarks share one mark (the commissure on a mouth corner),
    # and that hundredth is then a sliver with an orientation of its own.
    for i, target in pairs + pupil_pairs(base, marks, face_type):
        fitted[i] = target
    fitted = np.round(fitted, 2)
    problems = validate(base, fitted, pupils=marks_pupils(face_type))

    triangles = Delaunay(fitted).simplices
    if marks_mouth_as_line(face_type):
        # Qhull keeps one landmark of each corner's coincident four, which
        # one depending on the layout; every corner is drawn with the same.
        remap = np.arange(len(fitted))
        remap[list(LINE_CORNERS)] = list(LINE_CORNERS.values())
        triangles = remap[triangles]
    out = dict(rig)
    out["points"] = fitted.tolist()
    out["triangles"] = triangles.tolist()
    out["face_box"] = [float(fitted[:, 0].min()), float(fitted[:, 1].min()),
                       float(fitted[:, 0].max()), float(fitted[:, 1].max())]
    # Marks come from the owner's hands by definition here, whatever the
    # client claims: later lines will store detector-sourced marks too, and
    # only these may count as confirmed.
    out["user_anchors"] = {**marks_to_dict(marks), "source": "owner"}
    profile = render_profile_for(face_type)
    if profile:
        out["render_profile"] = profile
    else:
        out.pop("render_profile", None)
    return out, problems


# --- The stored base ------------------------------------------------------------

FIT_BASE_VERSION = 1


def fit_base_key(org_id: str, avatar_id: str) -> str:
    return f"orgs/{org_id}/avatars/{avatar_id}/fit-base.json"


def fit_base_record(points: np.ndarray, rig: dict, detected: bool) -> dict:
    """The base mesh, stamped with the frame of the rig it belongs to."""
    return {
        "version": FIT_BASE_VERSION,
        "image_size": list(rig["image_size"]),
        "crop_origin": rig.get("crop_origin"),
        "detected": bool(detected),
        "points": [[round(float(px), 3), round(float(py), 3)] for px, py in points],
    }


def fit_base_points(record: dict | None, rig: dict) -> np.ndarray | None:
    """The base's points, if `record` is a base for this rig's frame."""
    if not record or record.get("version") != FIT_BASE_VERSION:
        return None
    if list(record.get("image_size") or []) != list(rig["image_size"]):
        return None
    if record.get("crop_origin") != rig.get("crop_origin"):
        return None
    points = np.array(record.get("points") or [], dtype=np.float64)
    return points if points.shape == (NUM_POINTS, 2) else None


def move_fit_base(record: dict, left: float, top: float, rig: dict) -> dict:
    """The base for `rig`, whose image's top-left sits at (left, top) of the
    image the base was taken in — a crop, or with a negative origin, the crop
    undone. Exactly what crop does to the rig itself."""
    moved = dict(record)
    moved["points"] = [[round(px - left, 3), round(py - top, 3)] for px, py in record["points"]]
    moved["image_size"] = list(rig["image_size"])
    moved["crop_origin"] = rig.get("crop_origin")
    return moved


async def read_fit_base(storage, key: str) -> dict | None:
    try:
        if not await storage.exists(key):
            return None
        return json.loads(await storage.get_bytes(key))
    except Exception:
        # A base is always rebuildable from the photo; an unreadable one is
        # treated as missing rather than blocking the owner's fit.
        logger.exception("unreadable fit base %s", key)
        return None


async def write_fit_base(storage, key: str, record: dict) -> None:
    await storage.put_bytes(key, json.dumps(record).encode(), "application/json")
