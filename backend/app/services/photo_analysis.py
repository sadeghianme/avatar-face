"""What the creation wizard can tell about a photo before anyone touches it.

Free, local and fast: one MediaPipe pass and a few pixel statistics. It
pre-fills step 1 (the crop and the level), suggests the line, and names the
problems a person can fix by choosing another photo (too dark, blurred, the
face too small) before they spend time marking points on it.

Everything here is a SUGGESTION. The checks are warnings, never refusals:
they are heuristics tuned on photographs, and a flat cartoon or a dog is
allowed to fail them for being what it is. What decides whether an avatar
may be built is the fit validator (services.anchor_fit), later, on the
points the owner confirmed.

The line is suggested only when a face is detected (human). No detection
could mean an animal or a drawing, and guessing between those would be a
coin toss presented as a finding, so the wizard asks instead.
"""

from __future__ import annotations

import io
import math

import numpy as np
from PIL import Image

from app.services.anchor_fit import LEFT_EYE, RIGHT_EYE

# Photos are judged on the face at this width, so the sharpness threshold
# means the same on a 400px upload and a 2048px one.
SHARPNESS_SAMPLE_WIDTH = 256
# Variance of the Laplacian below which the face reads as out of focus.
# A heuristic (sharp phone portraits measure in the hundreds, motion blur
# and heavy compression in the tens); only ever a warning.
MIN_SHARPNESS = 60.0
# Mean luminance (0-255) of the face outside which it is too dark or too
# bright to texture well, and the share of clipped pixels that says so on
# its own (a face half in shadow can average fine).
MIN_LUMA, MAX_LUMA = 60.0, 205.0
MAX_CLIPPED = 0.25
# The face must carry this many pixels across for the mouth to have detail
# (the same concern as riggable.MIN_FACE_FRACTION, in absolute terms).
MIN_FACE_PIXELS = 180
# Tilt below this is left alone: levelling a photo by half a degree only
# resamples it.
MIN_ROLL_DEGREES = 1.5
# The crop the wizard may apply keeps at least this much of each side
# (matches the avatar crop endpoint).
MIN_CROP_FRACTION = 0.15


def _check(code: str, detail: str) -> dict:
    return {"code": code, "detail": detail}


def eye_line_roll(points: np.ndarray) -> float:
    """The face's tilt in degrees, from the line between the eye centres.

    Image coordinates (y down): positive means the eye on the image's right
    sits lower than the one on its left. Levelling the photo means rotating
    it by this much the other way, which is what `photo_io.frame_photo`
    does with a roll.
    """
    left = (points[LEFT_EYE["left"]] + points[LEFT_EYE["right"]]) / 2
    right = (points[RIGHT_EYE["left"]] + points[RIGHT_EYE["right"]]) / 2
    dx, dy = float(right[0] - left[0]), float(right[1] - left[1])
    return math.degrees(math.atan2(dy, dx)) if dx or dy else 0.0


def _laplacian_variance(gray: np.ndarray) -> float:
    """Focus measure: how much a 4-neighbour Laplacian varies."""
    if gray.shape[0] < 3 or gray.shape[1] < 3:
        return 0.0
    lap = (
        gray[:-2, 1:-1] + gray[2:, 1:-1] + gray[1:-1, :-2] + gray[1:-1, 2:]
        - 4.0 * gray[1:-1, 1:-1]
    )
    return float(lap.var())


def _region(rgb: Image.Image, box: tuple[float, float, float, float] | None) -> Image.Image:
    if box is None:
        return rgb
    x0, y0, x1, y1 = box
    w, h = rgb.size
    clipped = (
        max(0, int(x0)), max(0, int(y0)), min(w, math.ceil(x1)), min(h, math.ceil(y1))
    )
    if clipped[2] - clipped[0] < 4 or clipped[3] - clipped[1] < 4:
        return rgb
    return rgb.crop(clipped)


def pixel_checks(
    rgb: Image.Image, face_box: tuple[float, float, float, float] | None
) -> list[dict]:
    """Sharpness and exposure, measured on the face where there is one."""
    checks: list[dict] = []
    region = _region(rgb, face_box)
    gray = region.convert("L")
    if gray.width > SHARPNESS_SAMPLE_WIDTH:
        height = max(3, round(gray.height * SHARPNESS_SAMPLE_WIDTH / gray.width))
        gray = gray.resize((SHARPNESS_SAMPLE_WIDTH, height), Image.Resampling.BILINEAR)
    luma = np.asarray(gray, dtype=np.float32)
    if _laplacian_variance(luma) < MIN_SHARPNESS:
        checks.append(_check("blurry", "The face looks out of focus"))
    mean = float(luma.mean())
    if mean < MIN_LUMA or float((luma < 8).mean()) > MAX_CLIPPED:
        checks.append(_check("too_dark", "The face is too dark"))
    elif mean > MAX_LUMA or float((luma > 247).mean()) > MAX_CLIPPED:
        checks.append(_check("too_bright", "The face is overexposed"))
    return checks


def suggested_crop(
    face_box: tuple[float, float, float, float], size: tuple[int, int]
) -> dict[str, float] | None:
    """The portrait crop around the face (riggable.portrait_crop, the same
    arithmetic that salvages generated portraits), as fractions of the image,
    grown about its centre to the smallest crop the wizard accepts."""
    from app.services.riggable import portrait_crop

    box = portrait_crop(face_box, size)
    if box is None:
        return None
    width, height = size
    left, top, right, bottom = box
    x, y, w, h = left / width, top / height, (right - left) / width, (bottom - top) / height
    least = MIN_CROP_FRACTION
    if w < least:
        x, w = max(0.0, min(x - (least - w) / 2, 1 - least)), least
    if h < least:
        y, h = max(0.0, min(y - (least - h) / 2, 1 - least)), least
    return {k: round(v, 4) for k, v in (("x", x), ("y", y), ("w", w), ("h", h))}


def inside_when_turned(
    crop: dict[str, float], roll: float, size: tuple[int, int]
) -> dict[str, float]:
    """`crop` shrunk about its centre until, turned by `roll`, it lies
    wholly inside the photo.

    A levelled frame that reaches past the photo gets its corners filled
    with repeated edge pixels (photo_io.frame_photo), which is right for a
    crop the owner chose and wrong for one we suggest: the suggestion
    should need no filling at all. Never below the smallest crop accepted.
    """
    if not roll:
        return crop
    width, height = size
    theta = math.radians(roll)
    cos, sin = abs(math.cos(theta)), abs(math.sin(theta))
    cx, cy = (crop["x"] + crop["w"] / 2) * width, (crop["y"] + crop["h"] / 2) * height
    half_w, half_h = crop["w"] * width / 2, crop["h"] * height / 2
    # Half the turned frame's bounding box, per unit of scale.
    reach_x = half_w * cos + half_h * sin
    reach_y = half_w * sin + half_h * cos
    room = min(cx, width - cx) / reach_x, min(cy, height - cy) / reach_y
    scale = min(1.0, *room)
    scale = max(scale, MIN_CROP_FRACTION / crop["w"], MIN_CROP_FRACTION / crop["h"])
    w, h = crop["w"] * scale, crop["h"] * scale
    x = min(max(cx / width - w / 2, 0.0), 1.0 - w)
    y = min(max(cy / height - h / 2, 0.0), 1.0 - h)
    return {k: round(v, 4) for k, v in (("x", x), ("y", y), ("w", w), ("h", h))}


def analyse(png: bytes) -> dict:
    """The analysis a new creation stores. CPU work: run it off the loop.

    Coordinates are the analysed image's pixels (the creation's original).
    """
    from app.services import landmarks
    from app.services.riggable import check_landmarks

    rgb = Image.open(io.BytesIO(png)).convert("RGB")
    size = rgb.size
    try:
        found = landmarks.detect(rgb)
        detector: str | None = "mediapipe"
    except landmarks.LandmarkerUnavailable:
        # No model on this instance: nothing can be detected, and saying
        # "no face" would be a claim about the photo rather than the server.
        found, detector = None, None

    checks: list[dict] = []
    face_box = None
    roll = None
    framing = None
    if found is not None:
        points = found.points
        face_box = (
            float(points[:, 0].min()), float(points[:, 1].min()),
            float(points[:, 0].max()), float(points[:, 1].max()),
        )
        verdict = check_landmarks(points, size, detected=True)
        if not verdict.ok and verdict.code:
            checks.append(_check(verdict.code, verdict.reason or verdict.code))
        if face_box[2] - face_box[0] < MIN_FACE_PIXELS:
            checks.append(_check("low_resolution", "The face has too few pixels for a sharp mouth"))
        roll = round(eye_line_roll(points), 1)
        crop = suggested_crop(face_box, size)
        level = roll if abs(roll) >= MIN_ROLL_DEGREES else 0.0
        if crop is not None or level:
            crop = inside_when_turned(crop or {"x": 0.0, "y": 0.0, "w": 1.0, "h": 1.0}, level, size)
            framing = {"crop": crop, "roll": level}
    elif detector is not None:
        checks.append(_check("no_face", "No human face was found"))
    checks.extend(pixel_checks(rgb, face_box))

    return {
        "image_size": list(size),
        "detector": detector,
        "detected": found is not None,
        "face_box": [round(v, 1) for v in face_box] if face_box else None,
        "roll": roll,
        "suggested_face_type": "human" if found is not None else None,
        "suggested_framing": framing,
        "checks": checks,
    }
