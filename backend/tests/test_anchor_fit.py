"""The anchor fit: marks in, a face out, never a folded one.

The layouts are the ones the fit was designed against: a dog's wide muzzle,
a cat's small mouth, a toon's big grin and an anime mouth a few pixels wide,
each on a head and eyes far from where a human template puts them. The
chained local warps this replaced folded 37 to 147 of the mesh's triangles
on these; one global warp must fold none.
"""

from __future__ import annotations

import json
import math
from dataclasses import replace
from pathlib import Path

import numpy as np
import pytest

from app.services import face_template
from app.services.anchor_fit import (
    INNER_LOWER,
    INNER_UPPER,
    IRIS,
    LEFT_COMMISSURE,
    LEFT_IRIS,
    RIGHT_COMMISSURE,
    RIGHT_IRIS,
    SEAM_GAP,
    FaceMarks,
    PupilMarks,
    RegionMarks,
    correspondences,
    fit_base_points,
    fit_base_record,
    fit_rig,
    flipped_triangles,
    marks_from_dict,
    marks_from_mesh,
    marks_to_dict,
    merge,
    move_fit_base,
    part_lips,
    saved_marks,
    validate,
    warp,
)
from app.services.rig import build_rig, template_mesh

FIXTURES = Path(__file__).resolve().parents[2] / "embed/src/__tests__/fixtures"

HEAD = RegionMarks((200, 500), (800, 500), (500, 150), (500, 850))
LEFT_EYE = RegionMarks((330, 400), (450, 400), (390, 360), (390, 440))
RIGHT_EYE = RegionMarks((550, 400), (670, 400), (610, 360), (610, 440))
LAYOUTS = {
    "dog wide muzzle": ((330, 700), (415, 712), (500, 715), (585, 712), (670, 700)),
    "cat small mouth": ((460, 700), (480, 705), (500, 707), (520, 705), (540, 700)),
    "toon big grin": ((300, 690), (400, 740), (500, 760), (600, 740), (700, 690)),
    "anime tiny": ((485, 720), (492, 722), (500, 723), (508, 722), (515, 720)),
}


def template_rig(size=(1000, 1000)) -> tuple[dict, np.ndarray]:
    """An undetected animal's first build: the template in the default box."""
    base = face_template.place(face_template.default_box(*size))
    return {"image_size": list(size), "points": base.round(2).tolist()}, base


def human_rig() -> tuple[dict, np.ndarray]:
    rig = json.loads((FIXTURES / "human-rig.json").read_text())
    return rig, np.array(rig["points"], dtype=float)


def line_marks(layout: str, chin=(500, 850)) -> FaceMarks:
    return FaceMarks(
        head=HEAD, left_eye=LEFT_EYE, right_eye=RIGHT_EYE,
        mouth_line=LAYOUTS[layout], chin=chin,
    )


def distance_to_polyline(p: np.ndarray, line) -> float:
    pts = np.array(line, dtype=float)
    best = math.inf
    for a, b in zip(pts, pts[1:]):
        ab = b - a
        t = float(np.clip((p - a) @ ab / (ab @ ab), 0, 1))
        best = min(best, float(np.linalg.norm(p - (a + ab * t))))
    return best


@pytest.mark.parametrize("face_type", ["animal", "cartoon"])
@pytest.mark.parametrize("layout", LAYOUTS)
def test_animal_and_cartoon_layouts_fold_nothing(face_type, layout):
    rig, base = template_rig()
    out, problems = fit_rig(rig, base, line_marks(layout), face_type)
    fitted = np.array(out["points"])
    assert flipped_triangles(base, fitted) == 0
    assert problems == []


@pytest.mark.parametrize("layout", LAYOUTS)
def test_a_detected_closed_mouth_takes_a_mouth_line_without_folding(layout):
    """A cartoon MediaPipe did detect: its lips are closed, their rings a
    pixel apart and crossed, and the line still has to part them cleanly."""
    rig, base = human_rig()
    out, problems = fit_rig(rig, base, line_marks(layout), "cartoon")
    assert problems == []
    assert flipped_triangles(part_lips(base), np.array(out["points"])) == 0


def test_parting_the_lips_puts_the_upper_one_above():
    _, base = human_rig()
    assert base[13][1] > base[14][1]  # the demo portrait's lips are crossed
    parted = part_lips(base)
    assert parted[13][1] < parted[14][1]
    moved = np.flatnonzero(np.abs(parted - base).max(axis=1) > 0)
    assert set(moved) <= set(INNER_UPPER + INNER_LOWER)
    assert np.abs(parted - base).max() < 1.0
    # The template is built parted already (to its stored precision).
    _, template = template_rig()
    assert np.abs(part_lips(template) - template).max() < 0.01


@pytest.mark.parametrize("layout", LAYOUTS)
def test_every_mark_lands_where_it_was_placed(layout):
    rig, base = template_rig()
    marks = line_marks(layout)
    fitted = np.array(fit_rig(rig, base, marks, "animal")[0]["points"])
    for i, target in correspondences(base, marks, "animal"):
        assert np.linalg.norm(fitted[i] - target) < 0.1, i
    assert fitted[234] == pytest.approx(HEAD.left, abs=0.1)
    assert fitted[33] == pytest.approx(LEFT_EYE.left, abs=0.1)
    assert fitted[263] == pytest.approx(RIGHT_EYE.right, abs=0.1)


@pytest.mark.parametrize("layout", LAYOUTS)
def test_the_inner_lips_lie_on_the_mouth_line_the_upper_one_above(layout):
    rig, base = template_rig()
    line = LAYOUTS[layout]
    fitted = np.array(fit_rig(rig, base, line_marks(layout), "animal")[0]["points"])
    width = math.dist(line[0], line[-1])
    for i in set(INNER_UPPER + INNER_LOWER):
        assert distance_to_polyline(fitted[i], line) <= SEAM_GAP * width / 2 + 0.02, i
    for upper, lower in zip(INNER_UPPER[1:-1], INNER_LOWER[1:-1]):
        assert fitted[upper][1] < fitted[lower][1], (upper, lower)
    assert fitted[14][1] - fitted[13][1] == pytest.approx(SEAM_GAP * width, abs=0.1)
    # The whole commissure sits exactly on the corner: a lip line has no
    # inner corner, and a hundredth of a pixel apart would be a sliver.
    for i in LEFT_COMMISSURE:
        assert tuple(fitted[i]) == line[0]
    for i in RIGHT_COMMISSURE:
        assert tuple(fitted[i]) == line[-1]


def test_a_chin_above_the_head_bottom_takes_the_jaw():
    """A dog's jowls hang below its jaw: the chin mark, not the head's
    bottom edge, is where the face mesh ends."""
    rig, base = template_rig()
    marks = line_marks("dog wide muzzle", chin=(500, 790))
    fitted = np.array(fit_rig(rig, base, marks, "animal")[0]["points"])
    assert fitted[152] == pytest.approx((500, 790), abs=0.1)
    assert flipped_triangles(base, fitted) == 0


def test_a_chin_on_the_head_bottom_is_one_mark():
    rig, base = template_rig()
    marks = line_marks("dog wide muzzle", chin=(501, 851))
    pinned = [i for i, _ in correspondences(base, marks, "animal")]
    assert pinned.count(152) == 1


def test_saving_the_same_marks_twice_stores_the_same_rig():
    """Fits always start from the base, never from the previous fit."""
    rig, base = template_rig()
    first, _ = fit_rig(rig, base, line_marks("toon big grin"), "cartoon")
    second, _ = fit_rig(first, base, line_marks("toon big grin"), "cartoon")
    assert first == second


def test_a_human_opened_and_saved_does_not_move():
    rig, base = human_rig()
    out, problems = fit_rig(rig, base, marks_from_mesh(base, "human"), "human")
    assert problems == []
    assert np.abs(np.array(out["points"]) - base).max() < 0.01


def test_a_human_mouth_marked_wider_folds_nothing_and_keeps_its_seam():
    rig, base = human_rig()
    marks = marks_from_mesh(base, "human")
    m = marks.mouth
    wider = RegionMarks(
        (m.left[0] - 15, m.left[1]), (m.right[0] + 15, m.right[1]), m.top,
        (m.bottom[0], m.bottom[1] + 10), (m.center[0], m.center[1] + 4),
    )
    out, problems = fit_rig(rig, base, replace(marks, mouth=wider), "human")
    fitted = np.array(out["points"])
    assert problems == []
    assert fitted[61] == pytest.approx(wider.left, abs=0.1)
    assert fitted[17] == pytest.approx(wider.bottom, abs=0.1)
    # The two lips keep the separation they were photographed with.
    assert fitted[14] - fitted[13] == pytest.approx(base[14] - base[13], abs=0.02)
    assert (fitted[13] + fitted[14]) / 2 == pytest.approx(wider.center, abs=0.1)


def test_a_marked_pupil_is_that_circle():
    rig, base = human_rig()
    marks = marks_from_mesh(base, "human")
    center = (marks.left_pupil.center[0] + 3, marks.left_pupil.center[1] - 2)
    pupil = PupilMarks(center, (center[0] + 20, center[1]))
    fitted = np.array(fit_rig(rig, base, replace(marks, left_pupil=pupil), "human")[0]["points"])
    assert fitted[468] == pytest.approx(center, abs=0.1)
    radius = np.mean([np.linalg.norm(fitted[j] - fitted[468]) for j in LEFT_IRIS[1:]])
    assert radius == pytest.approx(20, abs=0.2)


def _pupil(center, radius) -> PupilMarks:
    return PupilMarks(center, (center[0] + radius, center[1]))


def _resized(pupil: PupilMarks, factor: float) -> PupilMarks:
    return _pupil(pupil.center, math.dist(pupil.center, pupil.rim) * factor)


@pytest.mark.parametrize("factor", [0.6, 0.85, 1.3])
def test_a_human_pupil_drawn_another_size_saves(factor):
    """The detected iris reaches past both lids; a smaller pupil pulled
    inside them folds nothing, because the iris is not skin."""
    rig, base = human_rig()
    marks = marks_from_mesh(base, "human")
    resized = replace(
        marks, left_pupil=_resized(marks.left_pupil, factor),
        right_pupil=_resized(marks.right_pupil, factor),
    )
    out, problems = fit_rig(rig, base, resized, "human")
    assert problems == []
    fitted = np.array(out["points"])
    radius = np.mean([np.linalg.norm(fitted[j] - fitted[468]) for j in LEFT_IRIS[1:]])
    pupil = resized.left_pupil
    assert radius == pytest.approx(math.dist(pupil.center, pupil.rim), abs=0.05)


@pytest.mark.parametrize("dy", [3, 6, 10])
def test_a_lower_lid_moved_past_the_iris_saves(dy):
    rig, base = human_rig()
    marks = marks_from_mesh(base, "human")
    e = marks.left_eye
    lower = replace(marks, left_eye=RegionMarks(e.left, e.right, e.top, (e.bottom[0], e.bottom[1] + dy)))
    out, problems = fit_rig(rig, base, lower, "human")
    assert problems == []
    # The iris stays the marked circle; the lid alone moved.
    assert np.array(out["points"])[LEFT_IRIS] == pytest.approx(base[LEFT_IRIS], abs=0.01)


@pytest.mark.parametrize("seed", range(5))
def test_a_toon_pupil_inside_its_eye_saves(seed):
    """Toon eyes of any proportion with a pupil drawn inside the white."""
    rng = np.random.default_rng(seed)
    rig, base = template_rig()
    for _ in range(20):
        eyes, pupils = [], []
        for cx in (390, 610):
            w = rng.uniform(70, 150)
            h = w * rng.uniform(0.35, 1.0)
            eyes.append(RegionMarks((cx - w / 2, 400), (cx + w / 2, 400), (cx, 400 - h / 2), (cx, 400 + h / 2)))
            pupils.append(_pupil((cx, 400), h * rng.uniform(0.2, 0.45)))
        marks = replace(
            line_marks("toon big grin"), left_eye=eyes[0], right_eye=eyes[1],
            left_pupil=pupils[0], right_pupil=pupils[1],
        )
        assert fit_rig(rig, base, marks, "cartoon")[1] == []


def test_marking_a_pupil_does_not_move_the_skin():
    """The pupil is placed after the warp: the lids and the face around it
    are exactly what they are without it."""
    rig, base = human_rig()
    marks = marks_from_mesh(base, "human")
    shifted = replace(marks, left_pupil=_pupil((marks.left_pupil.center[0] + 4, marks.left_pupil.center[1]), 6))
    with_pupil = np.array(fit_rig(rig, base, shifted, "human")[0]["points"])
    without = np.array(fit_rig(rig, base, replace(marks, left_pupil=None), "human")[0]["points"])
    skin = [i for i in range(478) if i not in IRIS]
    assert np.abs(with_pupil[skin] - without[skin]).max() < 0.01
    assert with_pupil[RIGHT_IRIS] == pytest.approx(without[RIGHT_IRIS], abs=0.01)


def test_a_pupil_outside_its_eye_is_refused():
    rig, base = human_rig()
    marks = marks_from_mesh(base, "human")
    p = marks.left_pupil
    down = PupilMarks((p.center[0], p.center[1] + 60), (p.rim[0], p.rim[1] + 60))
    problems = fit_rig(rig, base, replace(marks, left_pupil=down), "human")[1]
    assert codes(problems) == {"pupil_outside_eye"}


def test_an_animals_unmarked_iris_is_never_checked():
    """An animal has no pupil handles, so nothing it could not fix refuses it."""
    rig, base = template_rig()
    fitted = base.copy()
    fitted[LEFT_IRIS] += (0, 300)
    assert "pupil_outside_eye" in codes(validate(base, fitted))
    assert "pupil_outside_eye" not in codes(validate(base, fitted, pupils=False))


def test_triangles_on_the_iris_are_not_counted_as_folds():
    _, base = human_rig()
    fitted = base.copy()
    fitted[LEFT_IRIS] = base[LEFT_IRIS[0]] + (base[LEFT_IRIS] - base[LEFT_IRIS[0]]) * 0.3
    assert flipped_triangles(base, fitted) == 0


def test_unmarked_regions_ride_with_the_head():
    """Only the head moved: the eyes go with it rather than staying behind."""
    rig, base = human_rig()
    marks = marks_from_mesh(base, "human")
    h = marks.head
    moved = RegionMarks(*[(p[0] + 30, p[1] + 10) for p in (h.left, h.right, h.top, h.bottom)])
    fitted = np.array(fit_rig(rig, base, FaceMarks(head=moved), "human")[0]["points"])
    for i in (33, 133, 61, 291, 468):
        assert fitted[i] == pytest.approx(base[i] + (30, 10), abs=0.1), i


def test_regions_left_out_stay_where_they_were():
    rig, base = human_rig()
    m = marks_from_mesh(base, "human").mouth
    lower = RegionMarks(*[(p[0], p[1] + 25) for p in (m.left, m.right, m.top, m.bottom, m.center)])
    fitted = np.array(fit_rig(rig, base, FaceMarks(mouth=lower), "human")[0]["points"])
    assert np.linalg.norm(fitted[61] - base[61]) == pytest.approx(25, abs=0.1)
    for i in (33, 133, 159, 145, 362, 263):
        assert np.linalg.norm(fitted[i] - base[i]) < 0.1, i


# --- the validator -------------------------------------------------------------


def codes(problems) -> set[str]:
    return {p.code for p in problems}


def test_eyes_marked_the_wrong_way_round_are_refused():
    rig, base = template_rig()
    swapped = replace(line_marks("dog wide muzzle"), left_eye=RIGHT_EYE, right_eye=LEFT_EYE)
    assert "eyes_out_of_order" in codes(fit_rig(rig, base, swapped, "animal")[1])


def test_lids_upside_down_are_refused():
    rig, base = template_rig()
    e = LEFT_EYE
    upside_down = RegionMarks(e.left, e.right, e.bottom, e.top)
    flipped = replace(line_marks("cat small mouth"), left_eye=upside_down)
    assert "lids_inverted" in codes(fit_rig(rig, base, flipped, "animal")[1])


def test_a_reversed_mouth_is_refused():
    rig, base = template_rig()
    reversed_line = tuple(reversed(LAYOUTS["dog wide muzzle"]))
    marks = replace(line_marks("dog wide muzzle"), mouth_line=reversed_line)
    assert "mouth_reversed" in codes(fit_rig(rig, base, marks, "animal")[1])


def test_a_mouth_outside_the_head_is_refused():
    rig, base = template_rig()
    low = tuple((x, y + 400) for x, y in LAYOUTS["dog wide muzzle"])
    marks = replace(line_marks("dog wide muzzle"), mouth_line=low, chin=None)
    assert "outside_head" in codes(fit_rig(rig, base, marks, "animal")[1])


def test_a_mouth_dragged_through_an_eye_folds_and_says_how_much():
    rig, base = template_rig()
    through = ((330, 380), (415, 400), (500, 700), (585, 400), (670, 380))
    marks = replace(line_marks("dog wide muzzle"), mouth_line=through)
    problems = fit_rig(rig, base, marks, "animal")[1]
    folded = [p for p in problems if p.code == "folded_mesh"]
    assert folded and folded[0].count > 0
    assert str(folded[0].count) in folded[0].detail


def test_the_validator_passes_the_base_itself():
    _, base = template_rig()
    assert validate(base, base) == []
    _, human = human_rig()
    assert validate(human, human) == []


# --- the rig ---------------------------------------------------------------------


def test_the_fitted_rig_is_retriangulated_and_keeps_its_lip_rings():
    rig, base = human_rig()
    out, _ = fit_rig(rig, base, line_marks("dog wide muzzle"), "animal")
    triangles = np.array(out["triangles"])
    assert triangles.min() >= 0 and triangles.max() < 478
    for key in ("mouth_indices", "inner_lip_ring", "outer_lip_ring", "visemes"):
        assert out[key] == rig[key]
    xs = [p[0] for p in out["points"]]
    assert out["face_box"][0] == min(xs) and out["face_box"][2] == max(xs)


def test_only_an_animal_fit_carries_a_render_profile():
    rig, base = template_rig()
    animal, _ = fit_rig(rig, base, line_marks("cat small mouth"), "animal")
    assert animal["render_profile"] == "animal@1"
    # A line that no longer is an animal loses the muzzle mouth.
    cartoon, _ = fit_rig(animal, base, line_marks("cat small mouth"), "cartoon")
    assert "render_profile" not in cartoon


def test_stored_marks_are_the_owners():
    rig, base = template_rig()
    out, _ = fit_rig(rig, base, line_marks("cat small mouth"), "animal")
    assert out["user_anchors"]["source"] == "owner"
    assert len(out["user_anchors"]["mouth_line"]) == 5


@pytest.mark.parametrize("layout", LAYOUTS)
@pytest.mark.parametrize("on", ["template", "detected"])
def test_a_mouth_line_draws_its_inner_corner_at_both_ends(layout, on):
    """Each corner's four landmarks sit on one point and only one can be
    drawn. It is the inner corner on both sides, whatever the layout: the
    engine moves 78 and 308 on closed-mouth shapes, so a mixed pair moved
    one corner of the mouth and not the other."""
    rig, base = template_rig() if on == "template" else human_rig()
    out, _ = fit_rig(rig, base, line_marks(layout), "animal")
    drawn = set(np.array(out["triangles"]).ravel().tolist())
    assert drawn & set(LEFT_COMMISSURE) == {78}
    assert drawn & set(RIGHT_COMMISSURE) == {308}
    assert all(len(set(t)) == 3 for t in out["triangles"])


def test_a_human_fit_keeps_every_mouth_corner_landmark():
    rig, base = human_rig()
    out, _ = fit_rig(rig, base, marks_from_mesh(base, "human"), "human")
    drawn = set(np.array(out["triangles"]).ravel().tolist())
    assert set(LEFT_COMMISSURE + RIGHT_COMMISSURE) <= drawn


def test_the_embed_fixture_is_what_the_fit_makes():
    """embed's fitted-animal-rig.json is this fit's output for the "toon big
    grin" layout on a first-build animal rig; if the fit changes, regenerate
    it from this test's `rig` and `out`."""
    size = (1000, 1000)
    template = template_mesh(size)
    rig = build_rig(template, size, None, face_type="animal")
    base = fit_base_points(fit_base_record(template, rig, detected=False), rig)
    out, problems = fit_rig(rig, base, line_marks("toon big grin"), "animal")
    assert problems == []
    fixture = json.loads((FIXTURES / "fitted-animal-rig.json").read_text())
    assert fixture == json.loads(json.dumps(out))


# --- marks in every format ------------------------------------------------------


def test_an_animal_marked_before_mouth_lines_reads_as_a_line_without_pupils():
    legacy = json.loads((FIXTURES / "legacy-animal-rig.json").read_text())["user_anchors"]
    marks = marks_from_dict(legacy, "animal")
    assert marks.mouth is None and marks.left_pupil is None and marks.right_pupil is None
    m = legacy["mouth"]
    assert marks.mouth_line[0] == (m["left"]["x"], m["left"]["y"])
    assert marks.mouth_line[2] == (m["center"]["x"], m["center"]["y"])
    assert marks.mouth_line[4] == (m["right"]["x"], m["right"]["y"])
    assert marks.head.left == (legacy["head"]["left"]["x"], legacy["head"]["left"]["y"])


# The rings the panel this fit replaced measured an eye by: lids and iris.
OLD_LEFT_EYE = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246, *LEFT_IRIS]
OLD_RIGHT_EYE = [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466, *RIGHT_IRIS]


def old_panel_anchors(rig: dict) -> dict:
    """What the panel before this fit stored on every save: each region's
    BOUNDING-BOX extremes (the mouth's centre its box's centre), pupils as
    centre and mean radius, and no source."""
    points = np.array(rig["points"], dtype=float)

    def pt(i: int) -> dict:
        return {"x": float(points[i][0]), "y": float(points[i][1])}

    def region(indices, with_center=False) -> dict:
        idx = np.array(indices)
        xs, ys = points[idx, 0], points[idx, 1]
        out = {"left": pt(idx[xs.argmin()]), "right": pt(idx[xs.argmax()]),
               "top": pt(idx[ys.argmin()]), "bottom": pt(idx[ys.argmax()])}
        if with_center:
            out["center"] = {"x": (xs.min() + xs.max()) / 2, "y": (ys.min() + ys.max()) / 2}
        return out

    def pupil(ring) -> dict:
        r = max(np.mean([np.linalg.norm(points[j] - points[ring[0]]) for j in ring[1:]]), 2.0)
        return {"center": pt(ring[0]), "rim": {"x": points[ring[0]][0] + r, "y": points[ring[0]][1]}}

    return {
        "head": region(range(len(points))),
        "left_eye": region(OLD_LEFT_EYE),
        "right_eye": region(OLD_RIGHT_EYE),
        "mouth": region(rig["mouth_indices"], with_center=True),
        "left_pupil": pupil(LEFT_IRIS),
        "right_pupil": pupil(RIGHT_IRIS),
    }


@pytest.mark.parametrize("face_type", ["human", "cartoon"])
def test_a_detected_face_marked_by_the_old_panel_resaves_unchanged(face_type):
    """Its stored extremes are not landmark positions (the head's leftmost
    point is not 234); the rig's own landmarks are where the old fit put
    the face, so a re-save reads them and moves nothing it did not have to."""
    rig, base = human_rig()
    rig = {**rig, "user_anchors": old_panel_anchors(rig)}
    marks = saved_marks(rig, face_type, rig_on_base=True)
    out = np.array(fit_rig(rig, base, marks, face_type)[0]["points"])
    # A line's first save moves its lips onto the seam whatever was stored;
    # the old marks must add nothing to that.
    opened, _ = fit_rig(rig, base, marks_from_mesh(base, face_type), face_type)
    assert np.abs(out - np.array(opened["points"])).max() < 1.0
    if face_type == "human":
        assert np.abs(out - base).max() < 1.0


def test_the_old_panels_marks_on_the_synthetic_mesh_are_kept():
    """A rig built on the synthetic mesh numbers its landmarks differently
    from its base (the template); the saved marks are all there is."""
    rig, _ = human_rig()
    rig = {**rig, "user_anchors": old_panel_anchors(rig)}
    marks = saved_marks(rig, "human", rig_on_base=False)
    assert marks == marks_from_dict(rig["user_anchors"], "human")


def test_the_owners_marks_are_read_as_saved():
    rig, base = template_rig()
    out, _ = fit_rig(rig, base, line_marks("dog wide muzzle"), "animal")
    moved = {**out, "points": (np.array(out["points"]) + 5).tolist()}
    assert saved_marks(moved, "animal", rig_on_base=True) == line_marks("dog wide muzzle")
    assert saved_marks({**rig, "user_anchors": None}, "animal", rig_on_base=True) == FaceMarks()


def test_a_human_keeps_its_edges_and_drops_a_line():
    data = {"mouth_line": [{"x": i, "y": 1} for i in range(5)], "chin": {"x": 1, "y": 2}}
    marks = marks_from_dict(data, "human")
    assert marks.mouth_line is None and marks.chin is None


def test_marks_survive_a_round_trip():
    marks = replace(line_marks("toon big grin"), left_pupil=PupilMarks((390, 400), (402, 400)))
    assert marks_from_dict(marks_to_dict(marks), "cartoon") == marks


def test_newer_marks_win_region_by_region():
    older = line_marks("dog wide muzzle")
    newer = FaceMarks(mouth_line=LAYOUTS["cat small mouth"])
    merged = merge(older, newer)
    assert merged.mouth_line == LAYOUTS["cat small mouth"]
    assert merged.head == older.head


def test_marks_from_a_mesh_sit_on_their_landmarks():
    _, base = template_rig()
    marks = marks_from_mesh(base, "animal")
    assert marks.mouth_line[0] == pytest.approx(tuple(base[61]))
    assert marks.mouth_line[-1] == pytest.approx(tuple(base[291]))
    assert marks.chin == pytest.approx(tuple(base[152]))
    assert marks.left_pupil is None
    # The seam points run along the mouth, between its corners.
    xs = [p[0] for p in marks.mouth_line]
    assert xs == sorted(xs)


# --- the stored base ------------------------------------------------------------


def test_a_base_belongs_to_one_frame():
    rig, base = template_rig((400, 500))
    record = fit_base_record(base, rig, detected=False)
    assert fit_base_points(record, rig) == pytest.approx(base, abs=1e-3)
    assert fit_base_points(record, {**rig, "crop_origin": [10, 20]}) is None
    assert fit_base_points(record, {**rig, "image_size": [300, 500]}) is None


def test_a_moved_base_follows_its_cropped_rig():
    rig, base = template_rig((400, 500))
    record = fit_base_record(base, rig, detected=False)
    cropped = {**rig, "image_size": [300, 400], "crop_origin": [40, 60]}
    moved = move_fit_base(record, 40, 60, cropped)
    assert fit_base_points(moved, cropped) == pytest.approx(base - (40, 60), abs=1e-3)


def test_the_warp_is_the_identity_without_marks():
    _, base = human_rig()
    pairs = [(i, base[i]) for i in (10, 152, 234, 454)]
    assert np.abs(warp(base, pairs) - base).max() < 1e-6


def test_two_line_marks_on_the_same_pixel_do_not_crash_the_fit():
    """A double-click or a keyboard nudge can leave two neighbouring
    mouth-line points on one pixel. That segment has no direction; the fit
    must still run (it used to raise TypeError, a 500 for the owner)."""
    rig, base = template_rig()
    line = ((330, 700), (500, 715), (500, 715), (585, 712), (670, 700))
    marks = replace(line_marks("dog wide muzzle"), mouth_line=line)
    out, _problems = fit_rig(rig, base, marks, "animal")
    assert np.isfinite(np.array(out["points"], dtype=float)).all()
