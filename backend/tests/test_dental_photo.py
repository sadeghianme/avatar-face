"""The browser's teeth test, ported (services.dental_photo).

The first cases are embed/src/mouth/__tests__/dental-texture.test.ts, case
for case with the same numbers: the port must lift the same arches the
browser does. The last ones run the whole check on the Reference avatar's
two real mouth photos: the full-crown one (oral-detail-v3) the renderer
accepts, and the tips-only one (v2) whose refusal the crown-coverage rule
was written for.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from app.services import dental_photo as d

REFERENCE = Path(__file__).resolve().parents[2] / "frontend/public/lab/reference"


def fixture():
    pixels = np.zeros((80, 100, 4), dtype=np.uint8)

    def fill(x0, y0, w, h, colour):
        pixels[y0:y0 + h, x0:x0 + w] = colour

    fill(0, 0, 100, 80, [40, 12, 14, 255])
    fill(15, 12, 70, 18, [220, 211, 185, 255])
    fill(20, 50, 60, 15, [198, 188, 168, 255])
    upper = [(0, 10), (99, 10)]
    lower = [(0, 70), (99, 70)]
    return pixels, fill, upper, lower


def test_enamel_colour_is_told_from_lips_and_cavity():
    assert d.enamel_mask(np.array([220, 211, 185])) > 0.95
    assert d.enamel_mask(np.array([144, 137, 123])) > 0.9
    assert d.enamel_mask(np.array([165, 92, 98])) == 0
    assert d.enamel_mask(np.array([45, 15, 17])) == 0


def test_the_two_rows_are_lifted_apart_without_the_background():
    pixels, _, upper, lower = fixture()
    a, b = d.extract_dental_layers(pixels, upper, lower)
    assert a.box == (15, 12, 70, 18) and b.box == (20, 50, 60, 15)
    assert (a.count, b.count) == (1260, 900)
    assert not ((a.pixels[..., 3] > 0) & (b.pixels[..., 3] > 0)).any()
    assert list(pixels[0, 0]) == [40, 12, 14, 255], "the source is not modified"


def test_small_floating_highlights_are_not_teeth():
    pixels, fill, upper, lower = fixture()
    fill(2, 12, 3, 3, [255, 255, 255, 255])
    a, _ = d.extract_dental_layers(pixels, upper, lower)
    assert a.pixels[12, 2, 3] == 0
    assert a.count == 1260


def test_shading_inside_teeth_is_kept_as_source_colour():
    pixels, fill, upper, lower = fixture()
    fill(15, 19, 70, 4, [86, 78, 67, 255])
    fill(48, 12, 2, 18, [80, 72, 62, 255])
    a, _ = d.extract_dental_layers(pixels, upper, lower)
    for x, y in [(30, 20), (48, 15), (48, 20)]:
        assert list(a.pixels[y, x]) == list(pixels[y, x])
    assert a.count == 1260


def test_no_roots_are_invented_above_the_crowns():
    pixels, _, upper, lower = fixture()
    a, _ = d.extract_dental_layers(pixels, upper, lower)
    assert not a.pixels[:12, :, 3].any()
    assert a.box[1] == 12


def test_the_gum_notch_between_crowns_is_kept():
    pixels, fill, upper, lower = fixture()
    fill(48, 12, 2, 4, [130, 71, 76, 255])
    a, _ = d.extract_dental_layers(pixels, upper, lower)
    assert list(a.pixels[13, 48]) == [130, 71, 76, 255]


def test_source_alpha_is_respected_and_an_empty_lower_row_is_empty():
    pixels, fill, upper, lower = fixture()
    fill(20, 50, 60, 15, [255, 255, 255, 0])
    _, b = d.extract_dental_layers(pixels, upper, lower)
    assert b.count == 0 and b.box[2] == 0 and b.box[3] == 0


def test_contours_past_the_image_are_clipped_and_bad_ones_refused():
    pixels, _, _, _ = fixture()
    rows = d.extract_dental_layers(pixels, [(-20, -10), (120, -10)], [(-20, 90), (120, 90)])
    assert rows[0].count > 0
    with pytest.raises(ValueError):
        d.extract_dental_layers(pixels, [], [])


def test_full_crowns_are_told_from_tooth_tips():
    pixels, fill, upper, lower = fixture()
    layer = d.extract_dental_layers(pixels, upper, lower)[0]
    assert d.dental_crown_coverage(layer, 50, 100) == 0.18
    fill(15, 12, 70, 12, [40, 12, 14, 255])
    layer = d.extract_dental_layers(pixels, upper, lower)[0]
    assert d.dental_crown_coverage(layer, 50, 100) == 0.06


def _reference(name: str):
    rig = json.loads((REFERENCE / f"{name}.rig.json").read_text())
    image = Image.open(REFERENCE / f"{name}.webp")
    return image, np.array(rig["points"]), rig["inner_lip_ring"]


def test_the_reference_full_crown_photo_passes():
    """The numbers the browser's extraction gives on the same canvas (run
    through dental-texture-model.ts when the port was written): upper box
    (120, 114, 401, 80), 22807 pixels, coverage 59/512."""
    check = d.check(*_reference("oral-detail-v3"))
    assert check.ok
    assert (check.upper_width, check.upper_count) == (401, 22807)
    assert check.coverage == round(59 / 512, 4)
    assert check.upper_bottom == 194
    assert check.central_edge == 193.0


def test_the_reference_tips_only_photo_is_refused_for_its_crowns():
    """The browser: box width 334, 10578 pixels, coverage 39/512, under the
    0.10 the DentalOralSurface constructor asks for."""
    check = d.check(*_reference("oral-detail-v2"))
    assert not check.ok
    assert (check.upper_width, check.upper_count) == (334, 10578)
    assert check.coverage == round(39 / 512, 4) < d.MIN_CROWN_COVERAGE


def test_a_closed_mouth_has_no_upper_row():
    image = Image.open(REFERENCE / "portrait.png")
    rig = json.loads((REFERENCE / "rig.json").read_text())
    check = d.check(image, np.array(rig["points"]), rig["inner_lip_ring"])
    assert not check.ok
    assert check.upper_width < d.MIN_UPPER_WIDTH


def test_canvas_and_photo_coordinates_round_trip():
    _, points, _ = _reference("oral-detail-v3")
    frame = d.mouth_frame(points)
    for x, y in [(600.0, 700.0), (points[13][0], points[13][1]), (10.0, 1200.0)]:
        cx, cy = d.to_canvas(frame, x, y)
        assert np.allclose(d.from_canvas(frame, cx, cy), (x, y))
    assert np.allclose(d.to_canvas(frame, *points[13]), d.ORIGIN)
