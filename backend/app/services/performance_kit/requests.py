"""1b. Request preparation: the face and head crops an answer is asked
for on, and the request for each shape."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from PIL import Image

from app.services import imagegen, photo_adjust
from app.services.performance_kit.constants import TEETH
from app.services.performance_kit.prompts import POSE_PROMPTS, request_prompt

FACE_CROP = "face_crop"
HEAD_CROP = "head_crop"


@dataclass(frozen=True)
class PoseRequest:
    """One edit to send, and where its picture came from in the base photo."""

    shape: str  # one of SHAPES, or TEETH
    kind: str  # FACE_CROP, or HEAD_CROP after a refusal
    prompt: str
    payload: bytes
    mime: str
    # The rectangle of the base photo the payload shows, in base pixels:
    # a square for either kind (it may reach past the photo's edge).
    box: tuple[float, float, float, float]

    @property
    def aspect(self) -> float:
        """Width over height of what was sent (1 for both crops)."""
        x0, y0, x1, y1 = self.box
        return (x1 - x0) / (y1 - y0)

    def to_base(self, answer_size: tuple[int, int]) -> np.ndarray:
        """2x3 matrix from answer pixels to base pixels, assuming the answer
        shows the same rectangle (the registration corrects what it does not).
        An answer of another shape never gets here (register_answer refuses
        it, aspect_changed), so both axes get the same scale."""
        x0, y0, x1, y1 = self.box
        width, height = answer_size
        return np.array([[(x1 - x0) / width, 0.0, x0], [0.0, (y1 - y0) / height, y0]])


@dataclass(frozen=True)
class _Crop:
    kind: str
    payload: bytes
    box: tuple[float, float, float, float]


def _base_image(base_png: bytes) -> Image.Image:
    """What the model and the detector are shown: a cut-out on the neutral
    grey (photo_adjust's own decoding, so a kit sees what AI adjust sees)."""
    return photo_adjust._rgb(base_png)


def head_square(
    image_size: tuple[int, int], points: np.ndarray
) -> tuple[float, float, float] | None:
    """(x0, y0, side): AI adjust's head-and-shoulders crop
    (photo_adjust.head_crop_box, clipped to the photo) padded to a square
    about its centre, reaching past the photo's edge where it must (filled
    with the photo's own edge, as the face crop is). None when that crop is
    the whole photo: the same picture again would be the same request.

    Square, like the face crop, because the head box itself is 6:7 (5:6 or
    so once clipped), a shape the model does not answer in: a model that
    keeps the head's proportions and reframes to its own aspect, rather
    than stretching, would map back with a different scale per axis
    (PoseRequest.to_base) and put the mouth 0.1-0.2 mouth widths off while
    passing every guard. A square is answered as a square, and an answer
    that is not is refused (register_answer, aspect_changed)."""
    x0, y0, x1, y1 = (float(int(round(v))) for v in photo_adjust.head_crop_box(image_size, points))
    if (x0, y0, x1, y1) == (0.0, 0.0, float(image_size[0]), float(image_size[1])):
        return None
    width, height = x1 - x0, y1 - y0
    side = max(width, height)
    return x0 - (side - width) / 2, y0 - (side - height) / 2, side


def _crop(image: Image.Image, points: np.ndarray, kind: str) -> _Crop | None:
    """The picture sent for `kind`, reusing AI adjust's crops, both square.
    None when the head crop would be the whole photo (head_square)."""
    if kind == FACE_CROP:
        x0, y0, side = photo_adjust.face_crop_box(points)
        payload = photo_adjust._jpeg(photo_adjust.crop_face(image, (x0, y0, side)),
                                     photo_adjust.CROP_QUALITY)
        return _Crop(kind, payload, (x0, y0, x0 + side, y0 + side))
    square = head_square(image.size, points)
    if square is None:
        return None
    x0, y0, side = square
    # At the photo's own resolution, as before it was squared: never
    # enlarged, at most the edge a source is sent at.
    edge = min(int(round(side)), photo_adjust.SOURCE_MAX_EDGE)
    crop = photo_adjust.crop_face(image, square, size=edge)
    return _Crop(kind, photo_adjust._jpeg(crop, imagegen.SOURCE_QUALITY),
                 (x0, y0, x0 + side, y0 + side))


def prepare_pose_request(
    base_png: bytes, base_points: np.ndarray, shape: str, kind: str = FACE_CROP
) -> PoseRequest | None:
    """The edit for one shape (or the teeth photo, TEETH): the face crop
    (the same kind AI adjust's touch-up sends, 1.6 face boxes at 1024 px),
    or after a refusal the head-and-shoulders crop, squared (head_square).
    None only for a head crop that would be the whole photo. CPU work."""
    if shape not in POSE_PROMPTS and shape != TEETH:
        raise ValueError(f"unknown shape {shape!r}")
    crop = _crop(_base_image(base_png), _checked_points(base_points), kind)
    return None if crop is None else _request(shape, crop)


def _request(shape: str, crop: _Crop) -> PoseRequest:
    return PoseRequest(shape, crop.kind, request_prompt(shape), crop.payload, "image/jpeg",
                       crop.box)


def _checked_points(points) -> np.ndarray:
    array = np.asarray(points, dtype=np.float64)
    if array.shape != (478, 2) or not np.isfinite(array).all():
        raise ValueError("base_points must be 478 finite (x, y) pixel positions")
    return array
