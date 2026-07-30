"""Hand-placed landmark anchors.

The detector fits a human face template; on stylized art it lands in the wrong
place at the wrong size, and everything downstream inherits the error. These
cover the correction doing what the user drew — and, just as importantly, not
tearing the mesh while doing it.
"""

from __future__ import annotations

import math

import pytest

from app.services.rig_fit import (
    LEFT_EYE_INDICES,
    RIGHT_EYE_INDICES,
    MAX_SCALE,
    RegionMarks,
    apply_anchors,
    current_anchors,
)


def _ring(cx: float, cy: float, rx: float, ry: float, count: int) -> list[list[float]]:
    return [
        [cx + rx * math.cos(k / count * math.tau), cy + ry * math.sin(k / count * math.tau)]
        for k in range(count)
    ]


def make_rig(n: int = 478) -> dict:
    """A point cloud laid out like a face: eyes up left and right, mouth low.

    Deliberately not a uniform grid — on a grid the leftmost and topmost points
    coincide, which makes the extreme-point correspondences degenerate. A real
    lip ring's leftmost point (a commissure) and its topmost (the cupid's bow)
    are different landmarks, which is what the fit relies on. The layout also
    has to be realistic for the falloff tests to mean anything: eyes far enough
    from the mouth that correcting one does not drag the other.
    """
    points = []
    for i in range(n):
        angle = (i / n) * math.tau * 7.3
        radius = 20 + 230 * ((i * 37) % n) / n
        points.append([400 + radius * math.cos(angle), 400 + radius * 1.15 * math.sin(angle)])

    # Must not collide with the eye index sets, or a "mouth" point ends up
    # at an eye and the extreme-point correspondences go degenerate.
    taken = set(LEFT_EYE_INDICES) | set(RIGHT_EYE_INDICES)
    mouth_indices = [i for i in range(min(200, n // 3), n) if i not in taken][:8]
    for i, p in zip(mouth_indices, _ring(400, 620, 40, 14, len(mouth_indices))):
        points[i] = p
    for i, p in zip(LEFT_EYE_INDICES, _ring(310, 250, 34, 15, len(LEFT_EYE_INDICES))):
        if i < n:
            points[i] = p
    for i, p in zip(RIGHT_EYE_INDICES, _ring(490, 250, 34, 15, len(RIGHT_EYE_INDICES))):
        if i < n:
            points[i] = p
    return {
        "image_size": [800, 800],
        "face_box": [0, 0, 800, 800],
        "points": points,
        "mouth_indices": mouth_indices,
    }


def bounds(rig: dict, indices: list[int]) -> tuple[float, float, float, float]:
    xs = [rig["points"][i][0] for i in indices]
    ys = [rig["points"][i][1] for i in indices]
    return min(xs), max(xs), min(ys), max(ys)


def as_marks(d: dict) -> RegionMarks:
    def pt(k: str) -> tuple[float, float]:
        return (d[k]["x"], d[k]["y"])

    return RegionMarks(
        left=pt("left"),
        right=pt("right"),
        top=pt("top"),
        bottom=pt("bottom"),
        center=pt("center") if "center" in d else None,
    )


def shift(marks: RegionMarks, dx: float = 0, dy: float = 0, scale: float = 1) -> RegionMarks:
    pts = marks.pairs()
    cx = sum(p[0] for p in pts) / len(pts)
    cy = sum(p[1] for p in pts) / len(pts)
    f = lambda p: (cx + (p[0] - cx) * scale + dx, cy + (p[1] - cy) * scale + dy)  # noqa: E731
    return RegionMarks(
        left=f(marks.left),
        right=f(marks.right),
        top=f(marks.top),
        bottom=f(marks.bottom),
        center=f(marks.center) if marks.center else None,
    )


def test_mouth_follows_where_it_was_marked() -> None:
    rig = make_rig()
    marks = as_marks(current_anchors(rig)["mouth"])
    out = apply_anchors(rig, mouth=shift(marks, dx=30, dy=-12, scale=1.4))

    bx0, bx1, by0, by1 = bounds(rig, rig["mouth_indices"])
    ax0, ax1, ay0, ay1 = bounds(out, out["mouth_indices"])
    assert (ax1 - ax0) == pytest.approx((bx1 - bx0) * 1.4, rel=0.05)
    assert (ay1 - ay0) == pytest.approx((by1 - by0) * 1.4, rel=0.05)
    assert (ax0 + ax1) / 2 == pytest.approx((bx0 + bx1) / 2 + 30, abs=2)
    assert (ay0 + ay1) / 2 == pytest.approx((by0 + by1) / 2 - 12, abs=2)


def test_the_mesh_is_not_torn_at_the_region_boundary() -> None:
    """The regression that made this necessary.

    A hard per-cluster edit moved eye points up to 32px while the socket ring
    one triangle away moved 0, so the bridging triangles stretched 32px along
    one edge and nothing along the other. That seam rendered as a visible
    layer over the eye. The correction must be continuous: points just outside
    a region have to move nearly as far as points just inside it.
    """
    rig = make_rig()
    marks = as_marks(current_anchors(rig)["mouth"])
    out = apply_anchors(rig, mouth=shift(marks, dy=-25, scale=1.5))

    cx = sum(rig["points"][i][0] for i in rig["mouth_indices"]) / len(rig["mouth_indices"])
    cy = sum(rig["points"][i][1] for i in rig["mouth_indices"]) / len(rig["mouth_indices"])
    radius = max(
        math.dist(rig["points"][i], (cx, cy)) for i in rig["mouth_indices"]
    )

    moved = [math.dist(rig["points"][i], out["points"][i]) for i in range(len(rig["points"]))]
    inside = [
        moved[i]
        for i in range(len(moved))
        if math.dist(rig["points"][i], (cx, cy)) <= radius
    ]
    just_outside = [
        moved[i]
        for i in range(len(moved))
        if radius < math.dist(rig["points"][i], (cx, cy)) <= radius * 1.35
    ]
    assert inside and just_outside
    # The ring immediately outside must not be left behind.
    assert max(just_outside) > max(inside) * 0.35


def test_displacement_decays_to_zero_with_distance() -> None:
    """...and equally, correcting the mouth must not drag the whole face."""
    rig = make_rig()
    marks = as_marks(current_anchors(rig)["mouth"])
    out = apply_anchors(rig, mouth=shift(marks, dy=-25, scale=1.5))

    cx = sum(rig["points"][i][0] for i in rig["mouth_indices"]) / len(rig["mouth_indices"])
    cy = sum(rig["points"][i][1] for i in rig["mouth_indices"]) / len(rig["mouth_indices"])
    far = [
        math.dist(rig["points"][i], out["points"][i])
        for i in range(len(rig["points"]))
        if math.dist(rig["points"][i], (cx, cy)) > 250
    ]
    assert far, "fixture should contain distant points"
    assert max(far) < 0.5


def test_a_tilted_marking_rotates_the_region() -> None:
    """A box could not express this: a mouth whose corners sit at different
    heights has to map onto a mouth whose corners sit at different heights."""
    rig = make_rig()
    m = as_marks(current_anchors(rig)["mouth"])
    tilted = RegionMarks(
        left=(m.left[0], m.left[1] + 18),
        right=(m.right[0], m.right[1] - 18),
        top=m.top,
        bottom=m.bottom,
        center=m.center,
    )
    out = apply_anchors(rig, mouth=tilted)

    left_i = min(rig["mouth_indices"], key=lambda i: rig["points"][i][0])
    right_i = max(rig["mouth_indices"], key=lambda i: rig["points"][i][0])
    assert out["points"][left_i][1] > out["points"][right_i][1] + 15


def test_regions_are_independent() -> None:
    rig = make_rig()
    before = bounds(rig, LEFT_EYE_INDICES)
    marks = as_marks(current_anchors(rig)["mouth"])
    out = apply_anchors(rig, mouth=shift(marks, dy=60))
    after = bounds(out, LEFT_EYE_INDICES)
    # The eyes sit well outside the mouth's falloff, so they barely move.
    assert all(abs(a - b) < 2.0 for a, b in zip(before, after))


def test_head_moves_everything_uniformly() -> None:
    rig = make_rig()
    marks = as_marks(current_anchors(rig)["head"])
    out = apply_anchors(rig, head=shift(marks, dx=25))
    for i in range(0, len(rig["points"]), 37):
        assert out["points"][i][0] == pytest.approx(rig["points"][i][0] + 25, abs=0.5)


def test_absurd_marks_are_rejected_not_applied() -> None:
    """A mis-drag must leave the rig usable rather than exploding the mesh."""
    rig = make_rig()
    out = apply_anchors(
        rig,
        mouth=RegionMarks(left=(0, 0), right=(9000, 9000), top=(0, 9000), bottom=(9000, 0)),
    )
    x0, x1, _, _ = bounds(rig, rig["mouth_indices"])
    nx0, nx1, _, _ = bounds(out, out["mouth_indices"])
    assert (nx1 - nx0) <= (x1 - x0) * MAX_SCALE + 1


def test_collapsed_marks_do_not_explode_the_mesh() -> None:
    rig = make_rig()
    out = apply_anchors(
        rig, mouth=RegionMarks(left=(400, 520), right=(400, 520), top=(400, 520), bottom=(400, 520))
    )
    assert all(abs(x) < 1e5 and abs(y) < 1e5 for x, y in out["points"])


def test_no_anchors_is_a_no_op() -> None:
    rig = make_rig()
    out = apply_anchors(rig)
    assert out["points"] == [[round(x, 2), round(y, 2)] for x, y in rig["points"]]


def test_open_and_save_without_dragging_changes_nothing() -> None:
    """The handles open on the detection, so this is the commonest path."""
    rig = make_rig()
    a = current_anchors(rig)
    out = apply_anchors(
        rig,
        head=as_marks(a["head"]),
        left_eye=as_marks(a["left_eye"]),
        right_eye=as_marks(a["right_eye"]),
        mouth=as_marks(a["mouth"]),
    )
    for before, after in zip(rig["points"], out["points"]):
        assert after[0] == pytest.approx(before[0], abs=0.2)
        assert after[1] == pytest.approx(before[1], abs=0.2)


def test_short_synthetic_mesh_does_not_raise() -> None:
    """The fallback mesh is shorter than MediaPipe's 478 and has no iris."""
    rig = make_rig(n=120)
    marks = as_marks(current_anchors(rig)["left_eye"])
    out = apply_anchors(rig, left_eye=shift(marks, dx=5))
    assert len(out["points"]) == 120


def test_face_box_is_recomputed() -> None:
    rig = make_rig()
    marks = as_marks(current_anchors(rig)["head"])
    out = apply_anchors(rig, head=shift(marks, dx=40))
    assert out["face_box"][0] == pytest.approx(rig["face_box"][0], abs=1e9)  # exists
    xs = [p[0] for p in out["points"]]
    assert out["face_box"][0] == pytest.approx(min(xs), abs=0.05)
    assert out["face_box"][2] == pytest.approx(max(xs), abs=0.05)
