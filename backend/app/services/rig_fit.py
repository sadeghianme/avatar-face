"""Rewrite a rig from anchors the user placed by hand.

Every landmark the engine trusts comes from MediaPipe, which fits a *human*
face template. On stylized art that template lands in the wrong place and at
the wrong size — measured on one anime avatar, the detected eye opening was
35px tall inside a drawn eye whose iris alone was 27px in radius. Everything
downstream inherits that error: the blink sweeps to the wrong lid, the mouth
aperture is cut on the wrong seam, the gaze patch repaints the wrong disc.

No amount of tuning fixes a bad measurement, so this lets the user state the
measurement directly: drag the edges of the mouth, each eye and the head onto
where they actually are. Each region is then fitted independently, because the
error is not uniform — a cartoon can have a correctly-placed mouth and eyes
twice the size the detector believed.

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

# Below this the anchors have collapsed onto each other and the implied scale
# is meaningless — leave that axis alone rather than divide by ~0.
MIN_SPAN_PX = 2.0
# A correction this large is a mis-drag, not a measurement.
MAX_SCALE = 6.0
MIN_SCALE = 1.0 / MAX_SCALE


@dataclass
class BoxAnchors:
    """Where the user says a region's four edges are."""

    left: float
    right: float
    top: float
    bottom: float

    @property
    def width(self) -> float:
        return self.right - self.left

    @property
    def height(self) -> float:
        return self.bottom - self.top

    @property
    def center(self) -> tuple[float, float]:
        return ((self.left + self.right) / 2, (self.top + self.bottom) / 2)


def _bounds(points: list[list[float]], indices: list[int]) -> tuple[float, float, float, float]:
    xs = [points[i][0] for i in indices]
    ys = [points[i][1] for i in indices]
    return min(xs), max(xs), min(ys), max(ys)


def _clamp_scale(value: float) -> float:
    return max(MIN_SCALE, min(MAX_SCALE, value))


def _fit_box(
    points: list[list[float]],
    indices: list[int],
    target: BoxAnchors,
    center_override: tuple[float, float] | None = None,
) -> None:
    """Map a region's current bounding box onto `target`, in place.

    Scale is per-axis on purpose. A single uniform factor cannot express the
    common case — a mouth detected too narrow but the right height — and
    forcing one would trade a width error for a height error.
    """
    if not indices:
        return
    x0, x1, y0, y1 = _bounds(points, indices)
    cur_w, cur_h = x1 - x0, y1 - y0
    cur_cx, cur_cy = (x0 + x1) / 2, (y0 + y1) / 2

    # A collapsed axis carries no scale information; keep 1.0 and just move.
    sx = _clamp_scale(target.width / cur_w) if cur_w >= MIN_SPAN_PX and target.width > 0 else 1.0
    sy = _clamp_scale(target.height / cur_h) if cur_h >= MIN_SPAN_PX and target.height > 0 else 1.0
    tx, ty = center_override if center_override else target.center

    for i in indices:
        points[i][0] = tx + (points[i][0] - cur_cx) * sx
        points[i][1] = ty + (points[i][1] - cur_cy) * sy


def apply_anchors(
    rig: dict,
    *,
    head: BoxAnchors | None = None,
    left_eye: BoxAnchors | None = None,
    right_eye: BoxAnchors | None = None,
    mouth: BoxAnchors | None = None,
    mouth_center: tuple[float, float] | None = None,
) -> dict:
    """Return a copy of `rig` with the user's anchors applied.

    Order matters. The head fit moves every point, so it runs first and the
    local regions are then measured against the already-corrected positions —
    otherwise a head correction would silently undo the eye and mouth ones.
    """
    points = [[float(x), float(y)] for x, y in rig["points"]]
    all_indices = list(range(len(points)))

    if head is not None:
        _fit_box(points, all_indices, head)

    if left_eye is not None:
        _fit_box(points, _present(LEFT_EYE_INDICES, points), left_eye)
    if right_eye is not None:
        _fit_box(points, _present(RIGHT_EYE_INDICES, points), right_eye)

    if mouth is not None:
        mouth_indices = _present(rig.get("mouth_indices", []), points)
        # The centre anchor is optional and overrides the box centre: it lets
        # the user say "the mouth is this wide, but sits here", which a box
        # alone cannot express when the corners are asymmetric.
        _fit_box(points, mouth_indices, mouth, center_override=mouth_center)

    out = dict(rig)
    out["points"] = [[round(x, 2), round(y, 2)] for x, y in points]
    xs = [p[0] for p in out["points"]]
    ys = [p[1] for p in out["points"]]
    out["face_box"] = [min(xs), min(ys), max(xs), max(ys)]
    return out


def _present(indices: list[int], points: list[list[float]]) -> list[int]:
    """Indices that actually exist — the synthetic fallback mesh is shorter
    than MediaPipe's 478, and would otherwise raise on the iris points."""
    return [i for i in indices if 0 <= i < len(points)]


def current_anchors(rig: dict) -> dict:
    """Where the detector currently thinks each region's edges are.

    The UI opens with the handles already on these, so the user corrects a
    detection rather than marking a face from scratch — on a photo where the
    detection is good, that means dragging nothing.
    """
    points = [[float(x), float(y)] for x, y in rig["points"]]

    def box(indices: list[int]) -> dict | None:
        present = _present(indices, points)
        if not present:
            return None
        x0, x1, y0, y1 = _bounds(points, present)
        return {"left": x0, "right": x1, "top": y0, "bottom": y1}

    mouth_indices = _present(rig.get("mouth_indices", []), points)
    mouth_center = None
    if mouth_indices:
        # The BOX centre, not the centroid of the lip points. They differ by
        # ~0.6px on a real ring, and `_fit_box` re-centres on the box — so
        # returning the centroid would make "open the panel and save without
        # dragging" drift the rig slightly. Opening and saving must be exact.
        x0, x1, y0, y1 = _bounds(points, mouth_indices)
        mouth_center = {"x": (x0 + x1) / 2, "y": (y0 + y1) / 2}

    return {
        "head": box(list(range(len(points)))),
        "left_eye": box(LEFT_EYE_INDICES),
        "right_eye": box(RIGHT_EYE_INDICES),
        "mouth": box(mouth_indices),
        "mouth_center": mouth_center,
    }
