"""Cut the subject out of a portrait, leaving a transparent background.

Uses MediaPipe's selfie segmenter — the same toolkit already carrying the face
landmarker, so this adds a 244KB model rather than a new dependency tree. The
obvious alternative, rembg/u2net, is a 176MB model plus onnxruntime, which is
a lot of weight for one optional step in a service that otherwise stays light.

The cut-out is deliberately conservative at the edges. A hard threshold on the
confidence mask leaves a jagged one-pixel fringe of the old background, which
is exactly what makes a bad cut-out look bad — especially around hair, where
the mask is least certain. Feathering the alpha through the uncertain band and
un-mixing the background colour from those pixels costs a few milliseconds and
removes the halo.
"""

from __future__ import annotations

import io
import logging
from functools import lru_cache

logger = logging.getLogger("liveface.segment")

# Below this the pixel is background, above it foreground; between them the
# alpha ramps, which is what gives hair a soft edge instead of a staircase.
ALPHA_LOW = 0.35
ALPHA_HIGH = 0.65


class SegmentationUnavailable(RuntimeError):
    """No segmenter model is configured on this instance."""


@lru_cache(maxsize=1)
def _segmenter():
    """Built once. Model load dominates the cost, and the object is reusable."""
    from mediapipe.tasks import python as mp_python
    from mediapipe.tasks.python import vision

    from app.core.config import get_settings

    path = get_settings().segment_model_path
    if not path:
        raise SegmentationUnavailable("segment_model_path is not set")
    return vision.ImageSegmenter.create_from_options(
        vision.ImageSegmenterOptions(
            base_options=mp_python.BaseOptions(model_asset_path=path),
            output_category_mask=False,
            output_confidence_masks=True,
        )
    )


def remove_background(image_bytes: bytes) -> bytes:
    """Return a PNG of the same size with the background made transparent."""
    import numpy as np
    from PIL import Image

    import mediapipe as mp

    segmenter = _segmenter()  # raises SegmentationUnavailable if not configured

    source = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    rgb = np.asarray(source)

    result = segmenter.segment(mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb))
    if not result.confidence_masks:
        raise SegmentationUnavailable("segmenter returned no mask")
    # The last mask is the person channel for the selfie model.
    mask = np.asarray(result.confidence_masks[-1].numpy_view(), dtype=np.float32)
    if mask.ndim == 3:
        mask = mask[:, :, 0]

    # Smooth ramp rather than a step, so hair and shoulders feather out.
    alpha = np.clip((mask - ALPHA_LOW) / (ALPHA_HIGH - ALPHA_LOW), 0.0, 1.0)

    # Un-mix the background from the partially transparent band. Those pixels
    # are a blend of subject and background; leaving them as-is paints a rim
    # of the old backdrop around the whole figure — the classic halo. Dividing
    # the colour back out recovers the subject's own colour there.
    out = rgb.astype(np.float32)
    edge = (alpha > 0.02) & (alpha < 0.98)
    if edge.any():
        background = _estimate_background(rgb, alpha)
        a = alpha[edge][:, None]
        out[edge] = np.clip((out[edge] - background * (1 - a)) / np.maximum(a, 0.15), 0, 255)

    rgba = np.dstack([out.astype(np.uint8), (alpha * 255).astype(np.uint8)])
    buffer = io.BytesIO()
    Image.fromarray(rgba, mode="RGBA").save(buffer, format="PNG", optimize=True)
    return buffer.getvalue()


def _estimate_background(rgb, alpha):
    """Average colour of the confidently-background pixels.

    A single colour is enough here: portraits are shot against a wall or a
    blurred field, and the value is only used to un-mix a thin edge band, so
    a per-pixel estimate would cost far more than it improves.
    """
    import numpy as np

    background_pixels = rgb[alpha < 0.02]
    if background_pixels.size == 0:
        return np.zeros(3, dtype=np.float32)
    return background_pixels.mean(axis=0).astype(np.float32)
