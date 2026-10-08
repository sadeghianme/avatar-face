"""2b. Registering an answer: what the model moved, added to the confirmed
points, unless the drift and shape gates refuse it."""

from __future__ import annotations

import io
import logging
import math
from collections.abc import Callable
from dataclasses import dataclass, field

import numpy as np
from PIL import Image

from app.services import photo_adjust
from app.services.performance_kit.constants import (
    FACE_LEFT,
    FACE_RIGHT,
    LOWER_INNER,
    MOUTH_LEFT,
    MOUTH_RIGHT,
    NOSE_TIP,
    TEETH,
    UPPER_INNER,
)
from app.services.performance_kit.registration import (
    MAX_REGISTRATION_RMS,
    ManifestFrame,
    MirroredPose,
    registration_rms,
    similarity_on_anchors,
)
from app.services.performance_kit.requests import PoseRequest

logger = logging.getLogger("liveface.performance_kit")

# Drift guards, measured on the Reference's six poses (registered, as a
# fraction of the face width, 234 to 454) and set with a wide margin:
#   head scale 0.997-1.016 and rotation under 0.4 degrees before registration;
#   nose (tip and bridge) at most 0.019 face widths; eye outlines 0.007 on
#   average; the nose tip's offset between the cheeks changed by 0.013;
#   cheek colour delta E (lightness at half weight) 0.2 to 2.9.
MAX_SCALE_CHANGE = 0.10
MAX_ROTATION_DEGREES = 4.0
NOSE_GUARD = [1, 4, 5, 6, 168, 195, 197, 45, 275]
MAX_NOSE_SHIFT = 0.03
# fmt: off
EYE_GUARD = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246,
             362, 382, 381, 380, 374, 373, 390, 249, 263, 466, 388, 387, 386, 385, 384, 398]
# fmt: on
MAX_EYE_SHIFT = 0.015
MAX_YAW_CHANGE = 0.08
# Tighter than a regenerate's 12: a pose asks for no relighting at all.
MAX_POSE_SKIN_DELTA_E = 8.0
# An answer whose width over height differs from what was sent by more
# than this was reframed, not edited (see head_square). JPEG and the
# model's own sizes round a square to within a pixel or two of 1024.
MAX_ASPECT_CHANGE = 0.01

# Did the answer make the shape it was asked for, and no more than speech
# does? Its OPENING (the lip gap, 13 to 14, less the rest's own: lips
# parted at rest are the portrait, not the shape's movement) and its
# corner-to-corner width, in rest mouth widths, after registration.
#
# The Reference's own openings (tests: equal to the bundled motion's); its
# widths: EE 1.05, OO 0.52, OH 0.73.
REFERENCE_OPENINGS: dict[str, float] = {
    "aa": 0.290,
    "ee": 0.165,
    "oo": 0.122,
    "oh": 0.308,
    "fv": 0.096,
    "th": 0.203,
}
# How much further than the Reference's a shape may open AT THE KIT'S SIZE,
# once normalize_amplitude has put this face's AA where the Reference's is.
# The first run on real Gemini (@1 prompts) came back 1.6 to 2.0 times the
# Reference's for TH, F/V and EE (and AA at 2.2 to 2.5); played, an
# over-open TH opens every t, d, n and k as wide as "ah" (the continuous
# mouth plays TH for them), and an over-open EE every "ih", "e" and "s".
# The second (@3 prompts, 2026-09-26) came back 0.7 to 1.45 times raw and
# 0.6 to 1.31 at the kit's size: its F/V at 1.31 shows a millimetre more
# tooth than the Reference's, not an "ah", and was refused at 1.3.
MAX_OVER_REFERENCE = 1.4
# Before that size is known an answer is held only to what no speech sound
# reaches, twice the Reference's own opening of the shape: the model acts
# every shape alike (that run's AA, OH and F/V all came back about a tenth
# too open), so a shape is judged against the Reference's at the kit's
# size, not as the model drew it. The AA, which sets the size, is held to
# MAX_OVER_REFERENCE as drawn.
RAW_MAX_OVER_REFERENCE = 2.0
# The AA sets the kit's scale (normalize_amplitude): one opening less than
# this much of the Reference's would be scaled up with every other shape
# more than 1.7 times; one that little is not an "ah" anyway.
MIN_AA_OF_REFERENCE = 0.6
# The least a shape must open, or be as wide: enough to refuse a closed
# mouth, never enough to force the Reference's exact look on another face.
_FLOORS: dict[str, dict[str, float]] = {
    "aa": {"min_opening": round(MIN_AA_OF_REFERENCE * REFERENCE_OPENINGS["aa"], 3)},
    # An "ee" spreads the lips from a neutral mouth (the Reference's to 1.05
    # of its rest); a portrait that already smiles has little spread left:
    # the second real run's relaxed "ee" came back 0.96 of a smiling rest.
    # 0.94 still refuses a rounded mouth (an OH is at most 0.92, an OO 0.85).
    "ee": {"min_opening": 0.05, "min_width": 0.94},
    # An "oo" rounds the lips around a small opening. The second real run's
    # came back with a third of the Reference's (0.041): rendered on the
    # engine, a pressed pout that reads as "mm". Half the Reference's is the
    # least that still reads as a rounded vowel.
    "oo": {"min_opening": 0.06, "max_width": 0.85},
    "oh": {"min_opening": 0.12, "max_width": 0.92},
    "fv": {},
    "th": {"min_opening": 0.05},
}


def _raw_limit(shape: str) -> float:
    """How many times the Reference's opening an answer may open as drawn."""
    return MAX_OVER_REFERENCE if shape == "aa" else RAW_MAX_OVER_REFERENCE


POSE_LIMITS: dict[str, dict[str, float]] = {
    shape: {**floors, "max_opening": round(_raw_limit(shape) * REFERENCE_OPENINGS[shape], 3)}
    for shape, floors in _FLOORS.items()
}
# The least lip gap, in its own mouth widths, of an answer to the teeth
# request: the mouth-photo upload's own threshold (portrait_photo
# .prepare_photo). It must then also pass the embed's own test
# (fit_profile, dental_photo).
TEETH_PHOTO_MIN_GAP = 0.08

Detector = Callable[[Image.Image], "np.ndarray | None"]


@dataclass
class PoseRegistration:
    """One answer, registered onto the base photo, or why it was refused."""

    shape: str
    targets: np.ndarray | None = None  # (478, 2) base pixels
    rms: float | None = None  # manifest units
    reason: dict | None = None
    checks: dict = field(default_factory=dict)
    answer_points: np.ndarray | None = None  # (478, 2) answer pixels
    answer_size: tuple[int, int] | None = None
    answer_image: Image.Image | None = None

    @property
    def ok(self) -> bool:
        return self.reason is None and self.targets is not None


def _reason(code: str, detail: str) -> dict:
    return {"code": code, "detail": detail}


def _mouth_width(points: np.ndarray) -> float:
    """Corner to corner (61 to 291)."""
    return float(np.linalg.norm(points[MOUTH_RIGHT] - points[MOUTH_LEFT]))


def _gap_and_width(points: np.ndarray, rest_width: float) -> tuple[float, float]:
    gap = float(np.linalg.norm(points[UPPER_INNER] - points[LOWER_INNER])) / rest_width
    return gap, _mouth_width(points) / rest_width


def opening(points: np.ndarray, rest: np.ndarray) -> float:
    """How far `points` open the lips beyond `rest`: how much further apart
    the middles of the inner lips (13, 14) are, down the face (across the
    rest's corner line), in rest mouth widths. A portrait with its lips
    parted opens only by what the shape adds to that; and it is linear in
    the movement, so a shape moved twice as far opens twice as much (the
    scale normalize_amplitude finds is then exact)."""
    down, width = _down(rest)
    moved = (points[LOWER_INNER] - points[UPPER_INNER]) - (rest[LOWER_INNER] - rest[UPPER_INNER])
    return float(moved @ down) / width


def signed_yaw(points: np.ndarray) -> float:
    """Where the nose tip is between the cheeks (234, 454), signed: 0
    frontal, +1 at the image-right cheek, -1 at the left. photo_adjust's
    yaw_offset is its absolute value, which cannot tell a head turned a
    little one way from the same turn the other way: compared unsigned, a
    base at +0.05 and an answer at -0.05 are "unchanged"."""
    left, right = points[FACE_LEFT][0], points[FACE_RIGHT][0]
    half = abs(right - left) / 2
    if half <= 0:
        return 1.0
    return float((points[NOSE_TIP][0] - (left + right) / 2) / half)


def _shape_reached(shape: str, opened: float, width: float) -> str | None:
    limits = POSE_LIMITS[shape]
    if opened < limits.get("min_opening", -math.inf):
        return f"the lips parted {opened:.2f} mouth widths, less than {limits['min_opening']}"
    if opened > limits["max_opening"]:
        return (
            f"the lips parted {opened:.2f} mouth widths, more than {limits['max_opening']} "
            f"({_raw_limit(shape)} times the Reference's)"
        )
    if width < limits.get("min_width", -math.inf):
        return f"the mouth is {width:.2f} of its rest width, narrower than {limits['min_width']}"
    if width > limits.get("max_width", math.inf):
        return f"the mouth is {width:.2f} of its rest width, wider than {limits['max_width']}"
    return None


def _teeth_shown(points: np.ndarray) -> str | None:
    """Can a teeth photo's lips show the teeth at all? Its own lip gap, in
    its own mouth widths, at least the mouth-photo upload's threshold
    (portrait_photo.prepare_photo); the embed's own test decides the rest
    (fit_profile)."""
    width = max(_mouth_width(points), 1.0)
    gap = float(np.linalg.norm(points[UPPER_INNER] - points[LOWER_INNER])) / width
    if gap < TEETH_PHOTO_MIN_GAP:
        return (
            f"the lips parted {gap:.2f} of their mouth width, too little to show the teeth "
            f"(at least {TEETH_PHOTO_MIN_GAP})"
        )
    return None


def register_answer(
    answer: bytes,
    request: PoseRequest,
    base_image: Image.Image,
    base_points: np.ndarray,
    frame: ManifestFrame,
    detect: Detector,
    base_detected: np.ndarray | None = None,
) -> PoseRegistration:
    """Detect the pose in `answer`, carry it onto the base photo and check it.

    The answer's landmarks go back through the crop (request.to_base), then
    onto the base's anchors by `similarity_on_anchors`: the model may have
    zoomed or shifted the head a little, and the anchors are what a pose
    must not move. Returns per-landmark targets in base pixels, or the
    first reason the answer cannot be used. CPU work.

    `base_points` are the owner's CONFIRMED points (the rig), which may
    differ from what the detector sees wherever the owner corrected a mark,
    and four of the eight anchors are eye corners the owner may well have
    moved. So the answer is compared with `base_detected`, the same
    detector's view of the base photo: detector against detector, every
    guard and the registration measure only what the model changed. The
    targets are the confirmed points plus that change, which is exactly
    the registered answer when nothing was corrected. Without a detection
    of the base (none found) the confirmed points stand in for it.
    """
    base_view = base_points if base_detected is None else base_detected
    result = PoseRegistration(request.shape)
    try:
        with Image.open(io.BytesIO(answer)) as decoded:
            image = decoded.convert("RGB")
    except Exception:
        # Broad on purpose: Pillow raises many types on bytes it cannot
        # decode, and any of them is an unusable answer.
        logger.warning("the %s answer is not a readable image", request.shape, exc_info=True)
        result.reason = _reason("unreadable_result", "The AI returned no usable image")
        return result
    aspect = image.width / image.height
    result.checks["aspect"] = round(aspect / request.aspect, 4)
    if abs(aspect / request.aspect - 1) > MAX_ASPECT_CHANGE:
        # Mapped back per axis, a reframed answer would pass the guards with
        # its mouth in the wrong place (head_square).
        result.reason = _reason(
            "aspect_changed", "The AI answered with a picture of another shape than it was sent"
        )
        return result
    points = detect(image)
    if points is None:
        result.reason = _reason("no_face_in_result", "No face was found in the answer")
        return result
    points = np.asarray(points, dtype=np.float64)
    if points.shape != (478, 2) or not np.isfinite(points).all():
        result.reason = _reason("no_face_in_result", "The answer's face was not fully found")
        return result
    result.answer_points, result.answer_size, result.answer_image = points, image.size, image

    to_base = request.to_base(image.size)
    mapped = points @ to_base[:, :2].T + to_base[:, 2]
    try:
        similarity = similarity_on_anchors(mapped, base_view)
    except MirroredPose:
        result.reason = _reason("mirrored", "The answer is a mirror image of the face")
        return result
    checks = result.checks
    checks["scale"] = round(similarity.scale, 4)
    checks["rotation"] = round(similarity.degrees, 2)
    if (
        abs(similarity.scale - 1) > MAX_SCALE_CHANGE
        or abs(similarity.degrees) > MAX_ROTATION_DEGREES
    ):
        result.reason = _reason("head_moved", "The AI zoomed or tilted the head")
        return result

    registered = similarity.apply(mapped)
    rms = registration_rms(registered, base_view) * frame.units_per_px
    checks["rms"] = round(rms, 6)
    if rms > MAX_REGISTRATION_RMS:
        result.reason = _reason(
            "registration",
            f"The eyes and nose do not line up (RMS {rms:.4f} > {MAX_REGISTRATION_RMS})",
        )
        return result

    face = float(np.linalg.norm(base_view[FACE_RIGHT] - base_view[FACE_LEFT]))
    nose = (
        float(np.linalg.norm(registered[NOSE_GUARD] - base_view[NOSE_GUARD], axis=1).max()) / face
    )
    eyes = float(np.linalg.norm(registered[EYE_GUARD] - base_view[EYE_GUARD], axis=1).mean()) / face
    yaw = abs(signed_yaw(points) - signed_yaw(base_view))
    checks.update(nose=round(nose, 4), eyes=round(eyes, 4), yaw=round(yaw, 4))
    if nose > MAX_NOSE_SHIFT:
        result.reason = _reason("nose_moved", "The AI moved or reshaped the nose")
        return result
    if eyes > MAX_EYE_SHIFT:
        result.reason = _reason("eyes_moved", "The AI moved or reshaped the eyes")
        return result
    if yaw > MAX_YAW_CHANGE:
        result.reason = _reason("head_turned", "The AI turned the head")
        return result

    drift = photo_adjust.skin_drift(base_image, base_view, image, points)
    if drift is not None:
        checks["skin_delta_e"] = round(drift, 2)
        if drift > MAX_POSE_SKIN_DELTA_E:
            result.reason = _reason("skin_tone_changed", "The AI changed the skin tone or light")
            return result

    rest_width = _mouth_width(base_view)
    gap, width = _gap_and_width(registered, rest_width)
    opened = opening(registered, base_view)
    checks.update(gap=round(gap, 3), opening=round(opened, 3), width=round(width, 3))
    if request.shape == TEETH:
        # Not a shape of speech: how far it opens is not played, only
        # whether its lips show the teeth.
        missed = _teeth_shown(points)
        if missed:
            result.reason = _reason("pose_not_reached", f"Not a teeth photo: {missed}")
            return result
    else:
        missed = _shape_reached(request.shape, opened, width)
        if missed:
            result.reason = _reason(
                "pose_not_reached", f"Not the {request.shape.upper()} shape: {missed}"
            )
            return result
    # What the model moved, applied to the confirmed points.
    result.targets, result.rms = base_points + (registered - base_view), rms
    return result


def _down(points: np.ndarray) -> tuple[np.ndarray, float]:
    """The unit vector down the face, perpendicular to the corner line, and
    the corner-to-corner width."""
    d = points[MOUTH_RIGHT] - points[MOUTH_LEFT]
    width = float(np.linalg.norm(d))
    ux = d / width
    return np.array([-ux[1], ux[0]]), width
