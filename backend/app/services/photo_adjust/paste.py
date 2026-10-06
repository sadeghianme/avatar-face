"""Putting a touch-up's answer back: colour in LAB, the similarity that
aligns the answer on stable landmarks, the masks, and the masked paste of
the eyes and lips with the photo's own grain."""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import cast

import numpy as np
from PIL import Image

from app.services.photo_adjust.scheme import (
    BROW_GUARD,
    BROW_IMAGE_LEFT,
    BROW_IMAGE_RIGHT,
    CHIN,
    EYE_DILATE,
    EYE_FEATHER,
    EYE_IMAGE_LEFT,
    EYE_IMAGE_RIGHT,
    FACE_OVAL,
    LIP_DILATE,
    LIP_FEATHER,
    LIPS,
    MAX_ALIGN_RESIDUAL,
    MAX_JAW_SHIFT,
    NOSE_TIP,
    RING_WIDTH,
    STABLE,
    AdjustSkipped,
)

# --- Colour ---------------------------------------------------------------------

_D65 = np.array([0.95047, 1.0, 1.08883])
_RGB_TO_XYZ = np.array(
    [[0.4124564, 0.3575761, 0.1804375],
     [0.2126729, 0.7151522, 0.0721750],
     [0.0193339, 0.1191920, 0.9503041]]
)
_XYZ_TO_RGB = np.linalg.inv(_RGB_TO_XYZ)


def rgb_to_lab(rgb: np.ndarray) -> np.ndarray:
    """sRGB (0-255, any shape ending in 3) to CIE LAB (D65)."""
    c = np.asarray(rgb, dtype=np.float64) / 255.0
    linear = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    xyz = linear @ _RGB_TO_XYZ.T / _D65
    f = np.where(xyz > (6 / 29) ** 3, np.cbrt(xyz), xyz / (3 * (6 / 29) ** 2) + 4 / 29)
    return np.stack(
        (116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]), 200 * (f[..., 1] - f[..., 2])),
        axis=-1,
    )


def lab_to_rgb(lab: np.ndarray) -> np.ndarray:
    """CIE LAB (D65) to sRGB 0-255 floats, clipped."""
    lab = np.asarray(lab, dtype=np.float64)
    fy = (lab[..., 0] + 16) / 116
    fx = fy + lab[..., 1] / 500
    fz = fy - lab[..., 2] / 200
    f = np.stack((fx, fy, fz), axis=-1)
    xyz = np.where(f > 6 / 29, f ** 3, 3 * (6 / 29) ** 2 * (f - 4 / 29)) * _D65
    linear = np.clip(xyz @ _XYZ_TO_RGB.T, 0.0, 1.0)
    c = np.where(linear <= 0.0031308, linear * 12.92, 1.055 * linear ** (1 / 2.4) - 0.055)
    return np.clip(c * 255.0, 0.0, 255.0)


def delta_e(a: np.ndarray, b: np.ndarray, l_weight: float = 1.0) -> float:
    d = np.asarray(a, dtype=np.float64) - np.asarray(b, dtype=np.float64)
    return float(math.sqrt((l_weight * d[0]) ** 2 + d[1] ** 2 + d[2] ** 2))


# --- Geometry -------------------------------------------------------------------


def similarity_transform(src: np.ndarray, dst: np.ndarray) -> np.ndarray:
    """The 2x3 similarity (scale, rotation, translation) taking `src` onto
    `dst` in the least-squares sense (Umeyama). No reflection."""
    src = np.asarray(src, dtype=np.float64)
    dst = np.asarray(dst, dtype=np.float64)
    mu_s, mu_d = src.mean(axis=0), dst.mean(axis=0)
    xs, xd = src - mu_s, dst - mu_d
    var_s = float((xs ** 2).sum()) / len(src)
    if var_s <= 0:
        raise ValueError("degenerate landmarks")
    u, s, vt = np.linalg.svd(xd.T @ xs / len(src))
    d = np.eye(2)
    if np.linalg.det(u) * np.linalg.det(vt) < 0:
        d[1, 1] = -1
    rotation = u @ d @ vt
    scale = float(np.trace(np.diag(s) @ d)) / var_s
    translation = mu_d - scale * rotation @ mu_s
    return np.hstack((scale * rotation, translation[:, None]))


def apply(matrix: np.ndarray, points: np.ndarray) -> np.ndarray:
    return np.asarray(points, dtype=np.float64) @ matrix[:, :2].T + matrix[:, 2]


def _invert(matrix: np.ndarray) -> np.ndarray:
    full = np.vstack((matrix, [0.0, 0.0, 1.0]))
    return np.linalg.inv(full)[:2]


def align(result_points: np.ndarray, source_points: np.ndarray) -> tuple[np.ndarray, float]:
    """(matrix result→photo, RMS residual in photo pixels), from the stable
    landmarks. One trimming pass drops the few a model moved anyway (a
    strand of hair over the brow shifts the oval there)."""
    src = result_points[STABLE]
    dst = source_points[STABLE]
    matrix = similarity_transform(src, dst)
    residual = np.linalg.norm(apply(matrix, src) - dst, axis=1)
    keep = residual <= max(2.5 * float(np.median(residual)), 1.0)
    if keep.sum() >= 6 and not keep.all():
        matrix = similarity_transform(src[keep], dst[keep])
        residual = np.linalg.norm(apply(matrix, src[keep]) - dst[keep], axis=1)
    return matrix, float(np.sqrt(np.mean(residual ** 2)))


def _hull_mask(shape: tuple[int, ...], polygons: list[np.ndarray]) -> np.ndarray:
    """Union of the convex hulls of `polygons` (pixel coords of the window)."""
    from scipy.spatial import ConvexHull, QhullError

    hulls = []
    for pts in polygons:
        try:
            hulls.append(pts[ConvexHull(pts).vertices])
        except (QhullError, ValueError):
            hulls.append(pts)
    return _polygon_mask(shape, hulls)


def _polygon_mask(shape: tuple[int, ...], polygons: list[np.ndarray]) -> np.ndarray:
    """Union of `polygons` as drawn, in their point order (a contour, not
    its hull)."""
    from PIL import ImageDraw

    canvas = Image.new("L", (shape[1], shape[0]), 0)
    draw = ImageDraw.Draw(canvas)
    for pts in polygons:
        if len(pts) >= 3:
            draw.polygon([tuple(p) for p in np.asarray(pts).tolist()], fill=255)
    return np.asarray(canvas) > 0


def _smoothstep(t: np.ndarray) -> np.ndarray:
    t = np.clip(t, 0.0, 1.0)
    return t * t * (3 - 2 * t)


# Scales a median absolute deviation to the standard deviation of the same
# data if it were Gaussian.
_MAD_TO_STD = 1.4826


def _grain(luma: np.ndarray, where: np.ndarray) -> float:
    """Grain: the spread of what a 1-pixel blur removes, over `where`.

    Robust (the MAD, scaled to a standard deviation), because the ring is
    mostly skin but not only: a few hairs, a lash or a mole leave large
    high-pass values that a plain standard deviation would read as heavy
    grain, and white noise of that size would then speckle the whole patch.
    Sensor grain is the bulk of the distribution, which the median keeps.
    """
    from scipy.ndimage import gaussian_filter

    if where.sum() < 16:
        return 0.0
    detail = (luma - gaussian_filter(luma, 1.0))[where]
    return float(_MAD_TO_STD * np.median(np.abs(detail - np.median(detail))))


def _antialiased(result: Image.Image, to_result: np.ndarray) -> Image.Image:
    """The answer, low-passed for the shrink `to_result` makes (answer pixels
    per photo pixel) when it shrinks at all.

    The warp is a fixed 4-tap bicubic, which does not average: shrinking a
    1024 px answer onto a small face samples its finest detail (lashes, iris
    texture) instead of averaging it, and the pasted eyes come out jagged,
    sparkling and crisper than the upscaled face around them. The blur
    brings the answer to the softness a shrink by that factor should have
    (a Gaussian of half a destination pixel, less the half a source pixel
    the answer already has).
    """
    from scipy.ndimage import gaussian_filter

    scale = math.sqrt(abs(float(np.linalg.det(to_result[:, :2]))))
    if scale <= 1.0:
        return result
    sigma = 0.5 * math.sqrt(scale * scale - 1.0)
    if sigma < 0.2:
        return result
    blurred = gaussian_filter(np.asarray(result, dtype=np.float64), sigma=(sigma, sigma, 0))
    return Image.fromarray(np.clip(blurred, 0, 255).round().astype(np.uint8))


@dataclass
class Region:
    name: str
    source: np.ndarray  # landmark positions in the photo
    result: np.ndarray  # the answer's landmarks, mapped into the photo
    dilate: float
    feather: float
    # Contours never pasted onto nor measured on (the brows, for an eye),
    # in the photo and where the answer has them.
    keep_out: tuple[np.ndarray, ...] = ()
    # Hulls the colour ring must lie inside, every one of them (the face
    # ovals, for the lips): skin both images agree is skin.
    within: tuple[np.ndarray, ...] = ()


def _paste_region(
    out: np.ndarray,
    source_rgb: np.ndarray,
    result: Image.Image,
    to_result: np.ndarray,
    region: Region,
    rng: np.random.Generator,
) -> None:
    """Blend one region of the aligned answer into `out`, in place."""
    from scipy.ndimage import distance_transform_edt

    both = np.vstack((region.source, region.result))
    size = float(max(np.ptp(both[:, 0]), np.ptp(both[:, 1]), 1.0))
    dilate, feather = region.dilate * size, max(region.feather * size, 1.0)
    ring = max(RING_WIDTH * size, 3.0)
    reach = dilate + feather + ring + 2
    height, width = out.shape[:2]
    x0 = max(0, int(math.floor(both[:, 0].min() - reach)))
    y0 = max(0, int(math.floor(both[:, 1].min() - reach)))
    x1 = min(width, int(math.ceil(both[:, 0].max() + reach)))
    y1 = min(height, int(math.ceil(both[:, 1].max() + reach)))
    if x1 - x0 < 2 or y1 - y0 < 2:
        return
    window = (y1 - y0, x1 - x0)

    # The answer, resampled onto this window of the photo's pixel grid.
    shift = np.array([[1.0, 0.0, x0], [0.0, 1.0, y0]])
    m = to_result @ np.vstack((shift, [0.0, 0.0, 1.0]))
    coeffs = (m[0, 0], m[0, 1], m[0, 2], m[1, 0], m[1, 1], m[1, 2])
    warped = np.asarray(
        result.transform((window[1], window[0]), Image.Transform.AFFINE, coeffs,
                         resample=Image.Resampling.BICUBIC),
        dtype=np.float64,
    )
    covered = np.asarray(
        Image.new("L", result.size, 255).transform(
            (window[1], window[0]), Image.Transform.AFFINE, coeffs,
            resample=Image.Resampling.BILINEAR,
        ),
        dtype=np.float64,
    ) / 255.0

    offset = np.array([x0, y0])
    hull = _hull_mask(window, [region.source - offset, region.result - offset])
    # The distances alone (scipy's stub also allows the indices it returns
    # only when asked for them); likewise below.
    distance = cast(np.ndarray, distance_transform_edt(~hull))
    alpha = 1.0 - _smoothstep((distance - dilate) / feather)
    alpha *= np.clip((covered - 0.99) * 100.0, 0.0, 1.0)  # fully inside the answer only
    ring_mask = (distance > dilate + feather) & (distance <= dilate + feather + ring) & (
        covered > 0.999
    )
    if region.keep_out:
        # Nothing of the answer lands on a brow, fading in over BROW_GUARD
        # of the region's size, and the brow is not skin to measure.
        outside = _polygon_mask(window, [p - offset for p in region.keep_out])
        guard = max(BROW_GUARD * size, 1.0)
        clear = cast(np.ndarray, distance_transform_edt(~outside))
        alpha *= _smoothstep(clear / guard)
        ring_mask &= clear > guard
    for polygon in region.within:
        ring_mask &= _hull_mask(window, [polygon - offset])
    if not alpha.any():
        return

    original = source_rgb[y0:y1, x0:x1].astype(np.float64)
    source_lab = rgb_to_lab(original)
    result_lab = rgb_to_lab(warped)
    if ring_mask.sum() >= 16:
        # The model relights what it redraws; the ring around the region is
        # skin both images should agree on, so their difference there is
        # the correction. The median, so a stray hair or shadow in the ring
        # does not shift the whole patch.
        result_lab = result_lab + (
            np.median(source_lab[ring_mask], axis=0) - np.median(result_lab[ring_mask], axis=0)
        )
        # Grain: a phone photo is noisier than a model's output. Add the
        # missing noise to lightness, so the patch does not read as smooth.
        missing = _grain(source_lab[..., 0], ring_mask) ** 2 - _grain(
            result_lab[..., 0], ring_mask
        ) ** 2
        if missing > 0:
            result_lab[..., 0] += rng.normal(0.0, math.sqrt(missing), size=window)
    matched = lab_to_rgb(result_lab)
    # Composited over what earlier regions already wrote (they never overlap
    # on a face, but a very small face could make them touch). Where alpha
    # is 0 the pixel is left exactly as it was, not re-rounded.
    below = out[y0:y1, x0:x1].astype(np.float64)
    blended = below * (1 - alpha[..., None]) + matched * alpha[..., None]
    out[y0:y1, x0:x1] = np.where(
        alpha[..., None] > 0, np.clip(blended, 0, 255).round(), below
    ).astype(np.uint8)


def jaw_shift(source_points: np.ndarray, mapped: np.ndarray) -> float:
    """How far the answer's chin sits from the photo's once aligned, as a
    fraction of the face height (the median over the chin landmarks)."""
    height = float(np.ptp(source_points[:, 1])) or 1.0
    moved = np.linalg.norm(mapped[CHIN] - source_points[CHIN], axis=1)
    return float(np.median(moved)) / height


def paste_back(
    source: Image.Image,
    source_points: np.ndarray,
    result: Image.Image,
    result_points: np.ndarray,
) -> Image.Image:
    """The photo with only the answer's eye and lip regions pasted in.

    Raises AdjustSkipped("alignment_failed") when the stable landmarks do not
    agree: the model moved or reshaped the face, and a paste would put eyes
    beside the eyes. Raises AdjustSkipped("jaw_moved") when the answer's
    chin is not where the photo's is: closed lips pasted above a dropped
    chin make a face longer than the person's.
    """
    matrix, residual = align(result_points, source_points)
    face_width = float(np.ptp(source_points[:, 0])) or 1.0
    if residual > MAX_ALIGN_RESIDUAL * face_width:
        raise AdjustSkipped(
            "alignment_failed",
            "The AI moved the face too much to put its eyes and lips back onto the photo",
        )
    mapped = apply(matrix, result_points)
    if jaw_shift(source_points, mapped) > MAX_JAW_SHIFT:
        raise AdjustSkipped(
            "jaw_moved",
            "Closing the mouth moved the jaw, so new lips would not fit this photo; "
            "regenerate it instead",
        )
    to_result = _invert(matrix)
    source_rgb = np.asarray(source.convert("RGB"))
    out = source_rgb.copy()
    rng = np.random.default_rng(int(source_points[NOSE_TIP].sum() * 1000) % (2 ** 32))
    answer = _antialiased(result.convert("RGB"), to_result)
    ovals = (source_points[FACE_OVAL], mapped[FACE_OVAL])
    for region in (
        Region("eye_left", source_points[EYE_IMAGE_LEFT], mapped[EYE_IMAGE_LEFT],
               EYE_DILATE, EYE_FEATHER,
               keep_out=(source_points[BROW_IMAGE_LEFT], mapped[BROW_IMAGE_LEFT])),
        Region("eye_right", source_points[EYE_IMAGE_RIGHT], mapped[EYE_IMAGE_RIGHT],
               EYE_DILATE, EYE_FEATHER,
               keep_out=(source_points[BROW_IMAGE_RIGHT], mapped[BROW_IMAGE_RIGHT])),
        Region("lips", source_points[LIPS], mapped[LIPS], LIP_DILATE, LIP_FEATHER,
               within=ovals),
    ):
        _paste_region(out, source_rgb, answer, to_result, region, rng)
    return Image.fromarray(out)
