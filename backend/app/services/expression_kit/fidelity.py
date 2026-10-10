"""3. The source's own skin, kept in an expression picture.

Asked to keep the skin, the image model still redraws it: on the trial's
photographs, a little more grain and fine lines (a few years older, the
blind judges said) and a slightly darker, greyer tone. What an expression
changes of the skin is its large forms (a cheek raised, a brow lifted, the
creases it makes), never its pores or its colour, so both are taken back
from the source:

1. the source (the same crop the model was sent) is warped onto the
   answer's landmarks, a thin-plate spline through the 478 points;
2. on the skin (the face's outline, less the eyes and the lips' opening),
   the answer's finest detail, under `DETAIL_SIGMA` face widths, is
   replaced by the warped source's: its pores and grain, not the model's;
3. the skin's colour is shifted back to the source's: the mean Lab over
   patches an expression does not shade (the nose, the mid cheeks, the
   chin), applied smoothly over the face.

Measured on the trial (ten pictures, two faces): the skin's colour
difference 1.2-3.1 delta E before, 0.7-3.1 after; the fine texture of
Sakineh's smile 1.23 times the source's before, 0.98 after. CPU work, about
a second for a 1024-pixel crop.
"""

from __future__ import annotations

import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from scipy.interpolate import RBFInterpolator
from scipy.ndimage import gaussian_filter, map_coordinates, zoom

from app.services.expression_kit.constants import FACE_LEFT, FACE_RIGHT

# fmt: off
FACE_OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378,
             400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54,
             103, 67, 109]
LEFT_EYE = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246]
RIGHT_EYE = [362, 382, 381, 380, 374, 373, 390, 249, 263, 466, 388, 387, 386, 385, 384, 398]
INNER_LIPS = [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308, 415, 310, 311, 312, 13, 82,
              81, 80, 191]
# Skin an expression barely shades: the nose's bridge and sides, the mid
# cheeks, the chin.
STABLE_SKIN = [6, 197, 198, 209, 420, 429, 116, 117, 118, 345, 346, 347, 175, 199]
# fmt: on

# The finest detail swapped, as a Gaussian's sigma in face widths: pores and
# grain, under the creases an expression makes.
DETAIL_SIGMA = 0.008
# The patches the skin colour is measured on, as a half side in face widths.
PATCH = 0.03
# The warp is evaluated on a grid this many pixels apart, then interpolated.
GRID_STEP = 8

_RGB_TO_XYZ = np.array(
    [[0.4124, 0.3576, 0.1805], [0.2126, 0.7152, 0.0722], [0.0193, 0.1192, 0.9505]]
)
_WHITE = np.array([0.95047, 1.0, 1.08883])


def rgb_to_lab(rgb: np.ndarray) -> np.ndarray:
    """sRGB (0-255, any shape ending in 3) to CIE Lab (D65)."""
    srgb = np.asarray(rgb, dtype=np.float64) / 255.0
    linear = np.where(srgb > 0.04045, ((srgb + 0.055) / 1.055) ** 2.4, srgb / 12.92)
    xyz = linear @ _RGB_TO_XYZ.T / _WHITE
    f = np.where(xyz > 0.008856, np.cbrt(xyz), 7.787 * xyz + 16 / 116)
    return np.stack(
        [116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]), 200 * (f[..., 1] - f[..., 2])],
        axis=-1,
    )


def lab_to_rgb(lab: np.ndarray) -> np.ndarray:
    """CIE Lab (D65) back to sRGB, 0-255, clipped."""
    fy = (lab[..., 0] + 16) / 116
    f = np.stack([fy + lab[..., 1] / 500, fy, fy - lab[..., 2] / 200], axis=-1)
    xyz = np.where(f > 0.2069, f**3, (f - 16 / 116) / 7.787) * _WHITE
    linear = np.clip(xyz @ np.linalg.inv(_RGB_TO_XYZ).T, 0, 1)
    srgb = np.where(linear > 0.0031308, 1.055 * linear ** (1 / 2.4) - 0.055, 12.92 * linear)
    return np.clip(srgb * 255, 0, 255)


def warp_onto(
    source: np.ndarray, source_points: np.ndarray, target_points: np.ndarray
) -> np.ndarray:
    """`source` (H x W x 3) resampled so that its `source_points` land on
    `target_points`: a backward thin-plate spline, the picture's corners
    and edge middles held."""
    height, width = source.shape[:2]
    border = np.array(
        [
            [0, 0],
            [width, 0],
            [0, height],
            [width, height],
            [width / 2, 0],
            [width / 2, height],
            [0, height / 2],
            [width, height / 2],
        ],
        dtype=np.float64,
    )
    spline = RBFInterpolator(
        np.vstack([target_points, border]),
        np.vstack([source_points, border]),
        kernel="thin_plate_spline",
        smoothing=1.0,
    )
    gy, gx = np.mgrid[0:height:GRID_STEP, 0:width:GRID_STEP]
    coarse = spline(np.column_stack([gx.ravel(), gy.ravel()]).astype(np.float64))
    coarse = coarse.reshape(gy.shape + (2,))
    scale = (height / gy.shape[0], width / gx.shape[1])
    map_x = zoom(coarse[..., 0], scale, order=1)[:height, :width]
    map_y = zoom(coarse[..., 1], scale, order=1)[:height, :width]
    return np.stack(
        [
            map_coordinates(source[..., c], [map_y, map_x], order=3, mode="nearest")
            for c in range(3)
        ],
        axis=-1,
    )


def skin_mask(points: np.ndarray, size: tuple[int, int], face: float) -> np.ndarray:
    """The face's outline less the eyes and the lips' opening (each grown a
    little), feathered: 0 to 1, H x W."""
    mask = Image.new("L", size, 0)
    draw = ImageDraw.Draw(mask)
    draw.polygon([tuple(p) for p in points[FACE_OVAL].tolist()], fill=255)
    for ring in (LEFT_EYE, RIGHT_EYE, INNER_LIPS):
        centre = points[ring].mean(axis=0)
        grown = centre + (points[ring] - centre) * 1.15
        draw.polygon([tuple(p) for p in grown.tolist()], fill=0)
    mask = mask.filter(ImageFilter.GaussianBlur(face * 0.015))
    return np.asarray(mask, dtype=np.float32) / 255.0


def _patch_mean(lab: np.ndarray, points: np.ndarray, half: int) -> np.ndarray:
    height, width = lab.shape[:2]
    samples = []
    for index in STABLE_SKIN:
        x, y = (int(round(v)) for v in points[index])
        x0, y0 = max(x - half, 0), max(y - half, 0)
        x1, y1 = min(x + half, width), min(y + half, height)
        if x1 > x0 and y1 > y0:
            samples.append(lab[y0:y1, x0:x1].reshape(-1, 3))
    return np.concatenate(samples).mean(axis=0) if samples else np.zeros(3)


def _blur(rgb: np.ndarray, sigma: float) -> np.ndarray:
    return np.stack([gaussian_filter(rgb[..., c], sigma) for c in range(3)], axis=-1)


def keep_skin(
    source: Image.Image,
    source_points: np.ndarray,
    answer: Image.Image,
    answer_points: np.ndarray,
) -> Image.Image:
    """`answer` with the source's fine skin detail and skin colour (see the
    module docstring). `source` is the picture the model was sent, the same
    size as `answer` (a resized one is resampled to it), with its landmarks;
    `answer_points` are the answer's own, in its pixels."""
    if source.size != answer.size:
        scale = np.array(answer.size, dtype=np.float64) / np.array(source.size)
        source = source.resize(answer.size, Image.Resampling.LANCZOS)
        source_points = np.asarray(source_points, dtype=np.float64) * scale
    face = float(np.linalg.norm(answer_points[FACE_RIGHT] - answer_points[FACE_LEFT]))
    if face < 8:
        return answer.convert("RGB")
    drawn = np.asarray(answer.convert("RGB"), dtype=np.float64)
    original = np.asarray(source.convert("RGB"), dtype=np.float64)
    mask = skin_mask(answer_points, answer.size, face)[..., None]

    warped = warp_onto(original, np.asarray(source_points, dtype=np.float64), answer_points)
    sigma = face * DETAIL_SIGMA
    detail_drawn = drawn - _blur(drawn, sigma)
    detail_source = warped - _blur(warped, sigma)
    kept = drawn + mask * (detail_source - detail_drawn)

    half = max(3, int(face * PATCH))
    lab = rgb_to_lab(np.clip(kept, 0, 255))
    shift = _patch_mean(rgb_to_lab(original), source_points, half) - _patch_mean(
        lab, answer_points, half
    )
    spread = gaussian_filter(mask[..., 0], face * 0.05)[..., None]
    out = lab_to_rgb(lab + spread * shift)
    return Image.fromarray(np.clip(np.rint(out), 0, 255).astype(np.uint8))
