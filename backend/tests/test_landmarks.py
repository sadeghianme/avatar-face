"""The shared MediaPipe landmarker: loaded once, one detection at a time."""

import threading
import time
from types import SimpleNamespace

import pytest
from PIL import Image

from app.core import config
from app.services import landmarks


@pytest.fixture
def fake_mediapipe(monkeypatch):
    """A landmarker that counts how often it is built and catches overlap."""
    from mediapipe.tasks.python import vision

    stats = {"built": 0, "active": 0, "overlapped": False}

    class Landmarker:
        def detect(self, _image):
            stats["active"] += 1
            stats["overlapped"] |= stats["active"] > 1
            time.sleep(0.005)
            stats["active"] -= 1
            point = SimpleNamespace(x=0.5, y=0.25, z=-0.1)
            return SimpleNamespace(face_landmarks=[[point] * 478])

        def close(self):
            pass

    def build(_options):
        stats["built"] += 1
        return Landmarker()

    monkeypatch.setattr(vision.FaceLandmarker, "create_from_options", build)
    monkeypatch.setattr(config.get_settings(), "rig_model_path", "/fake/model.task", raising=False)
    monkeypatch.setattr(landmarks, "_landmarker", None)
    monkeypatch.setattr(landmarks, "_loaded_path", None)
    return stats


def test_the_model_loads_once_and_answers_in_pixels(fake_mediapipe):
    image = Image.new("RGB", (200, 100))
    first = landmarks.detect(image)
    landmarks.detect(image)
    assert fake_mediapipe["built"] == 1
    assert first.points.shape == (478, 2)
    assert tuple(first.points[0]) == (100.0, 25.0)
    assert first.z[0] == pytest.approx(-20.0)


def test_concurrent_detections_never_overlap(fake_mediapipe):
    image = Image.new("RGB", (64, 64))
    threads = [threading.Thread(target=landmarks.detect, args=(image,)) for _ in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert fake_mediapipe["built"] == 1
    assert fake_mediapipe["overlapped"] is False


def test_no_model_configured_is_distinguishable_from_no_face(monkeypatch):
    monkeypatch.setattr(config.get_settings(), "rig_model_path", "", raising=False)
    with pytest.raises(landmarks.LandmarkerUnavailable):
        landmarks.detect(Image.new("RGB", (8, 8)))


def test_every_detector_caller_goes_through_the_shared_landmarker(fake_mediapipe):
    """rig, the riggable checks and the portrait validator all used to build
    their own; the build count proves they now share one."""
    import io

    from app.services.riggable import check_image
    from app.services.rig import landmarks_from_image

    buffer = io.BytesIO()
    Image.new("RGB", (64, 64)).save(buffer, format="PNG")
    landmarks_from_image(buffer.getvalue())
    check_image(buffer.getvalue())
    assert fake_mediapipe["built"] == 1
