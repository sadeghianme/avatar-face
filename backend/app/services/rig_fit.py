"""Rewrite a rig from anchors the user placed by hand.

Every landmark the engine trusts comes from MediaPipe, which fits a *human*
face template. On stylized art that template lands in the wrong place and at
the wrong size, and everything downstream inherits the error: the blink sweeps
to the wrong lid, the mouth aperture is cut on the wrong seam, the gaze patch
repaints the wrong disc. No amount of tuning fixes a bad measurement, so this
lets the user state the measurement directly.

Two things make this harder than moving the marked landmarks:

1. The points are a TRIANGULATION, not independent markers. Moving a cluster
   and leaving its neighbours behind tears the mesh at the boundary — measured
   on a 1.5x eye correction, eye points moved up to 32px while the socket ring
   one triangle away moved 0, so those bridging triangles stretched 32px along
   one edge and nothing along the other. That seam renders as a visible layer
   over the eye, and the blink then sweeps skin across it. So every correction
   is applied as a WARP with a smooth falloff: the marked region moves fully,
   the surrounding face follows and fades out, and no edge is ever
   discontinuous.

2. Faces are not axis-aligned boxes. A mouth's corners sit on a curve and are
   rarely level with each other, and a tilted eye has no meaningful "top".
   Each region is therefore marked as four or five FREE 2D points, and the
   local transform is a least-squares affine fit over those correspondences —
   which carries rotation and shear, so a curved or tilted mouth is expressible
   where a bounding box was not.

Anchors are in ORIGINAL-image pixels, the same space `rig["points"]` uses, so
what the user sees while dragging is the space the correction is applied in.
"""

from __future__ import annotations

from dataclasses import dataclass

# Lids + iris, per eye. Moving an eye means moving all of it: the lid ring
# defines the blink sweep and the aperture, the iris defines gaze.
LEFT_EYE_INDICES = [
    33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246,
    468, 469, 470, 471, 472,
]
RIGHT_EYE_INDICES = [
    263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466,
    473, 474, 475, 476, 477,
]

# The iris ring alone: center then four rim points. Correctable on its own
# because on stylised art MediaPipe's iris guess is the least reliable part of
# the detection, and the engine's gaze circle is built directly from these.
LEFT_IRIS_INDICES = [468, 469, 470, 471, 472]
RIGHT_IRIS_INDICES = [473, 474, 475, 476, 477]

# How far past the marked region the warp keeps blending, as a multiple of the
# region's own radius. 2.0 gives a blend band exactly as wide as the region
# itself: gentle enough that no triangle is strained at the boundary, tight
# enough that correcting the mouth does not drag the eyes — on a real face the
# eyes sit about three mouth-radii away, outside this.
FALLOFF_RADIUS = 2.0
# A correction beyond this is a mis-drag, not a measurement.
MAX_SCALE = 6.0
MIN_SCALE = 1.0 / MAX_SCALE

Point = tuple[float, float]


@dataclass
class RegionMarks:
    """Where the user says a region's extremes are, as free 2D points.

    `center` is optional and only meaningful for the mouth, where it lets the
    user place the middle of the lips independently of the corners.
    """

    left: Point
    right: Point
    top: Point
    bottom: Point
    center: Point | None = None

    def pairs(self) -> list[Point]:
        pts = [self.left, self.right, self.top, self.bottom]
        if self.center is not None:
            pts.append(self.center)
        return pts


@dataclass
class PupilMarks:
    """Where the user says a pupil is: its center, and one point on its rim.

    Two points instead of four extremes because a pupil is a circle — center
    fixes position, rim fixes radius, and there is no rotation to express.
    """

    center: Point
    rim: Point


def _solve3(a: list[list[float]], b: list[float]) -> list[float] | None:
    """Gaussian elimination on a 3x3 system. None if singular."""
    m = [row[:] + [b[i]] for i, row in enumerate(a)]
    for col in range(3):
        pivot = max(range(col, 3), key=lambda r: abs(m[r][col]))
        if abs(m[pivot][col]) < 1e-9:
            return None
        m[col], m[pivot] = m[pivot], m[col]
        for r in range(3):
            if r == col:
                continue
            f = m[r][col] / m[col][col]
            for c in range(col, 4):
                m[r][c] -= f * m[col][c]
    return [m[i][3] / m[i][i] for i in range(3)]


def _fit_affine(src: list[Point], dst: list[Point]) -> tuple[float, ...] | None:
    """Least-squares affine mapping src -> dst: (a, b, tx, c, d, ty).

    Affine rather than a box scale because a face is not axis-aligned: this
    carries rotation and shear, so a mouth whose corners sit at different
    heights maps onto a mouth whose corners sit at different heights.
    """
    if len(src) < 3:
        return None
    sxx = sum(p[0] * p[0] for p in src)
    sxy = sum(p[0] * p[1] for p in src)
    syy = sum(p[1] * p[1] for p in src)
    sx = sum(p[0] for p in src)
    sy = sum(p[1] for p in src)
    n = float(len(src))
    normal = [[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, n]]

    out: list[float] = []
    for axis in (0, 1):
        rhs = [
            sum(s[0] * d[axis] for s, d in zip(src, dst)),
            sum(s[1] * d[axis] for s, d in zip(src, dst)),
            sum(d[axis] for d in dst),
        ]
        row = _solve3(normal, rhs)
        if row is None:
            return None
        out.extend(row)
    return tuple(out)


def _bounded(transform: tuple[float, ...]) -> bool:
    """Reject a transform that scales absurdly or mirrors the region."""
    a, b, _, c, d, _ = transform
    det = a * d - b * c
    if det <= 0:  # a mirrored region is always a mis-drag
        return False
    scale = abs(det) ** 0.5
    return MIN_SCALE <= scale <= MAX_SCALE


def _extremes(points: list[list[float]], indices: list[int]) -> RegionMarks:
    """The region's current extreme points, as the user's handles would sit."""
    left = min(indices, key=lambda i: points[i][0])
    right = max(indices, key=lambda i: points[i][0])
    top = min(indices, key=lambda i: points[i][1])
    bottom = max(indices, key=lambda i: points[i][1])
    xs = [points[i][0] for i in indices]
    ys = [points[i][1] for i in indices]
    return RegionMarks(
        left=(points[left][0], points[left][1]),
        right=(points[right][0], points[right][1]),
        top=(points[top][0], points[top][1]),
        bottom=(points[bottom][0], points[bottom][1]),
        center=((min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2),
    )


def _smoothstep(t: float) -> float:
    t = max(0.0, min(1.0, t))
    return t * t * (3 - 2 * t)


def _warp(
    points: list[list[float]],
    indices: list[int],
    marks: RegionMarks,
    *,
    falloff: bool,
) -> None:
    """Apply the user's correction for one region, in place.

    Every point in the mesh is displaced, not just the region's own: full
    weight inside the region, smoothly fading to nothing by FALLOFF_RADIUS.
    That continuity is the whole point — a hard cluster edit tears the
    triangles that bridge the region to the rest of the face.
    """
    if not indices:
        return
    current = _extremes(points, indices)
    src = current.pairs()
    dst = marks.pairs()
    if marks.center is None:
        src, dst = src[:4], dst[:4]
    if len(src) != len(dst):
        return
    # Extreme points can coincide — on a nearly flat region the leftmost and
    # topmost landmark are the same one. Feeding the same source twice with
    # two different destinations makes the fit ill-conditioned and produces a
    # wild transform, which is exactly how a small correction ends up moving
    # the whole face. Drop duplicates and fall back if too few remain.
    seen: list[Point] = []
    kept_src: list[Point] = []
    kept_dst: list[Point] = []
    for s_pt, d_pt in zip(src, dst):
        if any(abs(s_pt[0] - q[0]) < 1e-6 and abs(s_pt[1] - q[1]) < 1e-6 for q in seen):
            continue
        seen.append(s_pt)
        kept_src.append(s_pt)
        kept_dst.append(d_pt)
    if len(kept_src) < 3:
        return
    transform = _fit_affine(kept_src, kept_dst)
    if transform is None or not _bounded(transform):
        return
    a, b, tx, c, d, ty = transform

    # The falloff is scaled by the REGION's own extent, measured over all of
    # its points rather than the handful of marked extremes: it is a property
    # of the thing being corrected, not of how the user happened to drag.
    cx = sum(points[i][0] for i in indices) / len(indices)
    cy = sum(points[i][1] for i in indices) / len(indices)
    radius = max(
        1.0,
        max(((points[i][0] - cx) ** 2 + (points[i][1] - cy) ** 2) ** 0.5 for i in indices),
    )
    outer = radius * FALLOFF_RADIUS

    for i in range(len(points)):
        x, y = points[i]
        if falloff:
            dist = ((x - cx) ** 2 + (y - cy) ** 2) ** 0.5
            # 1 inside the region, easing to 0 at the outer radius.
            weight = 1.0 if dist <= radius else _smoothstep((outer - dist) / (outer - radius))
            if weight <= 0.0:
                continue
        else:
            weight = 1.0
        points[i][0] = x + ((a * x + b * y + tx) - x) * weight
        points[i][1] = y + ((c * x + d * y + ty) - y) * weight


def _warp_pupil(points: list[list[float]], indices: list[int], marks: PupilMarks) -> None:
    """Move an iris ring to the user's circle: translate + uniform scale.

    A hard cluster edit, no falloff — the iris points are not vertices of the
    face triangulation (the engine reads them only to place the gaze circle),
    so moving them alone cannot tear anything.
    """
    if len(indices) != 5:
        return
    c = points[indices[0]]
    ring = [points[i] for i in indices[1:]]
    old_r = sum(((p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2) ** 0.5 for p in ring) / 4
    new_r = ((marks.rim[0] - marks.center[0]) ** 2 + (marks.rim[1] - marks.center[1]) ** 2) ** 0.5
    if old_r < 0.5 or new_r < 0.5:
        return
    scale = new_r / old_r
    if not (MIN_SCALE <= scale <= MAX_SCALE):
        return
    cx, cy = c[0], c[1]
    for i in indices:
        points[i][0] = marks.center[0] + (points[i][0] - cx) * scale
        points[i][1] = marks.center[1] + (points[i][1] - cy) * scale


def _present(indices: list[int], points: list[list[float]]) -> list[int]:
    """Indices that actually exist — the synthetic fallback mesh is shorter
    than MediaPipe's 478 and has no iris points."""
    return [i for i in indices if 0 <= i < len(points)]


def apply_anchors(
    rig: dict,
    *,
    head: RegionMarks | None = None,
    left_eye: RegionMarks | None = None,
    right_eye: RegionMarks | None = None,
    mouth: RegionMarks | None = None,
    left_pupil: PupilMarks | None = None,
    right_pupil: PupilMarks | None = None,
) -> dict:
    """Return a copy of `rig` with the user's anchors applied.

    The head fit runs first and moves every point uniformly; the local fits
    then measure against those corrected positions, so a head correction
    cannot silently undo an eye or mouth one. Pupils go last for the same
    reason — they are placed relative to the corrected eye.
    """
    points = [[float(x), float(y)] for x, y in rig["points"]]

    if head is not None:
        _warp(points, list(range(len(points))), head, falloff=False)
    if left_eye is not None:
        _warp(points, _present(LEFT_EYE_INDICES, points), left_eye, falloff=True)
    if right_eye is not None:
        _warp(points, _present(RIGHT_EYE_INDICES, points), right_eye, falloff=True)
    if mouth is not None:
        _warp(points, _present(rig.get("mouth_indices", []), points), mouth, falloff=True)
    if left_pupil is not None and len(_present(LEFT_IRIS_INDICES, points)) == 5:
        _warp_pupil(points, LEFT_IRIS_INDICES, left_pupil)
    if right_pupil is not None and len(_present(RIGHT_IRIS_INDICES, points)) == 5:
        _warp_pupil(points, RIGHT_IRIS_INDICES, right_pupil)

    out = dict(rig)
    out["points"] = [[round(x, 2), round(y, 2)] for x, y in points]
    xs = [p[0] for p in out["points"]]
    ys = [p[1] for p in out["points"]]
    out["face_box"] = [min(xs), min(ys), max(xs), max(ys)]
    return out


def current_anchors(rig: dict) -> dict:
    """Where each region's handles should open.

    A saved marking is returned VERBATIM from `rig["user_anchors"]` — the
    warped mesh's extremes are not where the user dropped the handles,
    because regions interact (a mouth correction drags the chin through the
    falloff, which moves where "head bottom" lands). Only regions the user
    never marked fall back to the detector's extremes.
    """
    points = [[float(x), float(y)] for x, y in rig["points"]]
    saved = rig.get("user_anchors") or {}

    def marks(indices: list[int], with_center: bool) -> dict | None:
        present = _present(indices, points)
        if not present:
            return None
        e = _extremes(points, present)
        out = {
            "left": {"x": e.left[0], "y": e.left[1]},
            "right": {"x": e.right[0], "y": e.right[1]},
            "top": {"x": e.top[0], "y": e.top[1]},
            "bottom": {"x": e.bottom[0], "y": e.bottom[1]},
        }
        if with_center and e.center is not None:
            out["center"] = {"x": e.center[0], "y": e.center[1]}
        return out

    def pupil(indices: list[int]) -> dict | None:
        present = _present(indices, points)
        if len(present) != 5:
            return None
        c = points[indices[0]]
        ring = [points[i] for i in indices[1:]]
        r = sum(((p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2) ** 0.5 for p in ring) / 4
        r = max(r, 2.0)
        return {
            "center": {"x": c[0], "y": c[1]},
            "rim": {"x": c[0] + r, "y": c[1]},
        }

    computed = {
        "head": marks(list(range(len(points))), False),
        "left_eye": marks(LEFT_EYE_INDICES, False),
        "right_eye": marks(RIGHT_EYE_INDICES, False),
        "mouth": marks(_present(rig.get("mouth_indices", []), points), True),
        "left_pupil": pupil(LEFT_IRIS_INDICES),
        "right_pupil": pupil(RIGHT_IRIS_INDICES),
    }
    return {k: saved.get(k) or v for k, v in computed.items()}
