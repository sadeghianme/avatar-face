"""What the wizard reads off a photo, and how it frames one."""

import io
import math

import numpy as np
import pytest
from PIL import Image, ImageDraw

from app.services import face_template, landmarks
from app.services import photo_analysis as pan
from app.services.photo_analysis import (
    analyse,
    eye_line_roll,
    inside_when_turned,
    suggested_crop,
)
from app.services.photo_io import frame_photo, png_bytes
from tests.test_photo_privacy import assert_scrubbed


def textured(width=400, height=500, low=60, high=200) -> Image.Image:
    rng = np.random.default_rng(3)
    return Image.fromarray(rng.integers(low, high, size=(height, width, 3), dtype=np.uint8))


def png(image: Image.Image) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def rotated(points: np.ndarray, degrees: float) -> np.ndarray:
    theta = math.radians(degrees)
    centre = points.mean(axis=0)
    rot = np.array([[math.cos(theta), -math.sin(theta)], [math.sin(theta), math.cos(theta)]])
    return (points - centre) @ rot.T + centre


@pytest.fixture
def tilted_face(monkeypatch):
    """A face found in the middle of the photo, turned by `tilt` degrees."""
    state = {"tilt": 0.0, "box": (0.3, 0.2, 0.7, 0.7)}

    def detect(image):
        w, h = image.size
        x0, y0, x1, y1 = state["box"]
        points = rotated(face_template.place((x0 * w, y0 * h, x1 * w, y1 * h)), state["tilt"])
        return landmarks.FaceLandmarks(points=points, z=np.zeros(len(points)))

    monkeypatch.setattr(landmarks, "detect", detect)
    return state


def test_the_eye_line_gives_the_tilt():
    level = face_template.place((100, 100, 300, 350))
    assert abs(eye_line_roll(level)) < 1.0
    assert eye_line_roll(rotated(level, 12)) == pytest.approx(eye_line_roll(level) + 12, abs=0.01)


def test_a_detected_face_is_suggested_human_with_a_crop_and_a_level(tilted_face):
    tilted_face["tilt"] = 8.0
    result = analyse(png(textured()))
    assert result["detected"] is True and result["detector"] == "mediapipe"
    assert result["suggested_face_type"] == "human"
    assert result["roll"] == pytest.approx(8.0, abs=1.0)
    framing = result["suggested_framing"]
    assert framing["roll"] == result["roll"]
    crop = framing["crop"]
    assert crop["x"] >= 0 and crop["x"] + crop["w"] <= 1.0001
    assert crop["y"] >= 0 and crop["y"] + crop["h"] <= 1.0001
    # The face is inside the suggested crop.
    x0, y0, x1, y1 = result["face_box"]
    assert crop["x"] * 400 <= x0 and x1 <= (crop["x"] + crop["w"]) * 400


def test_a_small_face_gets_a_tighter_crop_and_a_warning(tilted_face):
    tilted_face["box"] = (0.45, 0.3, 0.55, 0.4)
    result = analyse(png(textured(1200, 1200)))
    codes = {c["code"] for c in result["checks"]}
    assert "face_small" in codes and "low_resolution" in codes
    assert result["suggested_framing"]["crop"]["w"] < 0.5


def test_no_face_suggests_nothing(monkeypatch):
    monkeypatch.setattr(landmarks, "detect", lambda image: None)
    result = analyse(png(textured()))
    assert result["detected"] is False
    assert result["suggested_face_type"] is None
    assert result["suggested_framing"] is None
    assert "no_face" in {c["code"] for c in result["checks"]}


def test_without_a_model_it_does_not_claim_there_is_no_face():
    result = analyse(png(textured()))
    assert result["detector"] is None
    assert "no_face" not in {c["code"] for c in result["checks"]}


def test_dark_bright_and_blurred_photos_are_named():
    dark = analyse(png(textured(low=0, high=30)))
    assert "too_dark" in {c["code"] for c in dark["checks"]}
    bright = analyse(png(textured(low=235, high=256)))
    assert "too_bright" in {c["code"] for c in bright["checks"]}
    flat = analyse(png(Image.new("RGB", (300, 300), "#a08070")))
    assert "blurry" in {c["code"] for c in flat["checks"]}
    sharp = analyse(png(textured()))
    assert not {"blurry", "too_dark", "too_bright"} & {c["code"] for c in sharp["checks"]}


def test_a_suggested_level_needs_no_filled_corners():
    """Turned by the suggested roll, the suggested crop stays in the photo."""
    size = (1000, 800)
    crop = inside_when_turned({"x": 0.0, "y": 0.0, "w": 1.0, "h": 1.0}, 8.0, size)
    assert crop["w"] < 1.0 and crop["h"] < 1.0
    theta = math.radians(8.0)
    cx, cy = (crop["x"] + crop["w"] / 2) * size[0], (crop["y"] + crop["h"] / 2) * size[1]
    for u in (-1, 1):
        for v in (-1, 1):
            dx, dy = u * crop["w"] * size[0] / 2, v * crop["h"] * size[1] / 2
            x = cx + dx * math.cos(theta) - dy * math.sin(theta)
            y = cy + dx * math.sin(theta) + dy * math.cos(theta)
            assert -0.5 <= x <= size[0] + 0.5 and -0.5 <= y <= size[1] + 0.5
    assert inside_when_turned({"x": 0.1, "y": 0.1, "w": 0.5, "h": 0.5}, 0.0, size) == {
        "x": 0.1,
        "y": 0.1,
        "w": 0.5,
        "h": 0.5,
    }


def test_a_suggested_crop_is_never_below_the_smallest_crop_accepted():
    crop = suggested_crop((1000, 1000, 1030, 1040), (4000, 4000))
    assert crop["w"] >= 0.15 and crop["h"] >= 0.15


# --- framing ---------------------------------------------------------------------


def test_a_crop_without_roll_is_exact():
    image = textured()
    framed = frame_photo(png(image), {"x": 0.25, "y": 0.1, "w": 0.5, "h": 0.4})
    assert framed.size == (200, 200)
    assert np.array_equal(np.asarray(framed), np.asarray(image)[50:250, 100:300])


def test_roll_levels_a_tilted_line():
    """Two dots on a line sloping by 10 degrees end up level."""
    image = Image.new("RGB", (400, 400), "white")
    draw = ImageDraw.Draw(image)
    slope = math.radians(10)
    dots = [(200 + d * math.cos(slope), 200 + d * math.sin(slope)) for d in (-100, 100)]
    for x, y in dots:
        draw.ellipse((x - 6, y - 6, x + 6, y + 6), fill="black")
    whole = {"x": 0, "y": 0, "w": 1, "h": 1}
    framed = np.asarray(frame_photo(png(image), whole, 10.0).convert("L"))

    def centroid(half: np.ndarray, offset: int) -> tuple[float, float]:
        ys, xs = np.nonzero(half < 128)
        return float(xs.mean()) + offset, float(ys.mean())

    left = centroid(framed[:, :200], 0)
    right = centroid(framed[:, 200:], 200)
    assert abs(left[1] - right[1]) < 1.5
    assert right[0] - left[0] == pytest.approx(200, abs=3)


def test_a_turned_opaque_photo_has_no_empty_corners():
    image = Image.new("RGB", (300, 300), (200, 120, 40))
    framed = np.asarray(frame_photo(png(image), {"x": 0, "y": 0, "w": 1, "h": 1}, 30.0))
    assert framed.shape == (300, 300, 3)
    assert np.all(np.abs(framed.astype(int) - [200, 120, 40]) <= 2)


def test_a_turned_cutout_stays_transparent_and_scrubbed():
    rgba = np.zeros((200, 200, 4), dtype=np.uint8)
    rgba[..., :3] = 180
    rgba[50:150, 50:150, 3] = 255
    source = png_bytes(Image.fromarray(rgba, mode="RGBA"))
    framed = frame_photo(source, {"x": 0, "y": 0, "w": 1, "h": 1}, 20.0)
    assert framed.mode == "RGBA"
    assert np.asarray(framed)[0, 0, 3] == 0
    assert_scrubbed(png_bytes(framed))


# --- the photo check and step 3's recommendation ------------------------------------
#
# The fixtures are the face template (MediaPipe's own detection of a relaxed,
# frontal, fictional portrait) with one thing changed at a time by the
# helpers below, each to an exact measure, so every threshold is tested on
# both of its sides.


def with_eyes(points: np.ndarray, aspect: float, eyes=(0, 1)) -> np.ndarray:
    """The face with the lids of `eyes` (0 image-left, 1 image-right) moved
    about their middles until each eye's aspect ratio is `aspect`."""
    out = points.copy()
    for index in eyes:
        eye = pan.EYES[index]
        a, b = eye["corners"]
        width = float(np.linalg.norm(out[a] - out[b]))
        for top, bottom in eye["lids"]:
            middle = (out[top] + out[bottom]) / 2
            down = np.array([0.0, 1.0])
            out[top] = middle - down * aspect * width / 2
            out[bottom] = middle + down * aspect * width / 2
    return out


def looking(points: np.ndarray, offset: float) -> np.ndarray:
    """The face with both irises moved along their eye lines, from where the
    template has them, by `offset` half eye widths (positive: image right)."""
    out = points.copy()
    for eye, ring in ((pan.EYES[0], range(468, 473)), (pan.EYES[1], range(473, 478))):
        a, b = (out[i] for i in eye["corners"])
        axis = (b - a) if b[0] >= a[0] else (a - b)
        half = float(np.linalg.norm(axis)) / 2
        shift = axis / (2 * half) * offset * half
        for i in ring:
            out[i] = out[i] + shift
    return out


def with_mouth(points: np.ndarray, gap: float) -> np.ndarray:
    """The face with the inner lips parted to `gap` mouth widths."""
    out = points.copy()
    width = float(np.linalg.norm(out[61] - out[291]))
    for top, bottom in pan.INNER_LIPS:
        middle = (out[top] + out[bottom]) / 2
        out[top] = middle - np.array([0.0, gap * width / 2])
        out[bottom] = middle + np.array([0.0, gap * width / 2])
    return out


def turned(points: np.ndarray, offset: float) -> np.ndarray:
    """The face with the nose tip `offset` half face widths from the middle
    of the face box (riggable's frontality measure)."""
    out = points.copy()
    x0, x1 = out[:, 0].min(), out[:, 0].max()
    out[1, 0] = (x0 + x1) / 2 + offset * (x1 - x0) / 2
    return out


# A photo whose face (the template in the middle) is big and sharp enough:
# 240 px across, 40% of the width. The 400 px wide `textured()` default puts
# a 160 px face in it, which is low resolution.
GOOD = (600, 750)


@pytest.fixture
def face_is(monkeypatch):
    """landmarks.detect answering `state["points"](box)`: the template,
    changed, in the middle of whatever image it is shown."""
    state = {"change": lambda p: p, "box": (0.3, 0.2, 0.7, 0.7), "seen": []}

    def detect(image):
        state["seen"].append(image)
        if state["change"] is None:
            return None
        w, h = image.size
        x0, y0, x1, y1 = state["box"]
        points = state["change"](face_template.place((x0 * w, y0 * h, x1 * w, y1 * h)))
        return landmarks.FaceLandmarks(points=points, z=np.zeros(len(points)))

    monkeypatch.setattr(landmarks, "detect", detect)
    return state


def _check(face_is, change, image=None) -> dict:
    face_is["change"] = change
    return pan.check_photo(image or textured(*GOOD))


def _codes(check: dict) -> set[str]:
    return {c["code"] for c in check["checks"]}


def test_the_template_needs_nothing_on_any_line(face_is):
    check = _check(face_is, lambda p: p)
    assert check["checks"] == []
    for line in ("human", "animal", "cartoon"):
        assert check["recommendations"][line] == {"mode": "none", "reasons": []}
    state = check["face_state"]
    assert not any(v for k, v in state.items() if k != "measures")
    measures = state["measures"]
    assert min(measures["eye_aspect"]) > pan.EYE_HALF_CLOSED_EAR
    assert abs(measures["gaze"]) < pan.MAX_GAZE_OFFSET / 5
    assert measures["mouth_gap"] < pan.TEETH_RATIO


@pytest.mark.parametrize(
    ("aspect", "code"),
    [
        (pan.EYE_CLOSED_EAR - 0.01, "eyes_closed"),
        (pan.EYE_CLOSED_EAR + 0.01, "eyes_half_closed"),
        (pan.EYE_HALF_CLOSED_EAR - 0.01, "eyes_half_closed"),
        (pan.EYE_HALF_CLOSED_EAR + 0.01, None),
    ],
)
def test_eyes_are_judged_by_their_aspect_ratio(face_is, aspect, code):
    check = _check(face_is, lambda p: with_eyes(p, aspect))
    assert check["face_state"]["measures"]["eye_aspect"] == [pytest.approx(aspect, abs=1e-3)] * 2
    found = _codes(check) & {"eyes_closed", "eyes_half_closed"}
    assert found == ({code} if code else set())
    expected = {"mode": "touchup", "reasons": [code]} if code else {"mode": "none", "reasons": []}
    assert check["recommendations"]["human"] == expected


def test_one_closed_eye_is_closed_eyes(face_is):
    check = _check(face_is, lambda p: with_eyes(p, 0.03, eyes=(1,)))
    assert "eyes_closed" in _codes(check)
    assert check["recommendations"]["human"]["mode"] == "touchup"


@pytest.mark.parametrize("direction", [1, -1])
def test_eyes_looking_away_are_named(face_is, direction):
    template = _check(face_is, lambda p: p)["face_state"]["measures"]["gaze"]
    near = pan.MAX_GAZE_OFFSET - 0.05 - abs(template)
    far = pan.MAX_GAZE_OFFSET + 0.05 + abs(template)
    assert "gaze_off_camera" not in _codes(_check(face_is, lambda p: looking(p, direction * near)))
    away = _check(face_is, lambda p: looking(p, direction * far))
    assert "gaze_off_camera" in _codes(away)
    assert away["recommendations"]["human"] == {"mode": "touchup", "reasons": ["gaze_off_camera"]}


def test_gaze_is_not_read_through_lowered_lids(face_is):
    check = _check(face_is, lambda p: looking(with_eyes(p, 0.15), 0.6))
    assert check["face_state"]["measures"]["gaze"] is None
    assert "gaze_off_camera" not in _codes(check)


@pytest.mark.parametrize(
    ("gap", "code"),
    [
        (pan.TEETH_RATIO - 0.01, None),
        (pan.TEETH_RATIO + 0.01, "teeth_showing"),
        (pan.OPEN_MOUTH_RATIO - 0.01, "teeth_showing"),
        (pan.OPEN_MOUTH_RATIO + 0.01, "mouth_open"),
    ],
)
def test_the_mouth_is_judged_by_the_inner_lip_gap(face_is, gap, code):
    check = _check(face_is, lambda p: with_mouth(p, gap))
    assert check["face_state"]["measures"]["mouth_gap"] == pytest.approx(gap, abs=1e-3)
    assert _codes(check) & {"teeth_showing", "mouth_open"} == ({code} if code else set())
    # Parted lips are touched up; an open mouth is regenerated, because
    # closing it moves the jaw and a paste of new lips cannot follow.
    expected = {None: "none", "teeth_showing": "touchup", "mouth_open": "regenerate"}[code]
    assert check["recommendations"]["human"]["mode"] == expected


def test_a_turned_head_needs_regenerating_which_also_fixes_the_eyes(face_is):
    from app.services.riggable import MAX_NOSE_OFFSET

    assert "head_turned" not in _codes(_check(face_is, lambda p: turned(p, MAX_NOSE_OFFSET - 0.1)))
    check = _check(face_is, lambda p: turned(with_eyes(p, 0.05), MAX_NOSE_OFFSET + 0.05))
    assert "head_turned" in _codes(check)
    assert check["recommendations"]["human"] == {
        "mode": "regenerate",
        "reasons": ["head_turned", "eyes_closed"],
    }


def test_a_touchup_is_not_recommended_on_a_head_it_would_refuse(face_is):
    """Turned past the touch-up's limit but not the rig's: regenerate."""
    from app.services.photo_adjust import MAX_TOUCHUP_YAW
    from app.services.riggable import MAX_NOSE_OFFSET

    between = (MAX_TOUCHUP_YAW + MAX_NOSE_OFFSET) / 2
    check = _check(face_is, lambda p: turned(with_eyes(p, 0.05), between))
    assert check["face_state"]["measures"]["yaw"] > MAX_TOUCHUP_YAW
    assert "head_turned" not in _codes(check)
    assert check["recommendations"]["human"] == {
        "mode": "regenerate",
        "reasons": ["head_turned", "eyes_closed"],
    }
    # Frontal enough, the same eyes are a touch-up.
    assert _check(face_is, lambda p: with_eyes(p, 0.05))["recommendations"]["human"]["mode"] == (
        "touchup"
    )


def test_a_tilt_left_on_the_image_needs_regenerating(face_is):
    level = pan.MAX_HEAD_TILT_DEGREES
    assert "head_tilted" not in _codes(_check(face_is, lambda p: rotated(p, level - 2)))
    check = _check(face_is, lambda p: rotated(p, level + 2))
    assert "head_tilted" in _codes(check)
    assert check["recommendations"]["human"] == {"mode": "regenerate", "reasons": ["head_tilted"]}


def test_a_small_face_and_poor_light_need_regenerating(face_is):
    face_is["box"] = (0.45, 0.35, 0.55, 0.45)
    small = _check(face_is, lambda p: p, textured(1200, 1200))
    assert small["recommendations"]["human"] == {
        "mode": "regenerate",
        "reasons": ["face_small", "low_resolution"],
    }
    face_is["box"] = (0.3, 0.2, 0.7, 0.7)
    dark = _check(face_is, lambda p: with_mouth(p, 0.2), textured(*GOOD, low=0, high=30))
    assert dark["recommendations"]["human"] == {
        "mode": "regenerate",
        "reasons": ["too_dark", "mouth_open"],
    }


def test_no_face_on_a_person_needs_regenerating(face_is):
    check = _check(face_is, None)
    assert check["recommendations"]["human"] == {"mode": "regenerate", "reasons": ["no_face"]}


def test_animals_and_animations_are_judged_on_their_pose_only(face_is):
    # The detector is trained on people: finding no face says nothing about
    # a dog, and a regenerated dog would not be found either. A drawing it
    # misses may well be one it would find drawn frontally.
    missing = _check(face_is, None)["recommendations"]
    assert missing["animal"] == {"mode": "none", "reasons": []}
    assert missing["cartoon"] == {"mode": "regenerate", "reasons": ["no_face"]}
    for line in ("animal", "cartoon"):
        side = _check(face_is, lambda p: turned(p, 0.6))["recommendations"][line]
        assert side == {"mode": "regenerate", "reasons": ["head_turned"]}
        # Closed eyes, an open mouth, dim light: a drawing may be drawn so.
        odd = _check(
            face_is, lambda p: with_mouth(with_eyes(p, 0.02), 0.3), textured(*GOOD, low=0, high=30)
        )
        assert odd["recommendations"][line] == {"mode": "none", "reasons": []}


def test_without_a_detector_only_the_pixels_speak():
    check = pan.check_photo(textured(*GOOD, low=0, high=30))
    assert check["detector"] is None
    human = check["recommendations"]["human"]
    assert human["mode"] == "regenerate" and "too_dark" in human["reasons"]
    assert "no_face" not in human["reasons"], "no model is not no face"
    assert check["recommendations"]["animal"] == {"mode": "none", "reasons": []}
    fine = pan.check_photo(textured(*GOOD))
    assert fine["recommendations"]["human"] == {"mode": "none", "reasons": []}


def test_a_cutout_is_checked_on_the_neutral_backdrop(face_is):
    rgba = np.asarray(textured(*GOOD).convert("RGBA")).copy()
    rgba[:, :100, 3] = 0
    rgba[:, :100, :3] = 0
    check = _check(face_is, lambda p: p, Image.fromarray(rgba, mode="RGBA"))
    shown = face_is["seen"][-1]
    assert shown.mode == "RGB"
    assert shown.getpixel((10, 10)) == (128, 128, 128), "grey, not the black under alpha 0"
    assert check["recommendations"]["human"]["mode"] == "none"


def test_the_upload_analysis_carries_the_check(face_is):
    result = analyse(png(textured(*GOOD)))
    assert result["recommendations"]["human"] == {"mode": "none", "reasons": []}
    assert result["face_state"]["measures"]["eye_aspect"]
