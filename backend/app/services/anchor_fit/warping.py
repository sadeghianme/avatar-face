"""The warp: every mark turned into landmark targets (the mouth on its
line, the pupils as one piece, the head on its outline), and the one
thin-plate-spline warp that moves the base mesh onto them."""

from __future__ import annotations

import math

import numpy as np
from scipy.interpolate import RBFInterpolator

from app.services.anchor_fit.marks import (
    FaceMarks,
    PupilMarks,
    RegionMarks,
)
from app.services.anchor_fit.scheme import (
    CHIN,
    CHIN_MERGE,
    DIAGONALS,
    FACE_OVAL,
    HEAD,
    HEAD_DIAGONALS,
    HEAD_OUTLINE,
    HEAD_OUTLINE_EDGES,
    INNER_LOWER,
    INNER_UPPER,
    LEFT_COMMISSURE,
    LEFT_EYE,
    LEFT_IRIS,
    LIP_ROWS_LOWER,
    LIP_ROWS_UPPER,
    MOUTH,
    RIGHT_COMMISSURE,
    RIGHT_EYE,
    RIGHT_IRIS,
    SEAM,
    SEAM_GAP,
    SMOOTHING,
    TEAR_NEAR,
    TEAR_SLACK,
    TEAR_STRETCH,
    Point,
    marks_mouth_as_line,
    marks_pupils,
)


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
    seg_normal = (
        np.stack((seg_vec[:, 1], -seg_vec[:, 0]), axis=1) / np.maximum(seg_len, 1e-9)[:, None]
    )
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


def pupil_pairs(base: np.ndarray, marks: FaceMarks, face_type: str) -> list[tuple[int, np.ndarray]]:
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
            b0, b1, b2, b3 = base_ring[quad]
            m0, m1, m2, m3 = ring[quad]
            on_base = catmull_rom(b0, b1, b2, b3, float(t))
            on_marks = catmull_rom(m0, m1, m2, m3, float(t))
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


def _torn_apart(src: np.ndarray, dst: np.ndarray, scale: float) -> tuple[np.ndarray, np.ndarray]:
    """The warp's control points with each group that starts together but
    is pulled apart made one point, at the group's mean.

    A smooth map cannot separate points that start on top of each other,
    and a thin-plate spline made to bends everything around them: a shut
    eye's lids are detected within a pixel of each other, and its top mark
    nudged 3 px down moved the face 85 px and folded 50 to 180 of its
    triangles. Pins closer than TEAR_NEAR of the face whose targets part
    TEAR_STRETCH times further than that (and TEAR_SLACK of the face more)
    are those; the fit still puts each landmark on its own mark after the
    warp, and the folds left around it are small enough to smooth. Pins
    that move together, however close (a mouth line's parted lips, a
    commissure's four), are untouched.
    """
    near, slack = TEAR_NEAR * scale, TEAR_SLACK * scale
    count = len(src)
    parent = list(range(count))

    def root(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    torn = False
    for a in range(count):
        apart = np.linalg.norm(src[a + 1 :] - src[a], axis=1)
        for k in np.flatnonzero(apart < near):
            b = a + 1 + int(k)
            if np.linalg.norm(dst[b] - dst[a]) > TEAR_STRETCH * apart[k] + slack:
                parent[root(b)] = root(a)
                torn = True
    if not torn:
        return src, dst
    groups: dict[int, list[int]] = {}
    for i in range(count):
        groups.setdefault(root(i), []).append(i)
    members = list(groups.values())
    return (
        np.array([src[g].mean(axis=0) for g in members]),
        np.array([dst[g].mean(axis=0) for g in members]),
    )


def warp(base: np.ndarray, pairs: list[tuple[int, np.ndarray]], tear: bool = False) -> np.ndarray:
    """One thin-plate-spline warp of every base point, pinning `pairs`.

    Solved in coordinates normalised to the face, so SMOOTHING means the same
    on a 300px thumbnail and a 2000px photo. With `tear`, pins that start
    together but are pulled apart are one control point (`_torn_apart`):
    the fit asks for that only when the plain warp folds, so a fit that
    passes is the same rig it always was.
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
    if tear:
        src, dst = _torn_apart(src, dst, scale)
    spline = RBFInterpolator(
        (src - origin) / scale,
        (dst - origin) / scale,
        kernel="thin_plate_spline",
        smoothing=SMOOTHING,
        degree=1,
    )
    return spline((base - origin) / scale) * scale + origin
