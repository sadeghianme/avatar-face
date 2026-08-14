"""Layer decomposition: the composite must equal the photo it came from."""

import io

import numpy as np
import pytest
from PIL import Image

from app.services.layers import build_layers


def _cutout_portrait(width=200, height=260):
    """A synthetic RGBA 'person': head disc over a body rectangle."""
    rgba = np.zeros((height, width, 4), dtype=np.uint8)
    yy, xx = np.mgrid[0:height, 0:width]
    head = (xx - 100) ** 2 + (yy - 80) ** 2 < 55**2
    body = (yy > 120) & (np.abs(xx - 100) < 70)
    person = head | body
    rgba[..., 0] = np.where(head, 210, 60)
    rgba[..., 1] = np.where(person, 140, 0)
    rgba[..., 2] = np.where(body, 190, 40)
    rgba[..., 3] = np.where(person, 255, 0)
    buf = io.BytesIO()
    Image.fromarray(rgba, "RGBA").save(buf, format="PNG")
    # face box roughly on the head disc
    return buf.getvalue(), [60.0, 40.0, 140.0, 120.0], rgba


def test_cutout_layers_have_no_background_and_recompose_exactly():
    data, face_box, original = _cutout_portrait()
    layers = build_layers(data, face_box)

    assert set(layers) == {"body", "head"}  # nothing exists behind a cut-out

    body = np.asarray(Image.open(io.BytesIO(layers["body"])).convert("RGBA")).astype(np.float64)
    head = np.asarray(Image.open(io.BytesIO(layers["head"])).convert("RGBA")).astype(np.float64)

    # head OVER body, straight alpha compositing
    ha = head[..., 3:] / 255.0
    ba = body[..., 3:] / 255.0
    out_a = ha + ba * (1 - ha)
    safe = np.maximum(out_a, 1e-6)
    out_rgb = (head[..., :3] * ha + body[..., :3] * ba * (1 - ha)) / safe

    opaque = original[..., 3] == 255
    # Alpha recomposes to full coverage wherever the person was...
    assert float(np.abs(out_a[..., 0][opaque] - 1.0).max()) < 0.02
    # ...and the colours are the original photo's, not a blend of guesses.
    diff = np.abs(out_rgb[opaque] - original[..., :3][opaque].astype(np.float64))
    assert float(diff.max()) <= 2.0


def test_head_layer_stops_at_the_neck():
    data, face_box, _ = _cutout_portrait()
    layers = build_layers(data, face_box)
    head = np.asarray(Image.open(io.BytesIO(layers["head"])).convert("RGBA"))
    fy1 = face_box[3]
    face_h = fy1 - face_box[1]
    below = head[int(fy1 + face_h * 0.4) :, :, 3]
    assert below.max() == 0  # the torso must not ride the head


def test_opaque_photo_without_segmenter_raises():
    """No segmenter configured -> build fails -> caller keeps has_layers False."""
    from app.services.segment import SegmentationUnavailable

    rgb = np.full((120, 100, 3), 128, dtype=np.uint8)
    buf = io.BytesIO()
    Image.fromarray(rgb, "RGB").save(buf, format="PNG")
    with pytest.raises(SegmentationUnavailable):
        build_layers(buf.getvalue(), [20.0, 20.0, 80.0, 80.0])
