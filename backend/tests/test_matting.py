"""Alpha matting: the maths that turns a coarse mask into a clean cut-out.

These use synthetic images with a known correct answer, so a regression shows
up as a number rather than as someone noticing a fringe months later.
"""

import numpy as np

from app.services.matting import (
    _box_mean,
    estimate_background,
    guided_filter,
    refine_matte,
)

BACKDROP = np.array([215.0, 212.0, 212.0])  # a light studio wall
SUBJECT = np.array([30.0, 25.0, 20.0])  # dark hair


def _brute_force_box_mean(a, r):
    out = np.zeros_like(a, dtype=np.float64)
    h, w = a.shape
    for y in range(h):
        for x in range(w):
            window = a[max(0, y - r) : y + r + 1, max(0, x - r) : x + r + 1]
            out[y, x] = window.mean()
    return out


def test_box_mean_matches_the_obvious_implementation():
    rng = np.random.default_rng(0)
    a = rng.random((9, 11)).astype(np.float32)
    for r in (1, 2, 4):
        assert np.allclose(_box_mean(a, r), _brute_force_box_mean(a, r), atol=1e-5)


def test_box_mean_normalises_by_the_real_window_at_the_border():
    """A zero-padded filter would darken the frame edge towards zero."""
    a = np.ones((8, 8), dtype=np.float32)
    assert np.allclose(_box_mean(a, 3), 1.0)


def _soft_edge_scene(offset=0):
    """A vertical edge: backdrop on the left, subject on the right."""
    h = w = 64
    rgb = np.tile(BACKDROP, (h, w, 1)).astype(np.float32)
    rgb[:, 32:] = SUBJECT
    truth = np.zeros((h, w), dtype=np.float32)
    truth[:, 32:] = 1.0
    # What a segmentation model gives you: soft, and not quite in the right
    # place. The offset is the point — the mask disagrees with the photo.
    coarse = np.zeros((h, w), dtype=np.float32)
    coarse[:, 32 + offset :] = 1.0
    coarse = _box_mean(_box_mean(coarse, 4), 4)
    return rgb.astype(np.uint8), coarse, truth


def _steepness(alpha_row):
    """Largest step between adjacent pixels.

    Not the width of the 10-90 band: a refined matte is a near-vertical jump
    sitting between two long flat shoulders, and the band measure counts those
    shoulders as transition, reporting a perfectly sharp edge as a blurred one.
    """
    return float(np.abs(np.diff(alpha_row)).max())


def test_guided_filter_snaps_a_blurred_mask_back_onto_the_real_edge():
    rgb, coarse, _ = _soft_edge_scene()
    guide = rgb.astype(np.float32) / 255.0
    refined = np.clip(guided_filter(guide, coarse, radius=6), 0, 1)

    before, after = _steepness(coarse[32]), _steepness(refined[32])
    assert after > before * 3, f"expected a much sharper edge, got {before} -> {after}"
    # And the step lands on the real edge, not where the coarse mask guessed.
    assert int(np.argmax(np.abs(np.diff(refined[32])))) == 31  # the 31|32 boundary


def test_guided_filter_corrects_a_mask_that_is_in_the_wrong_place():
    """The model's mask being offset from the photo is the normal case."""
    rgb, coarse, _ = _soft_edge_scene(offset=4)
    guide = rgb.astype(np.float32) / 255.0
    refined = np.clip(guided_filter(guide, coarse, radius=6), 0, 1)

    def midpoint(row):
        return float(np.argmin(np.abs(row - 0.5)))

    # The true edge is at column 32; the coarse mask thinks it is at 36.
    assert abs(midpoint(refined[32]) - 32) < abs(midpoint(coarse[32]) - 32)


def test_local_background_follows_a_gradient_backdrop():
    """One global average is wrong everywhere on a gradient — the common case."""
    h = w = 96
    ramp = np.linspace(60, 240, w, dtype=np.float32)
    rgb = np.repeat(ramp[None, :, None], h, axis=0).repeat(3, axis=2)
    alpha = np.zeros((h, w), dtype=np.float32)
    alpha[32:64, 32:64] = 1.0  # an opaque subject in the middle

    local = estimate_background(rgb, alpha, radius=16)
    global_mean = rgb[alpha < 0.05].mean(axis=0)

    for x in (10, 85):
        expected = ramp[x]
        assert abs(local[5, x, 0] - expected) < abs(global_mean[0] - expected)


def _ground_truth_scene(offset=3):
    """A real edge: genuinely mixed pixels over a backdrop that is not flat.

    Both properties matter. Without mixed pixels there is nothing to un-mix,
    and with a uniform backdrop a single global average happens to be exactly
    right — so a flat scene scores the old and new algorithms identically and
    proves nothing.
    """
    h = w = 96
    x = np.arange(w)
    truth = np.tile(np.clip((x - 48) / 4.0 + 0.5, 0, 1).astype(np.float32), (h, 1))
    ramp = np.linspace(150, 245, w)
    backdrop = np.repeat(ramp[None, :, None], h, axis=0).repeat(3, axis=2)
    subject = np.tile(SUBJECT, (h, w, 1))
    composite = truth[:, :, None] * subject + (1 - truth[:, :, None]) * backdrop
    coarse = np.tile(
        np.clip((x - 48 - offset) / 8.0 + 0.5, 0, 1).astype(np.float32), (h, 1)
    )
    return composite.clip(0, 255).astype(np.uint8), coarse, truth


def test_recovers_alpha_and_colour_better_than_the_previous_algorithm():
    """Scored against a known answer, not against each other's appearance."""
    rgb, coarse, truth = _ground_truth_scene()
    band = (truth > 0.15) & (truth < 0.85)

    old_alpha, old_colour = _previous_algorithm(rgb, coarse)
    new_alpha, new_colour = refine_matte(rgb, coarse)

    old_colour_error = np.abs(old_colour[band] - SUBJECT).mean()
    new_colour_error = np.abs(new_colour[band] - SUBJECT).mean()
    old_alpha_error = np.abs(old_alpha[band] - truth[band]).mean()
    new_alpha_error = np.abs(new_alpha[band] - truth[band]).mean()

    assert new_colour_error < old_colour_error * 0.85, (
        f"colour {old_colour_error:.1f} -> {new_colour_error:.1f}"
    )
    assert new_alpha_error < old_alpha_error, (
        f"alpha {old_alpha_error:.3f} -> {new_alpha_error:.3f}"
    )


def _contamination(colour, alpha):
    """Fraction of semi-transparent pixels still wearing the backdrop colour.

    That residue IS the halo: backdrop that was never divided back out, which
    only becomes visible once the cut-out is placed on a different colour.
    """
    band = (alpha > 0.05) & (alpha < 0.95)
    if not band.any():
        return 0.0
    distance = np.linalg.norm(colour[band] - BACKDROP, axis=1)
    return float((distance < 40).mean())


def _previous_algorithm(rgb, mask):
    """Threshold plus one global backdrop colour — what this replaced.

    Reproduced here so the comparison is against something real rather than
    against a number someone typed in once.
    """
    alpha = np.clip((mask - 0.35) / (0.65 - 0.35), 0.0, 1.0)
    colour = rgb.astype(np.float32)
    edge = (alpha > 0.02) & (alpha < 0.98)
    if edge.any():
        pixels = rgb[alpha < 0.02]
        backdrop = pixels.mean(axis=0) if pixels.size else np.zeros(3)
        a = alpha[edge][:, None]
        colour[edge] = np.clip(
            (colour[edge] - backdrop * (1 - a)) / np.maximum(a, 0.15), 0, 255
        )
    return alpha, colour


def test_no_backdrop_survives_in_the_soft_edge():
    """Residue in the band is the halo — invisible until it is composited."""
    rgb, coarse, _ = _ground_truth_scene()
    alpha, colour = refine_matte(rgb, coarse)
    assert _contamination(colour, alpha) < 0.10


def test_refine_matte_leaves_the_interior_alone():
    """Un-mixing must not tint the subject or punch holes in it."""
    rgb, coarse, truth = _soft_edge_scene()
    alpha, colour = refine_matte(rgb, coarse)

    deep_inside = truth > 0.5
    deep_inside[:, :48] = False
    assert alpha[deep_inside].min() > 0.95
    assert np.allclose(colour[deep_inside], SUBJECT, atol=6)

    far_outside = np.zeros_like(truth, dtype=bool)
    far_outside[:, :16] = True
    assert alpha[far_outside].max() < 0.05


def test_alpha_stays_in_range_and_colour_stays_in_gamut():
    """1/alpha explodes near zero; unclamped it produces saturated specks."""
    rng = np.random.default_rng(3)
    rgb = rng.integers(0, 256, (48, 48, 3), dtype=np.uint8)
    mask = rng.random((48, 48)).astype(np.float32)

    alpha, colour = refine_matte(rgb, mask)
    assert alpha.min() >= 0.0 and alpha.max() <= 1.0
    assert colour.min() >= 0.0 and colour.max() <= 255.0
    assert np.isfinite(colour).all()


def test_a_fully_confident_mask_needs_no_edge_work():
    rgb = np.tile(SUBJECT, (32, 32, 1)).astype(np.uint8)
    alpha, colour = refine_matte(rgb, np.ones((32, 32), dtype=np.float32))
    assert alpha.min() > 0.95
    assert np.allclose(colour, SUBJECT, atol=2)


def test_an_empty_mask_does_not_divide_by_zero():
    rgb = np.tile(BACKDROP, (32, 32, 1)).astype(np.uint8)
    alpha, colour = refine_matte(rgb, np.zeros((32, 32), dtype=np.float32))
    assert alpha.max() < 0.05
    assert np.isfinite(colour).all()
