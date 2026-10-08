"""What is sent: the photo prepared for each mode (a touch-up's face crop
with its landmarks, the whole picture otherwise), and the head-and-
shoulders crop asked once more with after a refusal."""

from __future__ import annotations

import io
import math
from dataclasses import dataclass

import numpy as np
from PIL import Image

from app.services import imagegen, landmarks
from app.services.photo_adjust.scheme import (
    CROP_QUALITY,
    CROP_SCALE,
    CROP_SIZE,
    REGENERATE_PROMPTS,
    SOURCE_MAX_EDGE,
    STYLISE,
    TOUCHUP,
    TOUCHUP_PROMPT,
    AdjustSkipped,
)
from app.services.photo_analysis import (
    EYE_CLOSED_EAR,
    MAX_TOUCHUP_YAW,
    eye_aspect_ratios,
    yaw_offset,
)
from app.services.photo_io import on_backdrop


@dataclass
class Prepared:
    """What goes to the provider for one round, and what the paste needs."""

    prompt: str
    payload: bytes
    mime: str
    # Touch-up: the crop square in photo pixels (x0, y0, side) and the
    # photo's landmarks. None for whole-image modes.
    crop: tuple[float, float, float] | None = None
    source_points: np.ndarray | None = None
    # Touch-up of a photo whose eyes were closed: the eyes in the result
    # are the model's invention, and the wizard must say so.
    generated_eyes: bool = False


def _rgb(data: bytes) -> Image.Image:
    """Decode to what the model and the detector are shown: opaque RGB, a
    cut-out on the neutral grey backdrop (photo_io.on_backdrop). Black,
    what is under alpha 0, would read as a dark room to the model."""
    with Image.open(io.BytesIO(data)) as image:
        return on_backdrop(image)


def _own_rgb(data: bytes) -> Image.Image:
    """The image's own colour channels, not composited: what a touch-up
    pastes into, so a cut-out's pixels outside the eyes and lips stay its
    own to the bit (and zero under alpha 0)."""
    with Image.open(io.BytesIO(data)) as image:
        if image.mode in ("RGBA", "LA", "PA") or "transparency" in image.info:
            return image.convert("RGBA").convert("RGB")
        return image.convert("RGB")


def _alpha(data: bytes) -> Image.Image | None:
    """The alpha channel of a transparent image, or None for an opaque one."""
    with Image.open(io.BytesIO(data)) as image:
        if image.mode in ("RGBA", "LA", "PA") or "transparency" in image.info:
            return image.convert("RGBA").getchannel("A")
    return None


def _jpeg(image: Image.Image, quality: int) -> bytes:
    out = io.BytesIO()
    image.save(out, format="JPEG", quality=quality, optimize=True)
    return out.getvalue()


def face_crop_box(points: np.ndarray) -> tuple[float, float, float]:
    """(x0, y0, side): the square about the face box's centre, CROP_SCALE
    times its longer side. May reach past the photo (see `crop_face`)."""
    x0, y0 = points[:, 0].min(), points[:, 1].min()
    x1, y1 = points[:, 0].max(), points[:, 1].max()
    side = CROP_SCALE * max(x1 - x0, y1 - y0)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    return float(cx - side / 2), float(cy - side / 2), float(side)


def crop_face(
    image: Image.Image, box: tuple[float, float, float], size: int = CROP_SIZE
) -> Image.Image:
    """The crop square resampled to `size` (CROP_SIZE: the face crop). Past
    the photo's edge it is filled with the photo's own edge pixels: a black
    band would be a new edge the model might draw into the face. The
    performance kit squares its head-and-shoulders crop the same way.

    Lanczos through `resize`, not a fixed-kernel transform: a face wider
    than about 640 px makes a crop larger than CROP_SIZE, and a shrink that
    does not widen its kernel aliases hair and brow strands into moire the
    model then redraws. `resize` scales its support with the reduction."""
    x0, y0, side = box
    width, height = image.size
    pad = int(math.ceil(max(0.0, -x0, -y0, x0 + side - width, y0 + side - height))) + 2
    source = image
    if pad > 2:
        padded = np.pad(np.asarray(image), ((pad, pad), (pad, pad), (0, 0)), mode="edge")
        source = Image.fromarray(padded)
        x0, y0 = x0 + pad, y0 + pad
    return source.resize(
        (size, size),
        Image.Resampling.LANCZOS,
        box=(x0, y0, x0 + side, y0 + side),
    )


def eyes_closed(points: np.ndarray) -> bool:
    """Is either eye closed? The photo check's measure and threshold
    (photo_analysis.EYE_CLOSED_EAR), so the eyes a touch-up labels as
    generated are the ones the check called closed."""
    return min(eye_aspect_ratios(points)) < EYE_CLOSED_EAR


def _detect(image: Image.Image) -> np.ndarray | None:
    found = landmarks.detect(image)
    return None if found is None else found.points


def prepare(data: bytes, mode: str, face_type: str, style: str | None = None) -> Prepared:
    """What to send for `mode`. CPU work.

    Raises AdjustSkipped when a touch-up is impossible on this photo (no
    face found, no detector on this server, head turned too far), before
    anything is sent or spent.
    """
    image = _rgb(data)
    if mode == TOUCHUP:
        try:
            points = _detect(image)
        except landmarks.LandmarkerUnavailable as exc:
            raise AdjustSkipped(
                "landmarks_unavailable", "Face detection is not available on this server"
            ) from exc
        if points is None:
            raise AdjustSkipped(
                "no_face_for_touchup", "No face was found to touch up in this photo"
            )
        if yaw_offset(points) > MAX_TOUCHUP_YAW:
            raise AdjustSkipped(
                "face_turned",
                "The head is turned too far for a touch-up; use a photo facing the camera",
            )
        box = face_crop_box(points)
        return Prepared(
            prompt=TOUCHUP_PROMPT,
            payload=_jpeg(crop_face(image, box), CROP_QUALITY),
            mime="image/jpeg",
            crop=box,
            source_points=points,
            generated_eyes=eyes_closed(points),
        )

    if mode == STYLISE:
        prompt = imagegen.build_prompt(style or "illustrated", has_source=True)
    else:
        prompt = REGENERATE_PROMPTS[face_type]
    whole = image.copy()
    if max(whole.size) > SOURCE_MAX_EDGE:
        whole.thumbnail((SOURCE_MAX_EDGE, SOURCE_MAX_EDGE), Image.Resampling.LANCZOS)
    return Prepared(prompt=prompt, payload=_jpeg(whole, imagegen.SOURCE_QUALITY), mime="image/jpeg")


# A whole-photo edit the provider declines can pass as a head-and-shoulders
# crop of the same photo. Measured on 2026-09-25 against gemini-3.1-flash-image:
# every prompt on one full-frame portrait was blocked at the prompt
# (promptFeedback OTHER), and the same face cropped to 2.2 face widths was
# edited under the same prompts; at 2.8 it was blocked again. So a declined
# regenerate or stylise is asked once more with this crop: a different
# input, never the same request repeated.
FALLBACK_FACE_WIDTHS = 2.2


def head_crop_box(
    image_size: tuple[int, int], points: np.ndarray
) -> tuple[float, float, float, float]:
    """(x0, y0, x1, y1): the head-and-shoulders crop FALLBACK_FACE_WIDTHS
    face widths wide, clipped to the photo. Shared with the performance kit
    (services.performance_kit), whose declined pose edits retry on it."""
    x0, y0, side = face_crop_box(points)
    cx, cy = x0 + side / 2, y0 + side / 2
    width = side / CROP_SCALE * FALLBACK_FACE_WIDTHS
    # More room below the face than above: shoulders, not sky.
    return (
        max(0.0, cx - width / 2),
        max(0.0, cy - width / 2.4),
        min(float(image_size[0]), cx + width / 2),
        min(float(image_size[1]), cy + width * 0.75),
    )


def head_crop(image: Image.Image, points: np.ndarray) -> Image.Image | None:
    """The head-and-shoulders crop about the face `points` (head_crop_box),
    at most SOURCE_MAX_EDGE; None when it would be the whole picture.
    What a declined whole-photo edit, and a declined teeth photo
    (services.mouth_photo), is asked again with."""
    left, top, right, bottom = (int(round(v)) for v in head_crop_box(image.size, points))
    crop = image.crop((left, top, right, bottom))
    if crop.size == image.size:
        # The crop box reaches every edge: it is the same picture, and asking
        # again would be the same request. Anything smaller is worth the one
        # retry: a crop trimming 2% off that declined portrait was accepted.
        return None
    if max(crop.size) > SOURCE_MAX_EDGE:
        crop.thumbnail((SOURCE_MAX_EDGE, SOURCE_MAX_EDGE), Image.Resampling.LANCZOS)
    return crop


def head_crop_fallback(
    data: bytes, mode: str, face_type: str, style: str | None = None
) -> Prepared | None:
    """The same request on a head-and-shoulders crop, or None when there is
    no face to crop around (animals, a missing detector) or the mode already
    works on a crop (touch-up). CPU work."""
    if mode == TOUCHUP:
        return None
    image = _rgb(data)
    try:
        points = _detect(image)
    except landmarks.LandmarkerUnavailable:
        return None
    if points is None:
        return None
    crop = head_crop(image, points)
    if crop is None:
        return None
    whole = prepare(data, mode, face_type, style)
    return Prepared(
        prompt=whole.prompt,
        payload=_jpeg(crop, imagegen.SOURCE_QUALITY),
        mime="image/jpeg",
    )
