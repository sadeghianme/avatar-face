"""What the wizard reads off a photo, and how it frames one."""

import io
import math

import numpy as np
import pytest
from PIL import Image, ImageDraw

from app.services import face_template, landmarks
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
    assert 0 <= crop["x"] and crop["x"] + crop["w"] <= 1.0001
    assert 0 <= crop["y"] and crop["y"] + crop["h"] <= 1.0001
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
        "x": 0.1, "y": 0.1, "w": 0.5, "h": 0.5,
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
