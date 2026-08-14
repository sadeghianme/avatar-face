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

# Thresholds and the edge treatment live in matting.py, which turns this
# model's coarse mask into an actual alpha matte.


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


def person_matte(image_bytes: bytes, prior_mask=None):
    """(rgb float HxWx3, alpha float HxW) for the person in the photo.

    The shared front half of background removal and layer building: run the
    segmenter, then refine its coarse mask into a real matte (see matting.py —
    the raw mask alone produces the backdrop-coloured rim that makes a
    cut-out look cheap).

    `prior_mask` (float HxW, 0..1) is region the caller KNOWS is person —
    typically a head ellipse from the face landmarks. It is merged into the
    model's mask BEFORE refinement, which matters: the segmenter misfires on
    illustrations, and a mid-confidence face goes through edge un-mixing,
    which subtracts the backdrop colour out of skin and leaves literal black.
    A confident prior keeps those pixels out of the edge band entirely.
    """
    import numpy as np
    from PIL import Image

    import mediapipe as mp

    from app.services.matting import refine_matte

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
    if prior_mask is not None:
        mask = np.maximum(mask, prior_mask.astype(np.float32))

    alpha, out = refine_matte(rgb, mask)
    return out, alpha


def remove_background(image_bytes: bytes) -> bytes:
    """Return a PNG of the same size with the background made transparent."""
    import io as _io

    import numpy as np
    from PIL import Image

    out, alpha = person_matte(image_bytes)
    rgba = np.dstack([out.astype(np.uint8), (alpha * 255).astype(np.uint8)])
    buffer = _io.BytesIO()
    Image.fromarray(rgba, mode="RGBA").save(buffer, format="PNG", optimize=True)
    return buffer.getvalue()


