"""MediaPipe face landmarks, with the model loaded once per process.

Every caller used to build its own FaceLandmarker per image, which re-read
and re-initialised the 3.7MB model each time — about 0.2s per call, paid
several times over by generation checks that detect on every candidate.
Now there is one landmarker, created on first use.

One landmarker means one object shared by every request thread, and
MediaPipe does not promise that `detect` is safe to call concurrently, so
each call holds a lock. Detection takes tens of milliseconds and this server
runs one process; queueing behind a lock costs far less than the reload did.

The model path is read from settings on every call rather than captured at
import, so an instance (or a test) with RIG_MODEL_PATH unset has no model and
every caller takes its no-model path.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass

import numpy as np
from PIL import Image

from app.core.config import get_settings


class LandmarkerUnavailable(RuntimeError):
    """No landmark model is configured on this instance."""


@dataclass(frozen=True)
class FaceLandmarks:
    points: np.ndarray  # (478, 2) image pixels
    z: np.ndarray  # (478,) depth, in the same pixel units as x


_lock = threading.Lock()
_landmarker = None
_loaded_path: str | None = None


def _landmarker_for(path: str):
    """The shared landmarker; caller holds the lock."""
    global _landmarker, _loaded_path
    if _landmarker is None or _loaded_path != path:
        from mediapipe.tasks import python as mp_python
        from mediapipe.tasks.python import vision

        if _landmarker is not None:
            _landmarker.close()
        _landmarker = vision.FaceLandmarker.create_from_options(
            vision.FaceLandmarkerOptions(
                base_options=mp_python.BaseOptions(model_asset_path=path),
                num_faces=1,
            )
        )
        _loaded_path = path
    return _landmarker


def detect(image: Image.Image) -> FaceLandmarks | None:
    """The one face in `image`, or None when there is none.

    Raises LandmarkerUnavailable when no model is configured, so a caller can
    tell "no face" from "cannot look".
    """
    path = get_settings().rig_model_path
    if not path:
        raise LandmarkerUnavailable("rig_model_path is not set")

    import mediapipe as mp

    rgb = np.asarray(image.convert("RGB"))
    with _lock:
        result = _landmarker_for(path).detect(
            mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
        )
    if not result.face_landmarks:
        return None
    width, height = image.size
    marks = result.face_landmarks[0]
    return FaceLandmarks(
        points=np.array([[lm.x * width, lm.y * height] for lm in marks], dtype=np.float64),
        z=np.array([lm.z * width for lm in marks], dtype=np.float64),
    )
