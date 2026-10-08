"""The creation wizard's service modules, called directly (no HTTP): a
creation's steps and what follows from their lineage (creations.steps), the
checks an owner's request passes (creations.guards), what the row keeps of
a job and of the AI budget (creations.records), the detection's decisions
and the image it sends the point finder (creations.detect), and a touch-up
laid back over its photo (creations.finish).

Creations are built in memory: none of these read the database."""

from __future__ import annotations

import copy
import io

import pytest
from PIL import Image

from app.core.errors import Conflict409, Validation422
from app.models import Creation, CreationStatus
from app.schemas.creation import CreationMarks
from app.services import consent
from app.services.creations.detect import (
    MODEL,
    anchors_are_current,
    source_on_backdrop,
    vision_cache_hit,
    wants_ai_points,
)
from app.services.creations.finish import over_backdrop
from app.services.creations.guards import (
    anchors_for,
    check_marks,
    require_draft,
    require_face_type,
    require_image,
)
from app.services.creations.records import (
    NOT_RETRYABLE,
    ai_usage_of,
    error_record,
    job_record,
    retryable,
)
from app.services.creations.rules import CHECK_KEYS
from app.services.creations.steps import (
    adjusted_index,
    ai_edited_of,
    background_source,
    check_of,
    copied,
    current_step,
    cutout_id_for,
    drop_adjusted,
    drop_cutouts,
    frame_key,
    is_cut_out,
    is_cutout_id,
    lineage,
    ordered_step_ids,
    plan_of,
    recommendation_of,
    remove_steps,
    round_source,
    statement_for,
    step_check,
    step_items,
    stylised,
    through_cutouts,
)
from app.services.imagegen import SOURCE_MAX_EDGE
from app.services.jobs import DONE, FAILED, INTERRUPTED, QUEUED, RUNNING, Job
from app.services.photo_io import NEUTRAL_BACKDROP

# --- Builders -------------------------------------------------------------------------


def item(key: str, source: str | None = None, **extra) -> dict:
    return {"key": key, "width": 100, "height": 80, "from": source, **extra}


def adjust(mode: str, model: str | None) -> dict:
    return {
        "mode": mode,
        "style": None,
        "model": model,
        "generated_eyes": False,
        "rejected": None,
        "checks": {},
    }


def check(detected: bool = True, detector: str | None = "mediapipe", **extra) -> dict:
    return {
        "detector": detector,
        "detected": detected,
        "face_box": None,
        "roll": 0.0,
        "face_state": None,
        "checks": [],
        "recommendations": {},
        **extra,
    }


def wizard_steps(current: str | None = "framed") -> dict:
    """original → framed → cutout; adjusted:1, a stylise of the framed photo,
    and its own cut-out cutout:1; adjusted:2, a touch-up of the cut-out
    (transparent like it)."""
    return {
        "current": current,
        "items": {
            "original": item("k/original", check=check()),
            "framed": item("k/framed", "original", check=check()),
            "cutout": item("k/cutout", "framed"),
            "adjusted:1": item(
                "k/adjusted-1", "framed", adjust=adjust("stylise", "img-1"), check=check()
            ),
            "cutout:1": item("k/cutout-1", "adjusted:1"),
            "adjusted:2": item(
                "k/adjusted-2",
                "cutout",
                cutout=True,
                adjust=adjust("touchup", "img-2"),
                check=check(),
            ),
        },
    }


def creation(face_type: str | None = "human", steps: dict | None = None, **fields) -> Creation:
    fields.setdefault("status", CreationStatus.draft)
    return Creation(
        org_id="org-1", created_by_id="user-1", face_type=face_type, steps=steps, **fields
    )


# --- Reading the column ---------------------------------------------------------------


def test_plan_of_is_a_copy_of_the_plan_and_none_without_one():
    plan = {"model": "animal", "look": "cartoon", "source": "upload", "description": None}
    steps = {"current": None, "items": {}, "plan": plan}
    found = plan_of(steps)
    assert found == plan
    found["look"] = "realistic"
    assert plan["look"] == "cartoon"
    assert plan_of(None) is None
    assert plan_of({"current": None, "items": {}}) is None
    assert plan_of({"current": None, "items": {}, "plan": "animal"}) is None


def test_an_empty_or_missing_column_has_no_items_and_no_current_image():
    assert step_items(None) == {}
    assert step_items({"current": None}) == {}
    assert step_items({"current": None, "items": None}) == {}
    assert current_step(None) is None
    assert current_step({"items": {}}) is None
    assert current_step(wizard_steps("cutout:1")) == "cutout:1"


@pytest.mark.parametrize(
    ("step_id", "index"),
    [
        ("adjusted:3", 3),
        ("adjusted:12", 12),
        ("adjusted:007", 7),
        ("adjusted:", None),
        ("adjusted:x", None),
        ("adjusted:-1", None),
        ("adjusted", None),
        ("cutout:3", None),
        ("original", None),
    ],
)
def test_adjusted_index_reads_only_a_numbered_ai_result(step_id, index):
    assert adjusted_index(step_id) == index


@pytest.mark.parametrize(
    ("step_id", "expected"),
    [
        ("cutout", True),
        ("cutout:4", True),
        ("cutouts", False),
        ("framed", False),
        ("adjusted:1", False),
        ("", False),
        (None, False),
    ],
)
def test_a_cutout_id_is_the_cutout_or_the_cutout_of_an_ai_result(step_id, expected):
    assert is_cutout_id(step_id) is expected


def test_the_cutout_of_an_ai_result_is_numbered_like_it_and_any_other_is_the_cutout():
    assert cutout_id_for("original") == "cutout"
    assert cutout_id_for("framed") == "cutout"
    assert cutout_id_for("adjusted:5") == "cutout:5"


def test_a_touch_up_of_a_cutout_counts_as_cut_out_and_a_stylise_does_not():
    items = wizard_steps()["items"]
    assert is_cut_out(items, "cutout") is True
    assert is_cut_out(items, "cutout:1") is True
    assert is_cut_out(items, "adjusted:2") is True
    assert is_cut_out(items, "adjusted:1") is False
    assert is_cut_out(items, "framed") is False
    assert is_cut_out(items, None) is False
    # The id alone says so, even for a step no longer there.
    assert is_cut_out(items, "cutout:9") is True


def test_steps_are_ordered_with_each_ai_result_by_number_before_its_own_cutout():
    items = {
        step_id: item(f"k/{step_id}")
        for step_id in (
            "zzz",
            "cutout:10",
            "adjusted:10",
            "cutout:7",
            "adjusted:2",
            "cutout",
            "cutout:2",
            "adjusted:5",
            "framed",
            "original",
        )
    }
    # adjusted:5 has no cut-out; cutout:7's AI result is gone: it still shows,
    # with what is unknown, last.
    assert ordered_step_ids(items) == [
        "original",
        "framed",
        "cutout",
        "adjusted:2",
        "cutout:2",
        "adjusted:5",
        "adjusted:10",
        "cutout:10",
        "cutout:7",
        "zzz",
    ]
    assert ordered_step_ids({}) == []


# --- Removing steps ---------------------------------------------------------------------


def test_survivors_of_a_removal_name_their_nearest_surviving_ancestor():
    steps = wizard_steps("cutout:1")
    keys = remove_steps(steps, {"framed", "cutout"})
    assert keys == ["k/cutout", "k/framed"]
    items = steps["items"]
    assert set(items) == {"original", "adjusted:1", "cutout:1", "adjusted:2"}
    # Each one's lineage stays walkable, through two removed steps for adjusted:2.
    assert items["adjusted:1"]["from"] == "original"
    assert items["adjusted:2"]["from"] == "original"
    assert items["cutout:1"]["from"] == "adjusted:1"
    assert steps["current"] == "cutout:1"


@pytest.mark.parametrize(
    ("current", "doomed", "handed_to"),
    [
        ("cutout:1", {"cutout:1", "adjusted:1"}, "framed"),
        ("adjusted:2", {"adjusted:2", "cutout"}, "framed"),
        ("cutout", {"cutout", "framed"}, "original"),
    ],
)
def test_a_removed_current_image_hands_over_to_its_nearest_surviving_ancestor(
    current, doomed, handed_to
):
    steps = wizard_steps(current)
    remove_steps(steps, doomed)
    assert steps["current"] == handed_to


def test_a_removed_current_image_with_no_surviving_ancestor_falls_back_to_the_original():
    steps = {
        "current": "cutout",
        "items": {"original": item("k/original"), "cutout": item("k/cutout", "gone")},
    }
    assert remove_steps(steps, {"cutout"}) == ["k/cutout"]
    assert steps == {"current": "original", "items": {"original": item("k/original")}}


def test_removing_steps_that_do_not_exist_changes_nothing():
    steps = wizard_steps("adjusted:2")
    before = copy.deepcopy(steps)
    assert remove_steps(steps, {"adjusted:9", "cutout:9"}) == []
    assert remove_steps(steps, set()) == []
    assert steps == before
    # A real step among unknown ones: only its key comes back.
    assert remove_steps(steps, {"cutout:1", "adjusted:9"}) == ["k/cutout-1"]


def test_removing_a_cycle_of_steps_ends_and_returns_their_keys():
    steps = {
        "current": "original",
        "items": {
            "original": item("k/original"),
            "a": item("k/a", "b"),
            "b": item("k/b", "a"),
        },
    }
    assert remove_steps(steps, {"a", "b"}) == ["k/a", "k/b"]
    assert steps == {"current": "original", "items": {"original": item("k/original")}}


def test_a_cycle_of_removed_steps_leaves_no_reference_to_them():
    steps = {
        "current": "a",
        "items": {
            "original": item("k/original"),
            "a": item("k/a", "b"),
            "b": item("k/b", "a"),
            "c": item("k/c", "a"),
        },
    }
    assert remove_steps(steps, {"a", "b"}) == ["k/a", "k/b"]
    # Nothing of the cycle survives: the original takes over, c has no ancestor left.
    assert steps["current"] == "original"
    assert steps["items"]["c"]["from"] is None


def test_dropping_the_ai_results_takes_their_cutouts_and_leaves_the_photo_line():
    steps = wizard_steps("adjusted:2")
    assert drop_adjusted(steps) == ["k/adjusted-1", "k/adjusted-2", "k/cutout-1"]
    assert set(steps["items"]) == {"original", "framed", "cutout"}
    # adjusted:2 was made from the cut-out, which stays.
    assert steps["current"] == "cutout"


def test_dropping_the_cutouts_takes_a_touch_up_of_one_and_keeps_an_ai_result_made_from_one():
    steps = wizard_steps("adjusted:2")
    steps["items"]["adjusted:3"] = item(
        "k/adjusted-3", "cutout", adjust=adjust("regenerate", "img-3")
    )
    assert drop_cutouts(steps) == ["k/adjusted-2", "k/cutout", "k/cutout-1"]
    items = steps["items"]
    assert set(items) == {"original", "framed", "adjusted:1", "adjusted:3"}
    assert items["adjusted:3"]["from"] == "framed"
    assert steps["current"] == "framed"


# --- Lineage --------------------------------------------------------------------------


def test_lineage_is_newest_first_and_empty_for_an_unknown_step():
    steps = wizard_steps()
    items = steps["items"]
    assert lineage(steps, "cutout:1") == [
        items["cutout:1"],
        items["adjusted:1"],
        items["framed"],
        items["original"],
    ]
    assert lineage(steps, "original") == [items["original"]]
    assert lineage(steps, "adjusted:9") == []
    assert lineage(steps, None) == []
    assert lineage(None, "original") == []


def test_lineage_through_a_cycle_visits_each_step_once():
    steps = {"current": "a", "items": {"a": item("k/a", "b"), "b": item("k/b", "a")}}
    assert [i["key"] for i in lineage(steps, "a")] == ["k/a", "k/b"]


def test_the_latest_adjust_in_the_lineage_names_the_ai_edit():
    steps = wizard_steps()
    steps["items"]["adjusted:3"] = item(
        "k/adjusted-3", "adjusted:1", adjust=adjust("touchup", "img-3")
    )
    assert ai_edited_of(steps, "adjusted:3") == {"mode": "touchup", "model": "img-3"}
    # A cut-out is not an AI edit: it shows the stylise it was cut from.
    assert ai_edited_of(steps, "cutout:1") == {"mode": "stylise", "model": "img-1"}
    del steps["items"]["adjusted:1"]["adjust"]["model"]
    assert ai_edited_of(steps, "adjusted:1") == {"mode": "stylise", "model": None}


def test_a_generated_original_is_an_ai_edit_and_an_upload_is_not():
    steps = wizard_steps()
    assert ai_edited_of(steps, "cutout") is None
    assert ai_edited_of(steps, "original") is None
    assert ai_edited_of(None, None) is None
    steps["items"]["original"]["generated"] = {
        "model": "gen-1",
        "style": "photo",
        "source_avatar_id": None,
    }
    assert ai_edited_of(steps, "cutout") == {"mode": "generate", "model": "gen-1"}


def test_a_stylised_image_and_anything_made_from_it_is_stylised():
    steps = wizard_steps()
    assert stylised(steps, "adjusted:1") is True
    assert stylised(steps, "cutout:1") is True
    assert stylised(steps, "adjusted:2") is False
    assert stylised(steps, "framed") is False
    assert stylised(steps, None) is False


# --- The statement finishing asks for -----------------------------------------------------


def generated(
    face_type: str | None,
    plan: dict | None = None,
    found: dict | None = None,
    source_avatar_id: str | None = None,
) -> Creation:
    """A picture the image model made, framed and cut out; `found` is the
    photo check of the generated original."""
    original = item(
        "k/original",
        generated={"model": "gen-1", "style": "photo", "source_avatar_id": source_avatar_id},
        check=found if found is not None else check(detected=False),
    )
    steps = {
        "current": "cutout",
        "items": {
            "original": original,
            "framed": item("k/framed", "original"),
            "cutout": item("k/cutout", "framed"),
        },
    }
    if plan is not None:
        steps["plan"] = plan
    return creation(face_type, steps)


def plan(model: str, look: str, source: str = "generate") -> dict:
    return {"model": model, "look": look, "source": source, "description": "a face"}


@pytest.mark.parametrize(("face_type", "statement"), [("human", "depiction"), ("animal", None)])
def test_a_creation_with_no_image_needs_the_depiction_on_the_human_line_only(face_type, statement):
    assert statement_for(creation(face_type, None)) == statement
    assert statement_for(creation(face_type, {"current": None, "items": {}})) == statement
    assert statement_for(creation(None, None)) is None


def test_a_generated_person_needs_the_generated_face_statement():
    assert statement_for(generated("human")) == consent.GENERATED_FACE == "generated_face"


def test_a_picture_redrawn_from_one_of_the_orgs_avatars_needs_the_depiction():
    made = generated("human", source_avatar_id="avatar-1")
    assert statement_for(made) == consent.DEPICTION == "depiction"


@pytest.mark.parametrize(
    ("face_type", "made_plan", "source_avatar_id", "statement"),
    [
        ("cartoon", None, None, "generated_face"),
        ("cartoon", None, "avatar-1", "depiction"),
        ("cartoon", plan("human", "cartoon"), None, "generated_face"),
        ("animal", plan("animal", "realistic"), None, "generated_face"),
        ("cartoon", plan("animal", "animation"), None, None),
        ("cartoon", plan("animal", "cartoon"), None, None),
        ("animal", plan("animal", "cartoon"), None, None),
        # A drawn animal put on the human line is still a person's line.
        ("human", plan("animal", "animation"), None, "generated_face"),
    ],
)
def test_a_generated_face_the_detector_found_needs_a_statement_unless_it_is_a_drawn_animal(
    face_type, made_plan, source_avatar_id, statement
):
    made = generated(face_type, made_plan, check(detected=True), source_avatar_id)
    assert statement_for(made) == statement


@pytest.mark.parametrize(
    "found",
    [check(detected=False), check(detected=True, detector=None), {}],
    ids=["nothing-found", "not-mediapipe", "no-check"],
)
def test_a_generated_picture_off_the_human_line_without_a_person_found_needs_nothing(found):
    assert statement_for(generated("animal", plan("animal", "realistic"), found)) is None


def test_an_upload_on_the_human_line_needs_the_depiction_whatever_the_check_found():
    steps = wizard_steps("cutout")
    for step in steps["items"].values():
        step["check"] = check(detected=False)
    assert statement_for(creation("human", steps)) == "depiction"


@pytest.mark.parametrize("found_on", ["original", "framed"])
def test_an_upload_the_check_read_as_a_person_needs_the_depiction_on_any_line(found_on):
    """Someone may pick Animal and upload a real person."""
    steps = wizard_steps("cutout")
    for step in steps["items"].values():
        step["check"] = check(detected=False)
    steps["items"][found_on]["check"] = check(detected=True)
    assert statement_for(creation("animal", steps)) == "depiction"


def test_a_face_found_only_on_an_ai_result_does_not_make_an_upload_a_depiction():
    steps = wizard_steps("cutout:1")
    for step in steps["items"].values():
        step["check"] = check(detected=False)
    steps["items"]["adjusted:1"]["check"] = check(detected=True)
    made = creation("cartoon", steps, analysis={"suggested_face_type": "human"})
    # The checks kept per step speak; the upload's analysis is not asked.
    assert statement_for(made) is None


@pytest.mark.parametrize(
    ("analysis", "statement"),
    [
        ({"suggested_face_type": "human"}, "depiction"),
        ({"suggested_face_type": None}, None),
        (None, None),
    ],
)
def test_a_draft_made_before_checks_were_kept_per_step_falls_back_to_the_analysis(
    analysis, statement
):
    steps = {
        "current": "cutout",
        "items": {
            "original": item("k/original"),
            "framed": item("k/framed", "original", check=None),
            "cutout": item("k/cutout", "framed"),
        },
    }
    assert statement_for(creation("animal", steps, analysis=analysis)) == statement


def test_a_drawing_the_check_does_not_read_as_a_face_needs_nothing():
    steps = wizard_steps("framed")
    for step in steps["items"].values():
        step["check"] = check(detected=False)
    assert statement_for(creation("cartoon", steps)) is None


# --- Where an adjust round comes from ------------------------------------------------------


def adjust_round(source: str | None, *candidates: str | None) -> dict:
    return {
        "mode": "touchup",
        "style": None,
        "source": source,
        "limit_reached": False,
        "candidates": [
            {"step": c, "ok": c is not None, "reason": None, "generated_eyes": False}
            for c in candidates
        ],
    }


def test_a_round_comes_from_its_recorded_source_while_that_step_exists():
    steps = wizard_steps()
    assert round_source(steps, adjust_round("cutout", "adjusted:2")) == "cutout"
    assert round_source(steps, None) is None
    assert round_source(steps, {}) is None


def test_a_round_whose_source_was_dropped_comes_from_where_its_candidates_now_point():
    """Choosing a stylised version drops the cut-outs; a round made from
    the cut-out now comes from the photo it was cut from."""
    steps = wizard_steps("adjusted:1")
    steps["items"]["adjusted:3"] = item(
        "k/adjusted-3", "cutout", adjust=adjust("regenerate", "img-3")
    )
    last = adjust_round("cutout", None, "adjusted:9", "adjusted:3")
    drop_cutouts(steps)
    # A failed candidate (no step) and one no longer there are passed over.
    assert round_source(steps, last) == "framed"


def test_a_round_with_nothing_left_comes_from_the_original_or_from_nothing():
    steps = wizard_steps()
    assert round_source(steps, adjust_round("gone", None, "adjusted:9")) == "original"
    del steps["items"]["original"]
    assert round_source(steps, adjust_round("gone")) is None
    assert round_source(None, adjust_round("gone")) is None


# --- The pixels a step shows ------------------------------------------------------------


@pytest.mark.parametrize(
    ("step_id", "source"),
    [
        ("cutout", "framed"),
        ("cutout:1", "adjusted:1"),
        ("framed", "framed"),
        # A touch-up of a cut-out was redrawn by the model: it is its own image.
        ("adjusted:2", "adjusted:2"),
        ("adjusted:9", None),
        (None, None),
    ],
)
def test_through_cutouts_reaches_the_image_whose_pixels_a_step_shows(step_id, source):
    assert through_cutouts(wizard_steps(), step_id) == source


def test_a_cutout_whose_source_is_gone_shows_its_own_pixels():
    steps = {"current": "cutout", "items": {"cutout": item("k/cutout", "gone")}}
    assert through_cutouts(steps, "cutout") == "cutout"
    assert frame_key(steps, "cutout") == "k/cutout"


def test_a_cycle_of_cutouts_ends():
    steps = {
        "current": "cutout",
        "items": {"cutout": item("k/c", "cutout:1"), "cutout:1": item("k/c1", "cutout")},
    }
    assert through_cutouts(steps, "cutout") == "cutout"


def test_a_cutout_shares_its_sources_frame_and_an_ai_result_has_its_own():
    steps = wizard_steps()
    assert frame_key(steps, "cutout") == "k/framed"
    assert frame_key(steps, "framed") == "k/framed"
    assert frame_key(steps, "cutout:1") == "k/adjusted-1"
    assert frame_key(steps, "adjusted:2") == "k/adjusted-2"
    assert frame_key(steps, "adjusted:9") is None
    assert frame_key(None, None) is None


def test_a_cutout_has_its_sources_photo_check():
    steps = wizard_steps()
    steps["items"]["framed"]["check"] = check(roll=4.0)
    assert check_of(steps, "cutout") == check(roll=4.0)
    del steps["items"]["original"]["check"]
    assert check_of(steps, "original") is None
    assert check_of(steps, "adjusted:9") is None


@pytest.mark.parametrize(
    ("current", "behind"),
    [
        ("framed", "framed"),
        ("adjusted:1", "adjusted:1"),
        ("cutout", "framed"),
        ("cutout:1", "adjusted:1"),
        # A touch-up of a cut-out: back through the cut-out to the photo.
        ("adjusted:2", "framed"),
    ],
)
def test_the_background_source_is_the_opaque_image_behind_the_current_one(current, behind):
    assert background_source(wizard_steps(current)) == behind


def test_the_background_source_of_a_cutout_whose_source_is_gone_is_the_cutout():
    steps = {"current": "cutout", "items": {"cutout": item("k/cutout", "gone")}}
    assert background_source(steps) == "cutout"
    assert background_source(None) is None
    assert background_source({"current": None, "items": {}}) is None


# --- Copies, checks and recommendations -------------------------------------------------


def test_copied_is_a_deep_copy_to_edit_and_an_empty_column_for_none():
    steps = wizard_steps()
    edited = copied(steps)
    assert edited == steps
    edited["items"]["framed"]["key"] = "k/other"
    edited["items"]["framed"]["check"]["detected"] = False
    edited["current"] = "cutout"
    assert steps == wizard_steps()
    assert copied(None) == {"current": None, "items": {}}
    first = copied(None)
    first["items"]["x"] = item("k/x")
    assert copied(None) == {"current": None, "items": {}}


def test_a_step_keeps_only_the_check_keys_of_an_analysis():
    analysis = {
        "image_size": [640, 480],
        "detector": "mediapipe",
        "detected": True,
        "face_box": [1.0, 2.0, 3.0, 4.0],
        "roll": 2.5,
        "checks": [{"code": "blurry"}],
        "suggested_face_type": "human",
        "suggested_framing": None,
    }
    assert step_check(analysis) == {
        "detector": "mediapipe",
        "detected": True,
        "face_box": [1.0, 2.0, 3.0, 4.0],
        "roll": 2.5,
        "face_state": None,
        "checks": [{"code": "blurry"}],
        "recommendations": None,
    }
    assert tuple(step_check({})) == CHECK_KEYS


def test_there_is_no_recommendation_without_a_line_or_a_check():
    steps = wizard_steps("framed")
    assert recommendation_of(steps, None) is None
    del steps["items"]["framed"]["check"]
    assert recommendation_of(steps, "human") is None
    assert recommendation_of(None, "human") is None


def test_the_recommendation_stored_for_the_line_is_read_and_its_reasons_copied():
    steps = wizard_steps("cutout")
    reasons = ["eyes_closed"]
    steps["items"]["framed"]["check"] = check(
        recommendations={
            "human": {"mode": "touchup", "reasons": reasons},
            "cartoon": {"mode": "none", "reasons": []},
        }
    )
    found = recommendation_of(steps, "human")
    # The image is the current one, the cut-out; its check is the photo's.
    assert found == {"image": "cutout", "mode": "touchup", "reasons": ["eyes_closed"]}
    assert found["reasons"] is not reasons
    assert recommendation_of(steps, "cartoon") == {"image": "cutout", "mode": "none", "reasons": []}


def test_a_recommendation_the_check_did_not_store_is_worked_out_from_it():
    steps = wizard_steps("framed")
    steps["items"]["framed"]["check"] = check(
        checks=[
            {"code": "eyes_closed", "detail": "closed"},
            {"code": "blurry", "detail": "soft"},
        ]
    )
    assert recommendation_of(steps, "human") == {
        "image": "framed",
        "mode": "regenerate",
        "reasons": ["blurry", "eyes_closed"],
    }
    steps["items"]["framed"]["check"] = check(detector=None)
    assert recommendation_of(steps, "cartoon") == {"image": "framed", "mode": "none", "reasons": []}


# --- Guards -----------------------------------------------------------------------------


@pytest.mark.parametrize(
    "status", [CreationStatus.finishing, CreationStatus.finished, CreationStatus.expired]
)
def test_only_a_draft_may_change(status):
    with pytest.raises(Conflict409) as refused:
        require_draft(creation(status=status))
    assert refused.value.code == "creation_not_draft"
    assert refused.value.detail == f"This creation is {status.value} and can no longer change"
    assert require_draft(creation(status=CreationStatus.draft)) is None


@pytest.mark.parametrize(
    "steps",
    [None, {"current": None, "items": {}}, {"current": "framed", "items": {"framed": {}}}],
    ids=["no-steps", "no-items", "no-original"],
)
def test_a_creation_without_its_original_is_not_ready(steps):
    with pytest.raises(Conflict409) as refused:
        require_image(creation(steps=steps))
    assert refused.value.code == "creation_not_ready"


def test_a_creation_with_its_original_is_ready():
    assert require_image(creation(steps=wizard_steps())) is None


def test_the_line_must_be_chosen_first():
    with pytest.raises(Validation422) as refused:
        require_face_type(creation(None))
    assert refused.value.code == "face_type_required"
    assert require_face_type(creation("cartoon")) == "cartoon"


def region(x: float, y: float, **extra) -> dict:
    return {
        "left": {"x": x - 10, "y": y},
        "right": {"x": x + 10, "y": y},
        "top": {"x": x, "y": y - 5},
        "bottom": {"x": x, "y": y + 5},
        **extra,
    }


LINE = [{"x": 30.0 + 5 * i, "y": 60.0} for i in range(5)]


def test_no_marks_are_none():
    assert check_marks(None, "human", [100, 80]) is None


@pytest.mark.parametrize(
    "marks", [{"mouth_line": LINE}, {"chin": {"x": 50, "y": 70}}], ids=["mouth_line", "chin"]
)
def test_a_mouth_line_or_a_chin_is_refused_on_the_human_line(marks):
    with pytest.raises(Validation422) as refused:
        check_marks(CreationMarks.model_validate(marks), "human", [100, 80])
    assert refused.value.code == "mouth_line_not_for_face_type"


def test_the_line_refusal_comes_before_the_image_bounds():
    marks = CreationMarks.model_validate({"chin": {"x": 500, "y": 700}})
    with pytest.raises(Validation422) as refused:
        check_marks(marks, "human", [100, 80])
    assert refused.value.code == "mouth_line_not_for_face_type"


@pytest.mark.parametrize("face_type", ["animal", "cartoon"])
def test_a_mouth_line_and_chin_are_the_marks_of_animals_and_animations(face_type):
    marks = CreationMarks.model_validate(
        {"head": region(50, 40), "mouth_line": LINE, "chin": {"x": 50, "y": 70}}
    )
    # What was not marked (the other regions, the head's diagonals) is left out.
    assert check_marks(marks, face_type, [100, 80]) == {
        "head": region(50, 40),
        "mouth_line": LINE,
        "chin": {"x": 50, "y": 70},
    }


def test_marks_on_the_edge_of_the_image_are_inside_it():
    marks = CreationMarks.model_validate(
        {"left_pupil": {"center": {"x": 0, "y": 0}, "rim": {"x": 100, "y": 80}}}
    )
    assert check_marks(marks, "human", [100, 80]) == {
        "left_pupil": {"center": {"x": 0.0, "y": 0.0}, "rim": {"x": 100.0, "y": 80.0}}
    }


@pytest.mark.parametrize(
    "marks",
    [
        {"head": region(95, 40)},
        {"head": region(50, 40, upper_left={"x": 20, "y": 81})},
        {"right_pupil": {"center": {"x": 50, "y": 40}, "rim": {"x": 52, "y": -0.5}}},
        {"mouth_line": [*LINE[:4], {"x": 101, "y": 60}]},
    ],
    ids=["region", "head-diagonal", "pupil-rim", "mouth-line"],
)
def test_a_mark_outside_the_image_is_refused_wherever_it_is_nested(marks):
    with pytest.raises(Validation422) as refused:
        check_marks(CreationMarks.model_validate(marks), "cartoon", [100, 80])
    assert refused.value.code == "mark_outside_image"


def anchored(current: str, **anchors) -> Creation:
    found = {"id": "anchors-1", "frame": "k/framed", "face_type": "human", **anchors}
    return creation("human", wizard_steps(current), anchors=found)


def test_the_anchors_named_on_the_current_image_are_returned():
    made = anchored("framed")
    assert anchors_for(made, "anchors-1") is made.anchors
    assert anchors_are_current(made) is True


def test_anchors_stay_current_on_a_cutout_of_their_frame():
    """No pixel moves when the background comes off."""
    made = anchored("cutout")
    assert anchors_for(made, "anchors-1") is made.anchors


@pytest.mark.parametrize(
    ("made", "anchors_id"),
    [
        (creation("human", wizard_steps("framed")), "anchors-1"),
        (anchored("framed"), "anchors-0"),
        (anchored("framed", face_type="cartoon"), "anchors-1"),
        # A touch-up of the cut-out was redrawn: another frame.
        (anchored("adjusted:2"), "anchors-1"),
        (anchored("cutout:1"), "anchors-1"),
    ],
    ids=["no-anchors", "other-id", "other-line", "touch-up", "ai-result-cutout"],
)
def test_anchors_named_wrongly_or_of_another_image_are_stale(made, anchors_id):
    with pytest.raises(Conflict409) as refused:
        anchors_for(made, anchors_id)
    assert refused.value.code == "anchors_stale"


# --- Job records and the AI budget ----------------------------------------------------------


def test_an_error_record_is_a_code_and_a_detail():
    assert error_record("fit_invalid", "bad marks") == {
        "code": "fit_invalid",
        "detail": "bad marks",
    }


@pytest.mark.parametrize("state", [FAILED, INTERRUPTED])
@pytest.mark.parametrize(
    "error", [None, {"code": "superseded", "detail": "changed"}, {"code": "provider_error"}]
)
def test_a_failed_or_interrupted_job_may_be_retried(state, error):
    assert retryable({"state": state, "error": error}) is True


@pytest.mark.parametrize("code", sorted(NOT_RETRYABLE))
def test_a_job_that_would_fail_the_same_way_again_is_not_retryable(code):
    for state in (FAILED, INTERRUPTED):
        assert retryable({"state": state, "error": {"code": code, "detail": "x"}}) is False


@pytest.mark.parametrize("state", [QUEUED, RUNNING, DONE])
def test_a_job_that_did_not_fail_is_not_retryable(state):
    assert retryable({"state": state, "error": None}) is False


def test_a_job_record_keeps_the_retry_params_until_the_job_is_done():
    job = Job(
        id="job-1",
        org_id="org-1",
        subject_id="creation-1",
        step="detect",
        revision=3,
        started_at="2026-10-08T09:00:00+00:00",
    )
    failure = error_record("provider_error", "down")
    assert job_record(job, FAILED, None, failure) == {
        "id": "job-1",
        "step": "detect",
        "state": "failed",
        "error": failure,
        "started_at": "2026-10-08T09:00:00+00:00",
        "params": {},
    }
    assert job_record(job, RUNNING, {"use_ai": True})["params"] == {"use_ai": True}
    assert job_record(job, DONE, {"use_ai": True}) == {
        "id": "job-1",
        "step": "detect",
        "state": "done",
        "error": None,
        "started_at": "2026-10-08T09:00:00+00:00",
    }


EMPTY_USAGE = {
    "adjust_rounds": 0,
    "detections": 0,
    "next_adjusted": 0,
    "vision_cache": [],
    "prepare_rounds": 0,
    "free_clears": 0,
}


@pytest.mark.parametrize("stored", [None, {}])
def test_the_ai_usage_of_a_row_without_one_has_every_counter_at_zero(stored):
    assert ai_usage_of(creation(ai_usage=stored)) == EMPTY_USAGE


def test_the_ai_usage_keeps_what_the_row_has_and_is_a_copy():
    entry = {"sha256": "abc", "face_type": "animal", "model": MODEL, "points": {"nose": [1, 2]}}
    last_round = adjust_round("framed", "adjusted:1")
    stored = {"adjust_rounds": 2, "vision_cache": [entry], "last_round": last_round}
    made = creation(ai_usage=stored)
    usage = ai_usage_of(made)
    assert usage == {
        **EMPTY_USAGE,
        "adjust_rounds": 2,
        "vision_cache": [entry],
        "last_round": last_round,
    }
    usage["vision_cache"][0]["points"]["nose"] = [9, 9]
    usage["vision_cache"].append(entry)
    usage["detections"] = 1
    assert made.ai_usage == {
        "adjust_rounds": 2,
        "vision_cache": [entry],
        "last_round": last_round,
    }
    assert entry["points"] == {"nose": [1, 2]}


# --- Detection's decisions -----------------------------------------------------------------


def test_a_cached_answer_is_used_only_for_the_same_pixels_line_and_model():
    points = {"nose": [0.5, 0.5]}
    usage = {
        **EMPTY_USAGE,
        "vision_cache": [
            {"sha256": "old", "face_type": "animal", "model": MODEL, "points": {"nose": [0, 0]}},
            {"sha256": "abc", "face_type": "animal", "model": "older-model", "points": {}},
            {"sha256": "abc", "face_type": "animal", "model": MODEL, "points": points},
        ],
    }
    assert vision_cache_hit(usage, "abc", "animal") is points
    assert vision_cache_hit(usage, "abc", "cartoon") is None
    assert vision_cache_hit(usage, "other", "animal") is None
    assert vision_cache_hit(EMPTY_USAGE, "abc", "animal") is None
    assert vision_cache_hit({"vision_cache": None}, "abc", "animal") is None


@pytest.mark.parametrize(
    ("face_type", "detected", "wanted"),
    [
        ("animal", False, True),
        ("animal", True, True),
        ("cartoon", False, True),
        ("cartoon", True, False),
        ("human", False, False),
        ("human", True, False),
    ],
)
def test_the_point_finder_is_asked_for_animals_and_for_animations_mediapipe_missed(
    face_type, detected, wanted
):
    assert wants_ai_points(face_type, detected) is wanted


def png(image: Image.Image) -> bytes:
    out = io.BytesIO()
    image.save(out, format="PNG")
    return out.getvalue()


def test_a_cutout_is_sent_to_the_model_on_the_neutral_grey_as_jpeg():
    """Never the black under alpha 0, nor the background that was removed."""
    cut = Image.new("RGBA", (64, 32), (0, 0, 0, 0))
    cut.paste((200, 30, 30, 255), (32, 0, 64, 32))
    data, mime = source_on_backdrop(png(cut))
    assert mime == "image/jpeg"
    with Image.open(io.BytesIO(data)) as sent:
        assert (sent.format, sent.mode, sent.size) == ("JPEG", "RGB", (64, 32))
        backdrop = sent.getpixel((8, 16))
        subject = sent.getpixel((56, 16))
    assert all(abs(c - n) <= 3 for c, n in zip(backdrop, NEUTRAL_BACKDROP))
    assert all(abs(c - n) <= 6 for c, n in zip(subject, (200, 30, 30)))


def test_a_large_image_is_shrunk_to_the_models_edge_before_it_is_sent():
    data, _ = source_on_backdrop(png(Image.new("RGB", (SOURCE_MAX_EDGE * 2, 600), "white")))
    with Image.open(io.BytesIO(data)) as sent:
        assert sent.size == (SOURCE_MAX_EDGE, 300)


# --- A touch-up laid back over its photo ----------------------------------------------------


def test_a_cutout_over_its_backdrop_is_an_opaque_merge_of_the_two():
    top = Image.new("RGBA", (3, 1))
    top.putdata([(255, 0, 0, 0), (0, 255, 0, 255), (0, 255, 0, 128)])
    below = Image.new("RGB", (3, 1), (0, 0, 255))
    merged = over_backdrop(png(top), png(below))
    assert merged is not None
    with Image.open(io.BytesIO(merged)) as image:
        assert image.format == "PNG"
        assert image.mode == "RGB"
        clear, solid, half = (image.getpixel((x, 0)) for x in range(3))
    # Under alpha 0 the backdrop shows, never the colour the cut-out kept there.
    assert clear == (0, 0, 255)
    assert solid == (0, 255, 0)
    assert half[0] == 0 and abs(half[1] - 128) <= 1 and abs(half[2] - 127) <= 1


def test_a_cutout_and_a_backdrop_of_different_sizes_are_not_merged():
    top = png(Image.new("RGBA", (4, 4), (0, 255, 0, 255)))
    below = png(Image.new("RGB", (4, 5), (0, 0, 255)))
    assert over_backdrop(top, below) is None
