"""Whether a generated image can actually become a talking avatar.

Tested against synthetic landmark sets rather than by generating images, so
these run without a Gemini key or a GPU. The judgement is here; the API call
is a thin HTTP wrapper.
"""

import pytest

from app.services.imagegen import STYLES, build_prompt
from app.services.riggable import MIN_FACE_FRACTION, check_landmarks

SIZE = (1024, 1024)


def face(cx=512.0, cy=512.0, half_w=280.0, half_h=340.0, nose_dx=0.0):
    """A minimal stand-in mesh: index 1 is the nose tip, as in MediaPipe."""
    points = [[cx, cy] for _ in range(478)]
    points[0] = [cx - half_w, cy - half_h]
    points[1] = [cx + nose_dx, cy]  # NOSE_TIP
    points[2] = [cx + half_w, cy + half_h]
    return points


def test_a_good_portrait_passes():
    result = check_landmarks(face(), SIZE, detected=True)
    assert result.ok, result.reason
    assert result.face_fraction > MIN_FACE_FRACTION


def test_an_undetected_face_is_rejected_even_though_the_mesh_looks_perfect():
    """The most important case.

    rig.py substitutes a synthetic mesh when MediaPipe finds nothing, and that
    mesh is perfectly proportioned — it would pass every geometric test below
    while describing nothing that is in the picture. Without this the avatar
    becomes "ready" with a mouth moving in empty space.
    """
    result = check_landmarks(face(), SIZE, detected=False)
    assert not result.ok
    assert "no face detected" in result.reason


def test_a_face_too_small_is_rejected():
    result = check_landmarks(face(half_w=80, half_h=100), SIZE, detected=True)
    assert not result.ok
    assert "too small" in result.reason


def test_a_face_running_off_the_edge_is_rejected():
    """The warp reaches past the landmarks; a face flush to the frame tears."""
    result = check_landmarks(face(cx=180, half_w=280), SIZE, detected=True)
    assert not result.ok
    assert "edge" in result.reason


def test_a_turned_head_is_rejected():
    """The engine cannot rotate a head — learned the hard way — so a
    three-quarter view can never be corrected after the fact."""
    result = check_landmarks(face(nose_dx=180), SIZE, detected=True)
    assert not result.ok
    assert "turned away" in result.reason


def test_a_slight_turn_is_still_accepted():
    """Nobody faces a camera perfectly; rejecting that would reject everyone."""
    assert check_landmarks(face(nose_dx=40), SIZE, detected=True).ok


def test_a_degenerate_mesh_does_not_divide_by_zero():
    points = [[10.0, 10.0] for _ in range(478)]
    result = check_landmarks(points, SIZE, detected=True)
    assert not result.ok


def test_an_empty_image_is_rejected():
    assert not check_landmarks(face(), (0, 0), detected=True).ok


# --- the prompt --------------------------------------------------------------


@pytest.mark.parametrize("style", sorted(STYLES))
def test_every_style_carries_the_rig_requirements(style):
    """The constraints are not decoration — each one is a failure mode. They
    have to survive whichever style is chosen."""
    prompt = build_prompt(style, has_source=True)
    for requirement in ("facing the camera", "Mouth closed", "inside the frame", "Plain"):
        assert requirement in prompt


def test_an_image_to_image_prompt_asks_to_keep_the_likeness():
    prompt = build_prompt("anime", has_source=True)
    assert "recognisable" in prompt
    assert "Do not beautify" in prompt


def test_a_from_scratch_prompt_does_not_reference_a_photograph():
    prompt = build_prompt("photoreal", has_source=False)
    assert "this photograph" not in prompt


def test_an_unknown_style_falls_back_rather_than_failing():
    assert build_prompt("nonsense", has_source=False)
