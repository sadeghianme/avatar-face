"""Turn a coarse segmentation mask into a clean alpha matte.

Kept separate from `segment.py` so the maths can be tested without the
MediaPipe model: everything here is pure numpy over arrays.

The problem this solves. A segmentation model answers "is this pixel part of
the person", which is a different question from "how much of this pixel is
person". At any real edge — and especially in hair — a pixel is a *mixture* of
subject and backdrop. Thresholding that into a hard yes/no leaves a rim of
backdrop-coloured pixels welded to the subject, which is the halo you see when
a cut-out is dropped onto a new background.

Three stages, each fixing a distinct failure:

1. Edge-aware refinement (guided filter). The model's mask is smooth and
   approximate; it does not know where the hair actually is. The guided filter
   pulls the mask onto edges that exist in the photograph, so strands of hair
   get their own alpha instead of being swallowed by a blur.

2. Local background estimation. The previous version averaged every background
   pixel into one colour. Backdrops are rarely one colour — studio sweeps
   vignette, walls catch light unevenly — so a single average is wrong almost
   everywhere, and un-mixing with a wrong colour *adds* a tint instead of
   removing one. The estimate here varies across the frame.

3. Colour un-mixing. With a per-pixel alpha and a local backdrop colour, the
   subject's true colour can be recovered from the mixture.
"""

from __future__ import annotations

# Radius of the guided filter, as a fraction of the smaller image side. Big
# enough to span a few strands of hair, small enough not to smear the jaw.
GUIDE_RADIUS_FRACTION = 0.008
MIN_GUIDE_RADIUS = 4

# Regularisation. Larger values smooth more and follow edges less. Measured
# on a real portrait: dropping this to 1e-6 looks better on noise-free
# synthetic data and worse on an actual photograph (backdrop residue 7.7% ->
# 9.5%), because at that point the filter starts fitting sensor noise.
GUIDE_EPS = 1e-4

# Two passes, same radius. The first fixes gross disagreement between the
# mask and the photo; the second sharpens what the first left soft. Measured
# on a real portrait, backdrop residue 7.7% -> 6.2%, with no loss of opacity
# inside the subject. A third pass buys nothing.
REFINE_PASSES = 2

# How far to look for backdrop colour when un-mixing an edge pixel.
BACKGROUND_RADIUS_FRACTION = 0.12

# Contrast applied after refinement. The guided filter returns a genuinely
# soft matte, so this is a gentle stretch, not the hard threshold it replaced.
ALPHA_LOW = 0.10
ALPHA_HIGH = 0.90

# Alpha below which a pixel counts as clean backdrop for colour estimation.
BACKGROUND_ALPHA = 0.05

# Floor on the divisor when un-mixing. 1/alpha explodes as alpha approaches
# zero, turning a nearly-transparent pixel into a saturated speck; those
# specks are invisible at full transparency but appear the moment the cut-out
# is composited over something bright.
UNMIX_FLOOR = 0.25


def _box_mean(a, r: int):
    """Mean over a (2r+1)² window, normalised by the true window size.

    Border pixels divide by however many neighbours they actually have, so the
    edge of the frame does not darken towards zero the way a zero-padded
    filter would. Uses a summed-area table, so cost is independent of r.
    """
    import numpy as np

    single = a.ndim == 2
    if single:
        a = a[:, :, None]
    height, width, _ = a.shape

    # float64 for the integral image: the running sum reaches millions on a
    # large photo, and float32 loses the low bits that the differences need.
    integral = np.zeros((height + 1, width + 1, a.shape[2]), dtype=np.float64)
    integral[1:, 1:] = np.cumsum(np.cumsum(a, axis=0, dtype=np.float64), axis=1)

    rows = np.arange(height)
    cols = np.arange(width)
    y0 = np.clip(rows - r, 0, height)
    y1 = np.clip(rows + r + 1, 0, height)
    x0 = np.clip(cols - r, 0, width)
    x1 = np.clip(cols + r + 1, 0, width)

    total = (
        integral[y1][:, x1] - integral[y0][:, x1] - integral[y1][:, x0] + integral[y0][:, x0]
    )
    count = ((y1 - y0)[:, None] * (x1 - x0)[None, :])[:, :, None]
    out = (total / count).astype(np.float32)
    return out[:, :, 0] if single else out


def guided_filter(guide, src, radius: int, eps: float = GUIDE_EPS):
    """Edge-preserving filter of `src` using colour image `guide`.

    He, Sun & Tang (2010). The colour form is used rather than the cheaper
    greyscale one because hair against a backdrop is frequently a chroma edge
    with barely any luminance step — exactly the case a greyscale guide
    cannot see, and exactly where cut-outs look worst.
    """
    import numpy as np

    mean_guide = _box_mean(guide, radius)
    mean_src = _box_mean(src, radius)
    mean_cross = _box_mean(guide * src[:, :, None], radius)
    cov_cross = mean_cross - mean_guide * mean_src[:, :, None]

    r_, g_, b_ = guide[:, :, 0], guide[:, :, 1], guide[:, :, 2]
    products = np.stack(
        [r_ * r_, r_ * g_, r_ * b_, g_ * g_, g_ * b_, b_ * b_], axis=-1
    )
    m = _box_mean(products, radius)
    mr, mg, mb = mean_guide[:, :, 0], mean_guide[:, :, 1], mean_guide[:, :, 2]

    # Covariance of the guide within each window, plus eps on the diagonal.
    var_rr = m[:, :, 0] - mr * mr + eps
    var_rg = m[:, :, 1] - mr * mg
    var_rb = m[:, :, 2] - mr * mb
    var_gg = m[:, :, 3] - mg * mg + eps
    var_gb = m[:, :, 4] - mg * mb
    var_bb = m[:, :, 5] - mb * mb + eps

    # Inverse of a symmetric 3x3, by cofactors — a per-pixel linear solve
    # done in closed form rather than looping over a million tiny systems.
    c0 = var_gg * var_bb - var_gb * var_gb
    c1 = var_rb * var_gb - var_rg * var_bb
    c2 = var_rg * var_gb - var_rb * var_gg
    det = var_rr * c0 + var_rg * c1 + var_rb * c2
    det = np.where(np.abs(det) < 1e-12, 1e-12, det)

    inv00, inv01, inv02 = c0 / det, c1 / det, c2 / det
    inv11 = (var_rr * var_bb - var_rb * var_rb) / det
    inv12 = (var_rb * var_rg - var_rr * var_gb) / det
    inv22 = (var_rr * var_gg - var_rg * var_rg) / det

    cx, cy, cz = cov_cross[:, :, 0], cov_cross[:, :, 1], cov_cross[:, :, 2]
    coeff = np.stack(
        [
            inv00 * cx + inv01 * cy + inv02 * cz,
            inv01 * cx + inv11 * cy + inv12 * cz,
            inv02 * cx + inv12 * cy + inv22 * cz,
        ],
        axis=-1,
    )
    offset = mean_src - (coeff * mean_guide).sum(axis=-1)

    return (_box_mean(coeff, radius) * guide).sum(axis=-1) + _box_mean(offset, radius)


def estimate_background(rgb, alpha, radius: int):
    """Local backdrop colour, by normalised convolution.

    Averages only the confidently-background pixels, but locally: each output
    pixel sees the backdrop *near it*. Where no background is in range — the
    middle of the subject — it falls back to the global average, which is
    harmless because nothing there gets un-mixed.
    """
    import numpy as np

    weight = (alpha < BACKGROUND_ALPHA).astype(np.float32)
    weighted = _box_mean(rgb * weight[:, :, None], radius)
    support = _box_mean(weight, radius)[:, :, None]

    if weight.any():
        fallback = rgb[weight > 0.5].mean(axis=0).astype(np.float32)
    else:
        fallback = np.zeros(3, dtype=np.float32)

    # Needs enough background in the window for the mean to mean anything.
    return np.where(support > 1e-3, weighted / np.maximum(support, 1e-6), fallback)


def refine_matte(rgb, mask):
    """(rgb uint8 HxWx3, mask float HxW in 0..1) -> (alpha float, rgb float).

    Returns the alpha matte and the colour with the backdrop un-mixed out of
    the partially transparent pixels.
    """
    import numpy as np

    height, width = mask.shape
    radius = max(MIN_GUIDE_RADIUS, int(round(min(height, width) * GUIDE_RADIUS_FRACTION)))

    guide = rgb.astype(np.float32) / 255.0
    refined = mask.astype(np.float32)
    for _ in range(REFINE_PASSES):
        refined = np.clip(guided_filter(guide, refined, radius), 0.0, 1.0)
    alpha = np.clip((refined - ALPHA_LOW) / (ALPHA_HIGH - ALPHA_LOW), 0.0, 1.0)

    colour = rgb.astype(np.float32)
    edge = (alpha > 0.01) & (alpha < 0.99)
    if edge.any():
        bg_radius = max(
            radius * 2, int(round(min(height, width) * BACKGROUND_RADIUS_FRACTION))
        )
        background = estimate_background(rgb.astype(np.float32), alpha, bg_radius)
        a = alpha[:, :, None]
        unmixed = (colour - background * (1.0 - a)) / np.maximum(a, UNMIX_FLOOR)
        colour = np.where(edge[:, :, None], np.clip(unmixed, 0.0, 255.0), colour)

    return alpha, colour
