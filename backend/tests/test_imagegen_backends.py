"""Multi-backend image generation, and salvage instead of rejection."""

import io

import numpy as np
import pytest
from PIL import Image

from app.services.imagegen import IMAGE_BACKENDS, configured_backends
from app.services.riggable import MIN_FACE_FRACTION, salvage_portrait


def test_only_keyed_backends_participate(monkeypatch):
    """A backend without a key is silently absent, not an error mid-batch."""
    from app.core.credentials import credentials

    values = {"gemini_api_key": "g", "dashscope_api_key": None, "openai_api_key": None}
    monkeypatch.setattr(credentials, "get", lambda name: values.get(name))
    assert configured_backends() == ["gemini"]

    values["openai_api_key"] = "o"
    assert configured_backends() == ["gemini", "openai"]

    values["dashscope_api_key"] = "q"
    assert configured_backends() == ["gemini", "openai", "qwen"]


def test_backend_order_is_stable():
    """The order is the display order; a set would shuffle candidates
    between clicks and make comparisons feel random."""
    assert IMAGE_BACKENDS == ("gemini", "openai", "qwen")


def _wide_shot(width=1536, height=1024):
    """A 'cinematic' frame with a face-sized region at 15% of the width —
    the exact geometry six paid generations were discarded for."""
    rgb = np.full((height, width, 3), 200, dtype=np.uint8)
    buf = io.BytesIO()
    Image.fromarray(rgb).save(buf, format="PNG")
    return buf.getvalue()


def test_a_small_but_detected_face_is_salvaged_by_cropping(monkeypatch):
    from app.core import config

    monkeypatch.setattr(config.get_settings(), "rig_model_path", "/x.task", raising=False)

    # The detector "finds" a face 230px wide in a 1536px frame (15%).
    face = np.zeros((478, 2))
    face[:, 0] = np.linspace(650, 880, 478)
    face[:, 1] = np.linspace(300, 590, 478)
    import app.services.rig as rig_module

    monkeypatch.setattr(rig_module, "_mediapipe_landmarks", lambda image: face)

    out = salvage_portrait(_wide_shot())
    assert out is not None
    cropped = Image.open(io.BytesIO(out))
    # The crop puts the 230px face at ~30% of the width — above the floor.
    assert (880 - 650) / cropped.width > MIN_FACE_FRACTION
    # And keeps headroom + shoulders rather than cutting at the chin.
    assert cropped.height >= (590 - 300) * 1.6


def test_no_face_means_nothing_to_salvage(monkeypatch):
    from app.core import config

    monkeypatch.setattr(config.get_settings(), "rig_model_path", "/x.task", raising=False)
    import app.services.rig as rig_module

    def boom(image):
        raise ValueError("no face detected")

    monkeypatch.setattr(rig_module, "_mediapipe_landmarks", boom)
    assert salvage_portrait(_wide_shot()) is None


def test_unreadable_bytes_do_not_crash_salvage(monkeypatch):
    from app.core import config

    monkeypatch.setattr(config.get_settings(), "rig_model_path", "/x.task", raising=False)
    assert salvage_portrait(b"not an image") is None
