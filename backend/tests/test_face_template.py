"""The face template: every index where MediaPipe puts it.

The fit attaches marks to specific landmarks, so a template that is a face
"roughly" is not enough: a mouth corner on the wrong side, or a lower lip
above the upper one, turns into folded triangles the moment it is warped.
"""

import json

import numpy as np
import pytest

from app.services import face_template

LEFT_EYE_RING = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246]
RIGHT_EYE_RING = [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466]


@pytest.fixture
def t() -> np.ndarray:
    return face_template.normalised()


def test_it_is_a_full_mesh_in_its_unit_face_box(t):
    assert t.shape == (478, 2)
    assert t.min(axis=0) == pytest.approx([0, 0])
    assert t.max(axis=0) == pytest.approx([1, 1])


def test_left_and_right_are_the_images(t):
    assert t[61][0] < t[291][0]
    # 33 is the OUTER corner of the image-left eye, 133 its inner corner.
    assert t[33][0] == min(t[i][0] for i in LEFT_EYE_RING)
    assert t[133][0] == max(t[i][0] for i in LEFT_EYE_RING)
    assert t[362][0] == min(t[i][0] for i in RIGHT_EYE_RING)
    assert t[263][0] == max(t[i][0] for i in RIGHT_EYE_RING)
    assert t[133][0] < t[362][0]


def test_lips_and_lids_are_the_right_way_up(t):
    # Parted by a hair: a closed mouth with 13 on 14 has no orientation.
    assert t[13][1] < t[14][1]
    assert t[0][1] < t[13][1] and t[14][1] < t[17][1]
    assert t[159][1] < t[145][1] and t[386][1] < t[374][1]


def test_forehead_on_top_and_chin_at_the_bottom(t):
    assert int(np.argmin(t[:, 1])) == 10
    assert int(np.argmax(t[:, 1])) == 152
    # The head's sides are its widest points at eye level, not the chin's.
    assert t[234][0] < t[33][0] and t[454][0] > t[263][0]


@pytest.mark.parametrize("cheek, eye, corner, edge", [(50, 145, 61, 234), (280, 374, 291, 454)])
def test_cheeks_are_on_the_cheeks(t, cheek, eye, corner, edge):
    """Below the eye, above the mouth corner, between the face's edge and
    the mouth — not on the nose, not in the jaw."""
    assert t[eye][1] < t[cheek][1] < t[corner][1]
    lo, hi = sorted((t[edge][0], t[corner][0]))
    assert lo < t[cheek][0] < hi


def test_placing_makes_the_box_the_face_box():
    placed = face_template.place((100, 50, 400, 450))
    assert placed.min(axis=0) == pytest.approx([100, 50])
    assert placed.max(axis=0) == pytest.approx([400, 450])


@pytest.mark.parametrize("size", [(320, 400), (1024, 1024), (1600, 900)])
def test_the_default_place_keeps_its_proportions_inside_the_photo(size):
    x0, y0, x1, y1 = face_template.default_box(*size)
    assert 0 <= x0 < x1 <= size[0] and 0 <= y0 < y1 <= size[1]
    aspect = json.loads(face_template.TEMPLATE_PATH.read_text())["aspect"]
    assert (x1 - x0) / (y1 - y0) == pytest.approx(aspect)


def test_the_data_file_is_what_the_build_script_writes():
    """The template's provenance is the script: a hand edit to the JSON
    would be a template nobody can reproduce."""
    from scripts.build_face_template import build

    assert json.loads(face_template.TEMPLATE_PATH.read_text()) == build()
