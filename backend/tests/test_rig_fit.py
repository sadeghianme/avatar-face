"""Hand-placed landmark anchors.

The detector fits a human face template; on stylized art it lands in the wrong
place at the wrong size, and everything downstream inherits that error. These
cover the correction actually doing what the user drew.
"""
from __future__ import annotations

import pytest

from app.services.rig_fit import (
    LEFT_EYE_INDICES,
    MAX_SCALE,
    BoxAnchors,
    apply_anchors,
    current_anchors,
)


def make_rig(n: int = 478) -> dict:
    """A rig whose points fill a known box, so transforms are checkable."""
    points = [[100.0 + (i % 20) * 5.0, 100.0 + (i // 20) * 5.0] for i in range(n)]
    return {
        "image_size": [800, 800],
        "face_box": [0, 0, 800, 800],
        "points": points,
        # Spans both axes, like a real lip ring — a flat set would have no
        # vertical extent to scale (see test_degenerate_axis_translates_only).
        "mouth_indices": [0, 1, 2, 20, 21, 22, 40, 41],
    }


def bounds(rig: dict, indices: list[int]) -> tuple[float, float, float, float]:
    xs = [rig["points"][i][0] for i in indices]
    ys = [rig["points"][i][1] for i in indices]
    return min(xs), max(xs), min(ys), max(ys)


def test_mouth_lands_exactly_where_it_was_marked() -> None:
    rig = make_rig()
    target = BoxAnchors(left=300, right=340, top=500, bottom=530)
    out = apply_anchors(rig, mouth=target)

    x0, x1, y0, y1 = bounds(out, out["mouth_indices"])
    assert x0 == pytest.approx(300, abs=0.05)
    assert x1 == pytest.approx(340, abs=0.05)
    assert y0 == pytest.approx(500, abs=0.05)
    assert y1 == pytest.approx(530, abs=0.05)


def test_axes_scale_independently() -> None:
    """A mouth detected too narrow but the right height is the common case;
    one uniform factor would trade a width error for a height error."""
    rig = make_rig()
    x0, x1, y0, y1 = bounds(rig, rig["mouth_indices"])
    out = apply_anchors(
        rig,
        mouth=BoxAnchors(left=x0 - 50, right=x1 + 50, top=y0, bottom=y1),
    )
    nx0, nx1, ny0, ny1 = bounds(out, out["mouth_indices"])
    assert nx1 - nx0 > (x1 - x0)  # widened
    assert ny1 - ny0 == pytest.approx(y1 - y0, abs=0.05)  # height untouched


def test_mouth_center_overrides_the_box_center() -> None:
    """Lets the user say "this wide, but sitting here" — a box alone cannot
    express that when the marked corners are asymmetric."""
    rig = make_rig()
    out = apply_anchors(
        rig,
        mouth=BoxAnchors(left=300, right=340, top=500, bottom=530),
        mouth_center=(600.0, 700.0),
    )
    x0, x1, y0, y1 = bounds(out, out["mouth_indices"])
    assert (x0 + x1) / 2 == pytest.approx(600, abs=0.05)
    assert (y0 + y1) / 2 == pytest.approx(700, abs=0.05)
    assert x1 - x0 == pytest.approx(40, abs=0.05)  # width still as marked


def test_regions_are_independent() -> None:
    """Fixing the mouth must not move the eyes."""
    rig = make_rig()
    before = bounds(rig, LEFT_EYE_INDICES)
    out = apply_anchors(rig, mouth=BoxAnchors(left=0, right=50, top=0, bottom=20))
    assert bounds(out, LEFT_EYE_INDICES) == pytest.approx(before, abs=0.05)


def test_head_moves_everything_and_runs_before_local_fits() -> None:
    """Otherwise a head correction would silently undo the eye and mouth ones."""
    rig = make_rig()
    # A 2x head correction: the fixture spans 100..195 x 100..215.
    out = apply_anchors(
        rig,
        head=BoxAnchors(left=200, right=390, top=200, bottom=430),
        mouth=BoxAnchors(left=300, right=340, top=500, bottom=530),
    )
    # A point in no local region carries the head transform alone.
    assert 300 not in out["mouth_indices"] and 300 not in LEFT_EYE_INDICES
    assert out["points"][300][0] == pytest.approx(200, abs=0.05)
    assert out["points"][300][1] == pytest.approx(350, abs=0.05)
    # The mouth still lands exactly where it was marked, on top of that.
    x0, x1, _, _ = bounds(out, out["mouth_indices"])
    assert x0 == pytest.approx(300, abs=0.05)
    assert x1 == pytest.approx(340, abs=0.05)


def test_degenerate_axis_translates_only() -> None:
    """If a region has no extent on an axis there is nothing to scale — a
    scale cannot spread coincident points apart. Translate and leave it,
    rather than dividing by ~0."""
    rig = make_rig()
    rig["mouth_indices"] = [0, 1, 2, 3]  # all share a y
    out = apply_anchors(rig, mouth=BoxAnchors(left=300, right=340, top=500, bottom=530))
    _, _, y0, y1 = bounds(out, out["mouth_indices"])
    assert y0 == y1 == pytest.approx(515, abs=0.05)  # centred on the marked box


def test_collapsed_anchor_does_not_explode_the_mesh() -> None:
    """A user dragging both edges onto each other must not divide by ~0."""
    rig = make_rig()
    out = apply_anchors(rig, mouth=BoxAnchors(left=350, right=350, top=500, bottom=540))
    assert all(abs(x) < 1e5 and abs(y) < 1e5 for x, y in out["points"])


def test_scale_is_bounded() -> None:
    rig = make_rig()
    out = apply_anchors(rig, mouth=BoxAnchors(left=0, right=9000, top=0, bottom=9000))
    x0, x1, _, _ = bounds(rig, rig["mouth_indices"])
    nx0, nx1, _, _ = bounds(out, out["mouth_indices"])
    assert (nx1 - nx0) <= (x1 - x0) * MAX_SCALE + 1


def test_face_box_is_recomputed() -> None:
    rig = make_rig()
    out = apply_anchors(rig, head=BoxAnchors(left=10, right=210, top=20, bottom=220))
    assert out["face_box"][0] == pytest.approx(10, abs=0.05)
    assert out["face_box"][2] == pytest.approx(210, abs=0.05)


def test_no_anchors_is_a_no_op() -> None:
    rig = make_rig()
    out = apply_anchors(rig)
    assert out["points"] == [[round(x, 2), round(y, 2)] for x, y in rig["points"]]


def test_current_anchors_round_trip() -> None:
    """Opening the UI and saving without dragging must change nothing."""
    rig = make_rig()
    a = current_anchors(rig)
    out = apply_anchors(
        rig,
        head=BoxAnchors(**a["head"]),
        left_eye=BoxAnchors(**a["left_eye"]),
        right_eye=BoxAnchors(**a["right_eye"]),
        mouth=BoxAnchors(**a["mouth"]),
        mouth_center=(a["mouth_center"]["x"], a["mouth_center"]["y"]),
    )
    for (bx, by), (ax, ay) in zip(rig["points"], out["points"]):
        assert ax == pytest.approx(bx, abs=0.05)
        assert ay == pytest.approx(by, abs=0.05)


def test_short_synthetic_mesh_does_not_raise() -> None:
    """The fallback mesh is shorter than MediaPipe's 478 and has no iris."""
    rig = make_rig(n=120)
    out = apply_anchors(rig, left_eye=BoxAnchors(left=0, right=40, top=0, bottom=20))
    assert len(out["points"]) == 120
