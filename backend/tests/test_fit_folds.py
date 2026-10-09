"""No dead end at "Place the points": the marks a face opens on always
publish, a sliver between marks the owner moved is smoothed, and only marks
out of place are refused.

The case this was written for: a person on the Animation look (the cartoon
line), found by MediaPipe, whose detector's own marks the fit refused for
one folded lip triangle, so Publish stayed disabled and "Reset points" put
the same marks back. The fit lays a mouth line's lips out itself (the inner
lip onto the line, the rings in columns) and the oval on its outline; a
triangle a pixel thin that this layout turns over from the raw detection
was counted as a fold. Measured on detector-like faces (real detections,
rolled, widened, opened, jittered, shut-eyed) before this change: 65% were
refused on their own marks on the cartoon line, 4% on the human one (shut
eyes); after, none.
"""

from __future__ import annotations

import copy
import json
from dataclasses import replace
from pathlib import Path

import numpy as np
import pytest

from app.services import face_template
from app.services.anchor_fit import (
    FOLDED_MESH,
    INNER_LOWER,
    INNER_UPPER,
    LEFT_EYE,
    LEFT_IRIS,
    LIP_ROWS_LOWER,
    LIP_ROWS_UPPER,
    MOUTH,
    RIGHT_EYE,
    RIGHT_IRIS,
    FaceMarks,
    PupilMarks,
    RegionMarks,
    correspondences,
    fit_marks,
    fit_rig,
    flipped_triangles,
    marks_from_dict,
    marks_to_dict,
    own_marks,
    part_lips,
    pinned_landmarks,
    reference_points,
    skin_triangles,
    smooth_folds,
    validate,
    warp,
    warped_points,
)
from app.services.anchors import anchors_on
from app.services.rig import build_rig

FIXTURES = Path(__file__).parent / "fixtures"
EMBED_FIXTURES = Path(__file__).resolve().parents[2] / "embed/src/__tests__/fixtures"
CASE = json.loads((FIXTURES / "stuck_points_case.json").read_text())
LINES = ("cartoon", "human")


def codes(problems) -> set[str]:
    return {p.code for p in problems}


def _areas(points: np.ndarray, triangles: np.ndarray) -> np.ndarray:
    a, b, c = (points[triangles[:, k]] for k in range(3))
    return (b[:, 0] - a[:, 0]) * (c[:, 1] - a[:, 1]) - (b[:, 1] - a[:, 1]) * (c[:, 0] - a[:, 0])


def old_fold_count(start: np.ndarray, fitted: np.ndarray) -> int:
    """The fold count validate made before reference_points: orientation
    against the base alone, any triangle above FLIP_EPSILON of the box."""
    triangles = skin_triangles(start)
    before, after = _areas(start, triangles), _areas(fitted, triangles)
    box = np.ptp(start, axis=0)
    eps = 1e-7 * float(box[0] * box[1]) * 2
    measurable = (np.abs(before) > eps) & (np.abs(after) > eps)
    return int(np.sum(measurable & (np.sign(before) != np.sign(after))))


def case_base() -> np.ndarray:
    return np.array(CASE["base"], dtype=np.float64)


def skeleton(base: np.ndarray, size, face_type: str) -> dict:
    return build_rig(base, tuple(size), None, face_type=face_type)


# --- the production case ------------------------------------------------------------


def test_the_stuck_cartoon_publishes_on_the_marks_it_opened_on():
    """case.json's marks, through the fit preview-rig and finish run: once
    refused for one folded lip triangle, now saveable, and the very rig the
    base's own marks make."""
    base = case_base()
    marks = marks_from_dict(CASE["marks"], "cartoon")
    plain = warped_points(base, marks, "cartoon")
    # What refused it: one lip triangle the layout turns over from the
    # detection (82 and 87, the inner lips, put in one column on the line).
    assert old_fold_count(part_lips(base), plain) == 1
    result = fit_marks(skeleton(base, CASE["image_size"], "cartoon"), base, marks, "cartoon")
    assert result.problems == []
    assert result.notes == []  # nothing smoothed: the marks were never crossed
    assert np.array(result.rig["points"]) == pytest.approx(reference_points(base, "cartoon"))


def test_reset_points_restores_exactly_the_stuck_marks_and_they_now_pass():
    base = case_base()
    assert marks_to_dict(own_marks(base, "cartoon")) == CASE["marks"]
    found = anchors_on(base, (1024, 1024), "cartoon")
    assert found["detected"] is True
    assert found["marks"] == CASE["marks"]
    assert found["validation"]["ok"] is True
    assert found["validation"]["one_click"] is True


# --- the sweep: detector-like faces open on marks that always pass -------------------


def _bases() -> dict[str, tuple[np.ndarray, tuple[int, int]]]:
    out: dict[str, tuple[np.ndarray, tuple[int, int]]] = {}
    for npz, prefix in (
        ("reference_pose_detections.npz", "pose"),
        ("repo_face_detections.npz", ""),
    ):
        data = np.load(FIXTURES / npz)
        names = sorted({k.rsplit("_", 1)[0] for k in data.files})
        for name in names:
            size = tuple(int(v) for v in data[f"{name}_size"])
            out[f"{prefix}_{name}".strip("_")] = (np.asarray(data[f"{name}_points"]), size)
    rig = json.loads((EMBED_FIXTURES / "human-rig.json").read_text())
    out["embed_human_rig"] = (np.array(rig["points"], dtype=np.float64), tuple(rig["image_size"]))
    out["stuck_case"] = (case_base(), (1024, 1024))
    return out


BASES = _bases()
LOWER_LIP = sorted({i for row in LIP_ROWS_LOWER for i in row[1:-1]})
LIPS = sorted({i for rows in (LIP_ROWS_UPPER, LIP_ROWS_LOWER) for row in rows for i in row})
UPPER_LIDS = ([246, 161, 160, 159, 158, 157, 173], [466, 388, 387, 386, 385, 384, 398])
LOWER_LIDS = ([7, 163, 144, 145, 153, 154, 155], [249, 390, 373, 374, 380, 381, 382])


def _rolled(p: np.ndarray, degrees: float) -> np.ndarray:
    t = np.radians(degrees)
    c = p.mean(axis=0)
    return (p - c) @ np.array([[np.cos(t), np.sin(t)], [-np.sin(t), np.cos(t)]]) + c


def _widened(p: np.ndarray, factor: float) -> np.ndarray:
    c = p.mean(axis=0)
    return np.column_stack(((p[:, 0] - c[0]) * factor + c[0], p[:, 1]))


def _opened(p: np.ndarray, gap: float) -> np.ndarray:
    """The jaw dropped by `gap` of the mouth's width: the lower lip, and the
    chin below it, as a detection of an open mouth has them."""
    q = p.copy()
    width = float(np.linalg.norm(p[MOUTH["right"]] - p[MOUTH["left"]]))
    seam_y, chin_y = (p[13][1] + p[14][1]) / 2, p[152][1]
    for i in range(len(p)):
        if i in LOWER_LIP:
            q[i][1] += gap * width
        elif p[i][1] > seam_y and abs(p[i][0] - p[13][0]) < 1.2 * width and i not in LIPS:
            fade = np.clip((chin_y - p[i][1]) / max(chin_y - seam_y, 1e-6), 0, 1)
            q[i][1] += gap * width * (1 - 0.5 * fade)
    return q


def _shut(p: np.ndarray, cross: float) -> np.ndarray:
    """Both eyes shut, the upper lids `cross` px past the lower ones; the
    irises stay where the eyeballs are, above them."""
    q = p.copy()
    for uppers, lowers in zip(UPPER_LIDS, LOWER_LIDS):
        for u, lo in zip(uppers, lowers):
            q[u] = p[lo] + (0.0, -cross)
    return q


def _jittered(p: np.ndarray, sigma: float, seed: int, only=None) -> np.ndarray:
    rng = np.random.default_rng(seed)
    q = p.copy()
    idx = np.arange(len(p)) if only is None else np.array(only)
    q[idx] += rng.normal(0, sigma, size=(len(idx), 2))
    return q


def detector_like(p: np.ndarray) -> list[tuple[str, np.ndarray]]:
    """A detection, and detections of the same face a little otherwise:
    rolled, wider or narrower, its mouth open, its eyes shut, and the
    detector's own noise (pixels on a 1000 px face)."""
    px = float(np.ptp(p, axis=0).max()) / 1000
    return [
        ("as detected", p),
        ("rolled 10", _rolled(p, 10)),
        ("rolled -10", _rolled(p, -10)),
        ("narrow", _widened(p, 0.85)),
        ("wide", _widened(p, 1.2)),
        ("open 0.15", _opened(p, 0.15)),
        ("open 0.3", _opened(p, 0.3)),
        ("shut", _shut(p, 0.0)),
        ("shut, lids crossed", _shut(p, 1.0)),
        *[(f"noise 1px #{s}", _jittered(p, px, s)) for s in range(3)],
        *[(f"lip noise 2px #{s}", _jittered(p, 2 * px, 10 + s, LIPS)) for s in range(3)],
        ("open, lip noise", _jittered(_opened(p, 0.144), px, 20, LIPS)),
    ]


@pytest.mark.parametrize("face_type", LINES)
@pytest.mark.parametrize("name", sorted(BASES))
def test_detector_marks_always_pass_and_reset_is_never_a_dead_end(name, face_type):
    """Whatever a detector finds, the marks the face opens on (and Reset
    restores) pass the validator, on the face found, without a fallback,
    and fit to exactly the reference: no fold, nothing to smooth."""
    points, size = BASES[name]
    for variant, p in detector_like(points):
        found = anchors_on(np.asarray(p), size, face_type)
        assert found["detected"] is True, variant
        assert found["validation"]["ok"] is True, (variant, found["validation"]["reasons"])
        base = np.array(found["base"])
        result = fit_marks(
            skeleton(base, size, face_type),
            base,
            marks_from_dict(found["marks"], face_type),
            face_type,
        )
        assert result.problems == [] and result.notes == [], variant
        assert np.array(result.rig["points"]) == pytest.approx(reference_points(base, face_type))


def test_the_sweep_exercises_the_failure_it_guards():
    """A fold count against the detection alone refuses a good share of the
    sweep's cartoon faces on their own marks: the cases are the bug's."""
    refused = total = 0
    for points, _size in BASES.values():
        for _, p in detector_like(points):
            base = np.round(np.asarray(p, dtype=np.float64), 3)
            marks = own_marks(base, "cartoon")
            total += 1
            refused += old_fold_count(part_lips(base), warped_points(base, marks, "cartoon")) > 0
    assert refused / total > 0.25, (refused, total)


# --- the owner's marks: slivers smoothed, marks out of place refused ------------------


def _pose(name: str) -> tuple[np.ndarray, tuple[int, int]]:
    return BASES[f"pose_{name}"]


def test_a_sliver_left_by_a_moved_mark_is_smoothed_and_the_marks_stay_put():
    """A wide-open mouth, its corner moved 4 px: one thin lip triangle
    folds. Smoothed, saveable, said in a note, every mark where placed."""
    points, size = _pose("oh")
    base = np.round(points, 3)
    marks = marks_to_dict(own_marks(base, "cartoon"))
    moved = copy.deepcopy(marks)
    corner = moved["mouth_line"][0]
    corner["x"], corner["y"] = round(corner["x"] - 4, 2), round(corner["y"] + 4, 2)
    face = marks_from_dict(moved, "cartoon")
    start = part_lips(base)
    plain = warped_points(base, face, "cartoon")
    reference = reference_points(base, "cartoon")
    assert codes(validate(start, plain, reference=reference)) == {FOLDED_MESH}

    result = fit_marks(skeleton(base, size, "cartoon"), base, face, "cartoon")
    assert result.problems == []
    assert [(n.code, n.count) for n in result.notes] == [("folds_smoothed", 1)]
    fitted = np.array(result.rig["points"])
    for i in pinned_landmarks(face, "cartoon"):
        assert fitted[i] == pytest.approx(plain[i], abs=1e-9), i
    # Only a few landmarks moved, and not far.
    moved_by = np.linalg.norm(fitted - plain, axis=1)
    assert 0 < np.count_nonzero(moved_by) <= 12
    assert moved_by.max() < 0.03 * float(np.ptp(reference, axis=0).max())


def test_a_fit_that_passes_is_not_touched():
    """Neither smoothing nor the torn-pin warp runs on a fit that passes:
    its rig is the warp's, exactly as before them."""
    rig = json.loads((EMBED_FIXTURES / "human-rig.json").read_text())
    base = np.array(rig["points"], dtype=np.float64)
    marks = own_marks(base, "human")
    m = marks.mouth
    assert m is not None and m.center is not None
    wider = replace(m, left=(m.left[0] - 15, m.left[1]), right=(m.right[0] + 15, m.right[1]))
    face = replace(marks, mouth=wider)
    result = fit_marks(rig, base, face, "human")
    assert result.problems == [] and result.notes == []
    assert result.rig["points"] == warped_points(base, face, "human").tolist()


@pytest.mark.parametrize(
    "misplace, code",
    [
        ("eyes swapped", "eyes_out_of_order"),
        ("mouth above the eyes", "mouth_above_eyes"),
        ("lids swapped", "lids_inverted"),
        ("pupil on the cheek", "pupil_outside_eye"),
    ],
)
@pytest.mark.parametrize("face_type", LINES)
def test_marks_grossly_out_of_place_are_refused_and_not_smoothed(misplace, code, face_type):
    base = case_base()
    marks = marks_to_dict(own_marks(base, face_type))
    bad = copy.deepcopy(marks)
    if misplace == "eyes swapped":
        bad["left_eye"], bad["right_eye"] = bad["right_eye"], bad["left_eye"]
    elif misplace == "mouth above the eyes":
        lift = 200.0
        if face_type == "cartoon":
            bad["mouth_line"] = [{"x": p["x"], "y": p["y"] - lift} for p in bad["mouth_line"]]
        else:
            bad["mouth"] = {k: {"x": p["x"], "y": p["y"] - lift} for k, p in bad["mouth"].items()}
    elif misplace == "lids swapped":
        eye = bad["left_eye"]
        eye["top"], eye["bottom"] = eye["bottom"], eye["top"]
    else:
        pupil = bad["left_pupil"]
        pupil["center"] = {"x": pupil["center"]["x"], "y": pupil["center"]["y"] + 120}
        pupil["rim"] = {"x": pupil["rim"]["x"], "y": pupil["rim"]["y"] + 120}
    result = fit_marks(
        skeleton(base, (1024, 1024), face_type), base, marks_from_dict(bad, face_type), face_type
    )
    assert code in codes(result.problems)
    assert result.notes == []


def test_a_fold_that_needs_a_mark_moved_stays_refused():
    """A mouth line dragged up through the eyes folds the face: smoothing
    may not move a mark, nor anything far, so it is refused, with its
    count."""
    base = face_template.place(face_template.default_box(1000, 1000))
    marks = FaceMarks(
        head=RegionMarks((200, 500), (800, 500), (500, 150), (500, 850)),
        left_eye=RegionMarks((330, 400), (450, 400), (390, 360), (390, 440)),
        right_eye=RegionMarks((550, 400), (670, 400), (610, 360), (610, 440)),
        mouth_line=((330, 600), (415, 380), (500, 700), (585, 380), (670, 600)),
        chin=(500, 850),
    )
    result = fit_marks({"image_size": [1000, 1000]}, base, marks, "animal")
    folded = [p for p in result.problems if p.code == FOLDED_MESH]
    assert folded and (folded[0].count or 0) > 0
    assert result.notes == []


def test_smoothing_gives_up_rather_than_move_a_mark():
    """Folds whose corners are all pinned are marks crossing each other:
    nothing is moved, and nothing is returned."""
    base = case_base()
    start = part_lips(base)
    reference = reference_points(base, "cartoon")
    crossed = reference.copy()
    # The left eye's outer corner dragged past its inner one.
    crossed[LEFT_EYE["left"]] = reference[LEFT_EYE["right"]] + (40, 0)
    assert flipped_triangles(start, crossed, reference=reference) > 0
    assert smooth_folds(start, reference, crossed, set(range(len(base)))) is None
    # Nothing folded, nothing to do.
    assert smooth_folds(start, reference, reference.copy(), set()) == (pytest.approx(reference), 0)


# --- shut eyes ----------------------------------------------------------------------


def test_a_shut_eye_opens_with_its_pupil_inside_and_its_lids_may_touch():
    points, size = BASES["demo_portrait"]
    shut = np.round(_shut(points, 1.0), 3)
    marks = own_marks(shut, "cartoon")
    for pupil, eye in ((marks.left_pupil, marks.left_eye), (marks.right_pupil, marks.right_eye)):
        assert pupil is not None and eye is not None
        xs, ys = sorted((eye.left[0], eye.right[0])), sorted((eye.top[1], eye.bottom[1]))
        assert xs[0] <= pupil.center[0] <= xs[1]
        assert ys[0] <= pupil.center[1] <= ys[1]
        assert pupil.rim[0] - pupil.center[0] > 0  # still a circle
    result = fit_marks(skeleton(shut, size, "cartoon"), shut, marks, "cartoon")
    assert result.problems == []


def test_an_open_eyes_pupil_is_left_where_it_was_detected():
    base = case_base()
    marks = own_marks(base, "cartoon")
    assert marks.left_pupil == PupilMarks(
        (CASE["marks"]["left_pupil"]["center"]["x"], CASE["marks"]["left_pupil"]["center"]["y"]),
        (CASE["marks"]["left_pupil"]["rim"]["x"], CASE["marks"]["left_pupil"]["rim"]["y"]),
    )


def test_a_lid_nudged_on_a_shut_eye_does_not_throw_the_face_about():
    """The lids of a shut eye start a pixel apart; its top mark nudged 3 px
    up (opening it a little) moved the face 80 px, and folded nothing, so
    nothing refused it. Pins pulled apart from one point are one control
    point of the warp then."""
    points, size = BASES["lab_portrait"]
    shut = np.round(_shut(points, 0.3), 3)
    marks = marks_to_dict(own_marks(shut, "human"))
    nudged = copy.deepcopy(marks)
    top = nudged["left_eye"]["top"]
    top["y"] = round(top["y"] - 3.3, 2)
    face = marks_from_dict(nudged, "human")
    pairs = correspondences(shut, face, "human")
    # The irises are left out: a shut eye's opens inside its lids (above).
    far_from_the_eye = [
        i
        for i in range(len(shut))
        if np.linalg.norm(shut[i] - shut[159]) > 60 and i not in LEFT_IRIS + RIGHT_IRIS
    ]

    def thrown(points: np.ndarray) -> float:
        return float(np.abs(points[far_from_the_eye] - shut[far_from_the_eye]).max())

    assert thrown(warp(shut, pairs)) > 40  # what it did
    assert thrown(warp(shut, pairs, tear=True)) < 2
    result = fit_marks(skeleton(shut, size, "human"), shut, face, "human")
    assert result.problems == []
    assert thrown(np.array(result.rig["points"])) < 2
    assert np.array(result.rig["points"])[159] == pytest.approx((top["x"], top["y"]))


def test_a_detection_whose_own_marks_are_out_of_order_opens_on_the_template():
    """The last resort behind "Reset never dead-ends": a detection whose own
    marks are refused (here its eyes are the wrong way round) is not
    trusted; the template, on its face box, opens as a guess the owner
    places, and that guess passes."""
    points, size = BASES["demo_portrait"]
    swapped = points.copy()
    apart = points[RIGHT_EYE["left"]] - points[LEFT_EYE["left"]]
    for i in [*LEFT_EYE.values(), *LEFT_IRIS]:
        swapped[i] = points[i] + apart
    for i in [*RIGHT_EYE.values(), *RIGHT_IRIS]:
        swapped[i] = points[i] - apart
    found = anchors_on(swapped, size, "cartoon")
    assert found["detected"] is False
    assert found["validation"]["ok"] is True
    guess = np.array(found["base"])
    assert guess.min(axis=0) == pytest.approx(swapped.min(axis=0), abs=0.01)
    assert guess.max(axis=0) == pytest.approx(swapped.max(axis=0), abs=0.01)


def test_fit_rig_is_fit_marks_without_its_notes():
    base = case_base()
    marks = marks_from_dict(CASE["marks"], "cartoon")
    rig = skeleton(base, (1024, 1024), "cartoon")
    assert fit_rig(rig, base, marks, "cartoon") == (
        fit_marks(rig, base, marks, "cartoon").rig,
        fit_marks(rig, base, marks, "cartoon").problems,
    )


def test_the_inner_lips_of_the_case_sit_in_columns_on_the_line():
    """What turned the triangle over: the layout, not a crossing. Each
    inner-lip column sits on the mouth line, the upper one above."""
    base = case_base()
    fitted = reference_points(base, "cartoon")
    for upper, lower in zip(INNER_UPPER[1:-1], INNER_LOWER[1:-1]):
        assert fitted[upper][1] < fitted[lower][1]
        assert abs(fitted[upper][0] - fitted[lower][0]) < 0.05
