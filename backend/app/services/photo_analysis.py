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

The same check runs on every image the wizard makes (the framed photo, an
AI result), and decides step 3: AI adjust is RECOMMENDED, and pre-selected,
when the check finds something the rig will show badly (`recommend`). What
the eyes and parted lips do is a touch-up's job; an open mouth (the jaw
moves when it closes), pose, light and size need the whole picture made
again. A photo with nothing to fix gets "none": AI is still offered, never
pushed.
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
# Lip gap over mouth width above which the mouth counts as open. A relaxed
# closed mouth measures near 0; parted lips about 0.1, a smile with teeth
# more. The rig wants it closed: the engine opens it.
OPEN_MOUTH_RATIO = 0.12
# Below "open", a gap this wide shows the teeth (a smile, parted lips). The
# engine draws its own teeth when it opens the mouth, and a photographed row
# of teeth stays painted on the lips when it closes. Landmarks cannot see
# teeth, so this is the gap that lets them show, not a sighting.
TEETH_RATIO = 0.035
# Eye aspect ratio (the mean of three lid-to-lid distances over the corner
# to corner width, per eye). Open eyes measure about 0.25-0.35 (the face
# template, a relaxed frontal portrait, 0.33), a blink under 0.1. Below the
# first an eye is closed; below the second, half closed: the iris is partly
# hidden and the avatar looks sleepy, and the engine cannot open a lid.
EYE_CLOSED_EAR = 0.12
EYE_HALF_CLOSED_EAR = 0.20
# How far the irises sit from the middle of their eyes, along the eye line,
# as a fraction of half the eye width (both eyes averaged, signed, so the
# inner corner's caruncle, which pulls each eye's middle inward, cancels).
# Looking at the camera measures near 0 (the template 0.02); an iris halfway
# to a corner, 0.5. The avatar's gaze is painted in: eyes looking away look
# away forever.
MAX_GAZE_OFFSET = 0.25
# Tilt left on the image the owner is using (after the level of step 1, when
# they kept it) beyond which the head reads as tilted. The level fixes any
# tilt in one click, so this is a tilt someone chose to keep or a new one
# an AI result brought.
MAX_HEAD_TILT_DEGREES = 8.0

# MediaPipe indices. Eyes by the side of the IMAGE (as in anchor_fit):
# corners, three lid pairs (top, bottom) and the iris centre.
EYES = (
    {"corners": (33, 133), "lids": ((160, 144), (159, 145), (158, 153)), "iris": 468},
    {"corners": (362, 263), "lids": ((385, 380), (386, 374), (387, 373)), "iris": 473},
)
MOUTH_CORNERS = (61, 291)
# Inner lip pairs (upper, lower): the middle and one each side of it.
INNER_LIPS = ((13, 14), (82, 87), (312, 317))

# What step 3 recommends, and why (the reason codes are check codes). The
# eyes and parted lips are a touch-up: only those regions change. An open
# mouth is not: closing it raises the jaw, which a paste of new lips cannot
# follow (photo_adjust refuses it as jaw_moved), so it is regenerated, like
# pose, light, sharpness and size, which are not in those regions either. A
# regenerated picture also opens the eyes and closes the mouth.
NONE, TOUCHUP, REGENERATE = "none", "touchup", "regenerate"
TOUCHUP_REASONS = ("eyes_closed", "eyes_half_closed", "gaze_off_camera", "teeth_showing")
REGENERATE_REASONS = (
    "no_face", "head_turned", "head_tilted", "face_small", "low_resolution",
    "too_dark", "too_bright", "blurry", "mouth_open",
)
# An animal or an animation is only judged on what the rig needs of its
# pose: a face to find, facing the camera. Their eyes, mouths and colours
# are allowed to be anything. For an animal, only the pose: the detector is
# MediaPipe's, trained on people, so "no face found" is true of almost every
# dog and cat and says nothing a regenerated picture would change (the
# detector would miss the new one too).
DRAWN_REGENERATE_REASONS: dict[str, tuple[str, ...]] = {
    "animal": ("head_turned",),
    "cartoon": ("no_face", "head_turned"),
}
LINES = ("human", "animal", "cartoon")


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


def eye_aspect_ratios(points: np.ndarray) -> list[float]:
    """Eye aspect ratio per eye (image-left, image-right): the mean lid
    opening over the corner-to-corner width. 0 for a degenerate eye."""
    ratios = []
    for eye in EYES:
        a, b = eye["corners"]
        width = float(np.linalg.norm(points[a] - points[b]))
        opening = np.mean([np.linalg.norm(points[t] - points[u]) for t, u in eye["lids"]])
        ratios.append(float(opening / width) if width > 0 else 0.0)
    return ratios


def gaze_offset(points: np.ndarray) -> float | None:
    """Where the irises look along the eye line: 0 at the camera, signed
    (positive toward the image's right), in half eye widths, both eyes
    averaged. None without iris landmarks."""
    if len(points) <= max(eye["iris"] for eye in EYES):
        return None
    offsets = []
    for eye in EYES:
        a, b = (points[i] for i in eye["corners"])
        axis = b - a if b[0] >= a[0] else a - b  # pointing to the image's right
        half = float(np.linalg.norm(axis)) / 2
        if half <= 0:
            return None
        middle = (a + b) / 2
        offsets.append(float(np.dot(points[eye["iris"]] - middle, axis / (2 * half))) / half)
    return float(np.mean(offsets))


def mouth_gap(points: np.ndarray) -> float:
    """The widest inner-lip gap over the mouth width (corner to corner)."""
    width = float(np.linalg.norm(points[MOUTH_CORNERS[0]] - points[MOUTH_CORNERS[1]]))
    if width <= 0:
        return 0.0
    return max(float(np.linalg.norm(points[t] - points[u])) for t, u in INNER_LIPS) / width


def face_state(points: np.ndarray) -> dict:
    """What the eyes, the mouth and the head do, with the measures behind
    each verdict. What a touch-up would fix (eyes, mouth), and whether the
    head is turned: what only a regenerated picture fixes."""
    from app.services.photo_adjust import yaw_offset
    from app.services.riggable import head_turned, nose_offset_of

    eyes = eye_aspect_ratios(points)
    closed = min(eyes) < EYE_CLOSED_EAR
    half_closed = not closed and min(eyes) < EYE_HALF_CLOSED_EAR
    # Gaze is read off the irises, which lids that are down hide or drag.
    gaze = None if closed or half_closed else gaze_offset(points)
    gap = mouth_gap(points)
    return {
        "eyes_closed": closed,
        "eyes_half_closed": half_closed,
        "gaze_off_camera": bool(gaze is not None and abs(gaze) > MAX_GAZE_OFFSET),
        "mouth_open": gap > OPEN_MOUTH_RATIO,
        "teeth_showing": TEETH_RATIO < gap <= OPEN_MOUTH_RATIO,
        "head_turned": head_turned(points),
        "measures": {
            "eye_aspect": [round(v, 3) for v in eyes],
            "gaze": None if gaze is None else round(gaze, 3),
            "mouth_gap": round(gap, 3),
            "nose_offset": round(nose_offset_of(points), 3),
            # The touch-up's own frontality measure (photo_adjust).
            "yaw": round(yaw_offset(points), 3),
        },
    }


FACE_STATE_CHECKS = (
    ("eyes_closed", "The eyes are closed"),
    ("eyes_half_closed", "The eyes are half closed"),
    ("gaze_off_camera", "The eyes are not looking at the camera"),
    ("mouth_open", "The mouth is open"),
    ("teeth_showing", "The lips are parted; the teeth may show"),
)


def recommend(check: dict, line: str) -> dict:
    """{mode, reasons}: what step 3 recommends for this image on `line`.

    `check` is what `check_photo` found. Reasons are check codes, in a
    fixed order. Nothing can be said without a detector (a server with no
    model): only the pixel checks then speak, for a person.
    """
    from app.services.photo_adjust import MAX_TOUCHUP_YAW

    codes = {c["code"] for c in check.get("checks") or []}
    if line != "human":
        if check.get("detector") is None:
            return {"mode": NONE, "reasons": []}
        reasons = [r for r in DRAWN_REGENERATE_REASONS.get(line, ()) if r in codes]
        return {"mode": REGENERATE if reasons else NONE, "reasons": reasons}

    touch = [r for r in TOUCHUP_REASONS if r in codes]
    regenerate = [r for r in REGENERATE_REASONS if r in codes]
    state = check.get("face_state") or {}
    yaw = (state.get("measures") or {}).get("yaw") or 0.0
    if touch and not regenerate and yaw > MAX_TOUCHUP_YAW:
        # Turned less than the rig refuses, more than a touch-up accepts
        # (photo_adjust skips it): recommending one would recommend a no.
        regenerate = ["head_turned"]
    if regenerate:
        return {"mode": REGENERATE, "reasons": regenerate + touch}
    return {"mode": TOUCHUP if touch else NONE, "reasons": touch}


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


def check_photo(image: Image.Image) -> dict:
    """The photo check of one image: the face found (or not), its state,
    the problems named, and the recommendation per line. CPU work.

    A transparent image (a cut-out) is judged on the neutral backdrop an
    image model would see it on (photo_io.on_backdrop).
    """
    from app.services import landmarks
    from app.services.photo_io import on_backdrop
    from app.services.riggable import check_landmarks

    rgb = on_backdrop(image)
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
    state = None
    if found is not None:
        points = found.points
        state = face_state(points)
        checks.extend(_check(code, detail) for code, detail in FACE_STATE_CHECKS if state[code])
        face_box = (
            float(points[:, 0].min()), float(points[:, 1].min()),
            float(points[:, 0].max()), float(points[:, 1].max()),
        )
        verdict = check_landmarks(points, size, detected=True)
        if not verdict.ok and verdict.code:
            checks.append(_check(verdict.code, verdict.reason or verdict.code))
        # check_landmarks names only its first failure; a small face that
        # is also turned must say both.
        if state["head_turned"] and verdict.code != "head_turned":
            checks.append(_check("head_turned", "The head is turned away"))
        roll = round(eye_line_roll(points), 1)
        if abs(roll) > MAX_HEAD_TILT_DEGREES:
            checks.append(_check("head_tilted", "The head is tilted"))
        if face_box[2] - face_box[0] < MIN_FACE_PIXELS:
            checks.append(_check("low_resolution", "The face has too few pixels for a sharp mouth"))
    elif detector is not None:
        checks.append(_check("no_face", "No human face was found"))
    checks.extend(pixel_checks(rgb, face_box))

    check = {
        "detector": detector,
        "detected": found is not None,
        "face_box": [round(v, 1) for v in face_box] if face_box else None,
        "roll": roll,
        # {eyes_closed, eyes_half_closed, gaze_off_camera, mouth_open,
        # teeth_showing, head_turned, measures} when a face was found.
        "face_state": state,
        "checks": checks,
    }
    check["recommendations"] = {line: recommend(check, line) for line in LINES}
    return check


def check_png(png: bytes) -> dict:
    """check_photo of an encoded image."""
    with Image.open(io.BytesIO(png)) as image:
        image.load()
        return check_photo(image)


def analyse(png: bytes) -> dict:
    """The analysis a new creation stores: the photo check of the original,
    plus what step 1 pre-fills from it. CPU work: run it off the loop.

    Coordinates are the analysed image's pixels (the creation's original).
    """
    with Image.open(io.BytesIO(png)) as image:
        image.load()
        size = image.size
        check = check_photo(image)

    framing = None
    face_box = check["face_box"]
    if face_box is not None:
        crop = suggested_crop(tuple(face_box), size)
        roll = check["roll"] or 0.0
        level = roll if abs(roll) >= MIN_ROLL_DEGREES else 0.0
        if crop is not None or level:
            crop = inside_when_turned(crop or {"x": 0.0, "y": 0.0, "w": 1.0, "h": 1.0}, level, size)
            framing = {"crop": crop, "roll": level}

    return {
        "image_size": list(size),
        **check,
        "suggested_face_type": "human" if check["detected"] else None,
        "suggested_framing": framing,
    }
