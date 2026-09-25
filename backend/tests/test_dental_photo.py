"""The embed's teeth-photo acceptance, ported (services.dental_photo).

The port must decide as DentalOralSurface does, or the performance kit would
hand on a teeth photo that drops an avatar to the classic mouth. Three
checks: the Reference's own photos land on the side of the line the embed
puts them (oral-detail-v3 renders; v2, the tip-only photo it replaced, and
the Reference's EE do not); synthetic arches exercise every pass of the
extraction; and a shared fixture makes the embed's own extractDentalLayers
and dentalCrownCoverage produce, pixel for pixel, what the port does
(embed/src/mouth/__tests__/dental-photo-parity.test.ts).
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import zlib
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from app.services import dental_photo as dp
from app.services.performance_kit import INNER_LIP_RING

REPO = Path(__file__).resolve().parents[2]
REFERENCE_DIR = REPO / "frontend/public/lab/reference"
PARITY_FIXTURE = REPO / "embed/src/mouth/__tests__/fixtures/dental-extraction.json"

ENAMEL = (236, 232, 222)
CAVITY = (46, 22, 24)


def photo_and_points(name: str) -> tuple[Image.Image, np.ndarray, list[int]]:
    rig = json.loads((REFERENCE_DIR / f"{name}.rig.json").read_text())
    image = Image.open(REFERENCE_DIR / f"{name}.webp").convert("RGB")
    return image, np.asarray(rig["points"], dtype=np.float64), rig["inner_lip_ring"]


# --- The Reference's photos ----------------------------------------------------------------


def test_the_references_teeth_photo_is_accepted():
    """oral-detail-v3 is the photo the Reference renders its teeth from."""
    acceptance = dp.accept_teeth_photo(*photo_and_points("oral-detail-v3"))
    assert acceptance.accepted
    assert acceptance.crown_coverage == pytest.approx(0.115, abs=0.005)
    assert acceptance.arch_width > 300 and acceptance.arch_pixels > 10_000
    # Its arch ends 0.1445 of its mouth width below the inner upper lip.
    assert acceptance.upper_edge == pytest.approx(0.1445, abs=0.003)


def test_the_tip_only_photo_it_replaced_is_refused():
    """docs/dental-rendering-repair-2026-09-07.md: v2 showed a thin strip of
    the upper teeth, so the embed refuses it and v3 replaced it."""
    acceptance = dp.accept_teeth_photo(*photo_and_points("oral-detail-v2"))
    assert not acceptance.accepted
    assert acceptance.crown_coverage < dp.MIN_CROWN_COVERAGE
    # Wide and solid enough: only the crown height fails.
    assert acceptance.arch_width >= dp.MIN_ARCH_WIDTH and acceptance.arch_pixels >= dp.MIN_ARCH_PIXELS


def test_the_references_ee_is_refused():
    manifest = json.loads((REFERENCE_DIR / "performance.json").read_text())
    source = next(p for p in manifest["poses"] if p["id"] == "ee")["source"]
    image = Image.open(REFERENCE_DIR / "performance-ee.webp").convert("RGB")
    acceptance = dp.accept_teeth_photo(image, np.asarray(source) * image.size[0], INNER_LIP_RING)
    assert not acceptance.accepted
    assert acceptance.crown_coverage == pytest.approx(0.070, abs=0.003)


def test_a_photo_whose_mouth_has_no_width_is_refused():
    image, points, ring = photo_and_points("oral-detail-v3")
    points = points.copy()
    points[291] = points[61]
    assert not dp.accept_teeth_photo(image, points, ring).accepted


# --- The extraction canvas ---------------------------------------------------------------------


def test_the_canvas_puts_the_inner_upper_lip_at_its_origin_a_mouth_width_to_512_pixels():
    image, points, ring = photo_and_points("oral-detail-v3")
    canvas, contour = dp.extraction_canvas(image, points, ring)
    assert canvas.shape == (480, 640, 4)
    at = {index: contour[k] for k, index in enumerate(ring)}
    assert at[13] == pytest.approx(dp.CANVAS_ORIGIN, abs=1e-6)
    # The corner line is level: the ring's corners 78 and 308 at one height
    # as 61 and 291 would be, 512 px apart.
    width = float(np.linalg.norm(points[291] - points[61]))
    assert np.linalg.norm(contour[ring.index(308)] - contour[ring.index(78)]) == pytest.approx(
        np.linalg.norm(points[308] - points[78]) * 512 / width, rel=1e-6)
    # Clipped to the inner lip ring: transparent outside, opaque well inside.
    assert canvas[5, 5, 3] == 0 and tuple(canvas[5, 5]) == (0, 0, 0, 0)
    assert canvas[int(dp.CANVAS_ORIGIN[1]) + 20, int(dp.CANVAS_ORIGIN[0]), 3] == 255


# --- The extraction, on synthetic arches ---------------------------------------------------------


def synthetic(width=200, height=140, *, upper_to=60, gap_to=70, lower_to=110, specks=(),
              notches=()) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """An opaque RGBA mouth: enamel from the top contour (y 20) down to
    `upper_to`, a dark gap to `gap_to`, lower enamel to `lower_to`, cavity
    below; `specks` (x, y, size) are enamel squares, `notches` x columns of
    dark between the upper teeth."""
    image = np.zeros((height, width, 4), dtype=np.uint8)
    image[..., 3] = 255
    image[..., :3] = CAVITY
    image[20:upper_to, 20:width - 20, :3] = ENAMEL
    image[gap_to:lower_to, 30:width - 30, :3] = ENAMEL
    for x, y, size in specks:
        image[y:y + size, x:x + size, :3] = ENAMEL
    for x in notches:
        image[20:upper_to, x, :3] = CAVITY
    upper = np.array([[0.0, 20.0], [width / 2, 20.0], [width - 1.0, 20.0]])
    lower = np.array([[0.0, 120.0], [width / 2, 120.0], [width - 1.0, 120.0]])
    return image, upper, lower


def test_the_arches_split_at_the_dark_gap_between_them():
    image, upper, lower = synthetic()
    top, bottom = dp.extract_dental_layers(image, upper, lower)
    assert top.box == (20, 20, 160, 40)
    assert bottom.box == (30, 70, 140, 40)
    assert top.count == 160 * 40 and bottom.count == 140 * 40
    assert dp.crown_coverage(top, 100, 100) == pytest.approx(0.40)


def test_an_isolated_highlight_is_not_part_of_the_arch():
    """An enamel-coloured speck under 150 pixels, apart from the upper
    arch, is dropped; the same speck in the lower layer (limit 12) stays."""
    image, upper, lower = synthetic(specks=[(2, 30, 8)])
    top, _ = dp.extract_dental_layers(image, upper, lower)
    assert top.box == (20, 20, 160, 40)
    image, upper, lower = synthetic(specks=[(2, 90, 8)])
    _, bottom = dp.extract_dental_layers(image, upper, lower)
    assert bottom.box[0] == 2


def test_a_dark_line_between_teeth_is_kept_as_photographed():
    """A one-pixel interdental shadow is bridged: the arch stays one piece
    and the shadow's own (dark) pixels are drawn, not a hole."""
    image, upper, lower = synthetic(notches=[100])
    top, _ = dp.extract_dental_layers(image, upper, lower)
    assert top.box == (20, 20, 160, 40)
    assert top.pixels[40, 100, 3] == 255
    assert tuple(top.pixels[40, 100, :3]) == CAVITY


def test_a_short_crown_has_little_coverage():
    """Tips showing between nearly closed lips (20 to 42): 6 pixels of crown."""
    image, upper, lower = synthetic(upper_to=26, gap_to=34, lower_to=42)
    lower[:, 1] = 42.0
    top, _ = dp.extract_dental_layers(image, upper, lower)
    assert dp.crown_coverage(top, 100, 100) == pytest.approx(0.06)


def test_no_enamel_gives_empty_layers():
    image, upper, lower = synthetic(upper_to=20, gap_to=0, lower_to=0)
    top, bottom = dp.extract_dental_layers(image, upper, lower)
    assert top.count == bottom.count == 0
    assert top.box == (200, 140, 0, 0)
    assert dp.crown_coverage(top) == 0.0


# --- Parity with the embed -------------------------------------------------------------------------


def parity_case() -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """A small, deterministic mouth that exercises every pass: curved lips,
    shaded and noisy enamel, interdental shadows, an arch edge that is not
    level, specks either side of the size limits, and partly transparent
    clip edges."""
    rng = np.random.default_rng(7)
    width, height = 160, 120
    ys, xs = np.mgrid[0:height, 0:width].astype(np.float64)
    top = 22 + 0.0025 * (xs - 80) ** 2
    bottom = 104 - 0.002 * (xs - 80) ** 2
    edge = 64 + 0.0018 * (xs - 80) ** 2 + 3 * np.sin(xs / 7)
    rgb = np.empty((height, width, 3))
    rgb[:] = CAVITY
    enamel = np.array(ENAMEL, dtype=np.float64) - (ys - top)[..., None] * 0.6
    upper = (ys >= top) & (ys < edge) & (np.abs(xs - 80) < 66)
    lower = (ys >= edge + 9) & (ys < bottom - 6) & (np.abs(xs - 80) < 52)
    rgb[upper | lower] = enamel[upper | lower]
    for x in (40, 58, 79, 80, 101, 120):
        rgb[upper & (xs == x)] = (120, 84, 70)
    rgb[30:36, 6:12] = ENAMEL  # 36 px: a highlight above the lower limit
    rgb[92:95, 150:153] = ENAMEL  # 9 px
    rgb += rng.normal(0, 6, size=rgb.shape)
    alpha = np.full((height, width), 255.0)
    alpha[:, :4] = 0
    alpha[:, 4:8] = 90
    alpha[ys < top - 1] = 30
    image = np.dstack((np.clip(np.round(rgb), 0, 255), np.clip(alpha, 0, 255))).astype(np.uint8)
    upper_contour = np.array([[x, 22 + 0.0025 * (x - 80) ** 2 - 1.5] for x in range(0, 161, 16)])
    lower_contour = np.array([[x, 104 - 0.002 * (x - 80) ** 2] for x in range(0, 161, 16)])[::-1]
    return image, upper_contour, lower_contour


def layer_digest(layer: dp.Layer) -> dict:
    return {"box": list(layer.box), "count": layer.count,
            "sha256": hashlib.sha256(layer.pixels.tobytes()).hexdigest()}


def test_the_embed_parity_fixture_is_what_the_port_computes():
    """embed/src/mouth/__tests__/dental-photo-parity.test.ts runs the embed's
    extractDentalLayers and dentalCrownCoverage on this fixture's pixels and
    must get exactly these layers. Regenerate with LIVEFACE_WRITE_FIXTURES=1."""
    image, upper_contour, lower_contour = parity_case()
    top, bottom = dp.extract_dental_layers(image, upper_contour, lower_contour)
    # Every pass mattered: both arches, with the lower highlight kept and
    # the upper edge uneven.
    assert top.count > 3000 and bottom.count > 1000
    fixture = {
        "width": image.shape[1],
        "height": image.shape[0],
        "rgba_zlib_base64": base64.b64encode(zlib.compress(image.tobytes(), 9)).decode(),
        "upper_contour": upper_contour.tolist(),
        "lower_contour": lower_contour.tolist(),
        "coverage": {"center": 80, "mouth_width": 128},
        "expected": {
            "upper": {**layer_digest(top), "coverage": dp.crown_coverage(top, 80, 128)},
            "lower": layer_digest(bottom),
        },
    }
    written = json.dumps(fixture, separators=(",", ":"))
    if os.environ.get("LIVEFACE_WRITE_FIXTURES") == "1":
        PARITY_FIXTURE.write_text(written)
    assert PARITY_FIXTURE.read_text() == written
