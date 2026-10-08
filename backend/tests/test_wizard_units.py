"""The four-step wizard's decisions, called directly (no HTTP):
services.wizard.plan (the line, the plan, the default name),
services.wizard.versions (going back to a picture step 3 made),
services.wizard.prepare (the cut-out, the refunds, and settle: the cut-out
made current and the face found on it) and services.wizard.prompts.

No model, segmenter or keyer runs: each is replaced where prepare looks it
up, and the CPU thread is run inline.
"""

from __future__ import annotations

import copy
import hashlib
import logging

import pytest

from app.core.errors import Conflict409, Validation422
from app.models import Creation
from app.services import backdrop, segment
from app.services import creations as svc
from app.services.creations import detect
from app.services.jobs import Job
from app.services.wizard import prepare, prompts
from app.services.wizard.plan import (
    KEPT_ANCHORS,
    KEPT_RECORD,
    LOOKS,
    MAX_WORDS,
    MODELS,
    NAME_MAX,
    default_name,
    inferred_plan,
    line_for,
    make_plan,
    name_of,
    technical_file_name,
)
from app.services.wizard.versions import use_version, version_of

# --- plan: the line --------------------------------------------------------------------


@pytest.mark.parametrize(
    ("model", "look", "line"),
    [
        ("human", "realistic", "human"),
        ("animal", "realistic", "animal"),
        ("human", "animation", "cartoon"),
        ("animal", "animation", "cartoon"),
        ("human", "cartoon", "cartoon"),
        ("animal", "cartoon", "cartoon"),
        # Anything that is not an animal is rigged as a person when realistic.
        ("robot", "realistic", "human"),
    ],
)
def test_each_model_and_look_is_rigged_on_its_line(model, look, line):
    assert line_for(model, look) == line


# --- plan: make_plan and inferred_plan -------------------------------------------------


def test_a_plan_is_exactly_its_four_fields_with_the_description_trimmed():
    assert make_plan("animal", "cartoon", "generate", "  a fox in a scarf \n") == {
        "model": "animal",
        "look": "cartoon",
        "source": "generate",
        "description": "a fox in a scarf",
    }


def test_a_plans_description_is_cut_at_max_words_characters_after_trimming():
    """Trimmed first: leading blanks do not eat into the allowance."""
    words = "   " + "x" * (MAX_WORDS + 50)
    description = make_plan("human", "realistic", "generate", words)["description"]
    assert description == "x" * MAX_WORDS


@pytest.mark.parametrize("args", [(), ("",), ("   ",), ("\n\t ",)])
def test_a_plan_without_words_has_no_description(args):
    assert make_plan("human", "realistic", "upload", *args)["description"] is None


@pytest.mark.parametrize(
    ("face_type", "generated", "expected"),
    [
        (None, False, ("human", "realistic", "upload")),
        ("human", False, ("human", "realistic", "upload")),
        ("animal", False, ("animal", "realistic", "upload")),
        ("cartoon", False, ("human", "cartoon", "upload")),
        ("animal", True, ("animal", "realistic", "generate")),
        ("cartoon", True, ("human", "cartoon", "generate")),
    ],
)
def test_an_old_drafts_plan_is_read_off_its_line(face_type, generated, expected):
    model, look, source = expected
    assert inferred_plan(face_type, generated) == {
        "model": model,
        "look": look,
        "source": source,
        "description": None,
    }


# --- plan: technical_file_name ---------------------------------------------------------


@pytest.mark.parametrize(
    "stem",
    [
        "",  # fewer than two letters
        "p",
        "x-",
        "IMG_1234",  # a camera's word and digits
        "Screenshot",  # one of the technical words, whatever its case
        "maria copy",  # a technical word among the owner's
        "WhatsApp Image",
        "maria2",  # a digit anywhere
        "a-b-c",  # a slug: separators are a third or more of it
        "a-b",  # exactly a third
        "x.y.z",
    ],
)
def test_a_cameras_or_an_apps_file_name_is_technical(stem):
    assert technical_file_name(stem) is True


@pytest.mark.parametrize(
    "stem",
    [
        "maria",
        "ab",  # two letters are enough
        "maria_headshot",
        "Grandpa Joe",
        "ab-c",  # separators just under a third
        "photographer jane",  # a technical word only counts as a whole word
        "rawson",
    ],
)
def test_someones_own_words_are_not_a_technical_file_name(stem):
    assert technical_file_name(stem) is False


# --- plan: default_name ----------------------------------------------------------------


@pytest.mark.parametrize(
    ("description", "name"),
    [
        ("a cheerful baker", "Cheerful baker"),
        ("An owl", "Owl"),
        ("THE pirate", "Pirate"),
        ("la chouette", "Chouette"),
        ("les trois ours", "Trois ours"),
        ("des chats", "Chats"),
        ("l' ours", "Ours"),
        ("l'ours brun", "L'ours brun"),  # an article glued to its word stays
        ("the a team", "A team"),  # only the first article goes
        ("  a   cheerful\n\tbaker ...!? ", "Cheerful baker"),  # blanks and end punctuation
        ("dr. McCoy from the iPhone ad", "Dr. McCoy from the iPhone ad"),  # first letter only
    ],
)
def test_the_description_names_the_avatar_in_its_own_words(description, name):
    assert default_name(description=description) == name


def test_the_description_is_used_even_when_it_looks_technical():
    """The owner's words are theirs: only a file name is judged."""
    assert default_name(description="photo 1", file_name="maria.jpg") == "Photo 1"


@pytest.mark.parametrize("description", ["the ...", "   ", "?!"])
def test_a_description_without_words_falls_back_to_the_file_name(description):
    assert default_name(description=description, file_name="maria_headshot.png") == (
        "Maria headshot"
    )


@pytest.mark.parametrize(
    ("description", "name"),
    [
        # 49 characters: cut at the last space that fits.
        ("word " * 10, "Word word word word word word word word"),
        # The last space past half the limit: cut there.
        ("x" * 21 + " " + "y" * 30, "X" + "x" * 20),
        # A space at exactly half is not near enough: cut at NAME_MAX.
        ("x" * 20 + " " + "y" * 30, "X" + "x" * 19 + " " + "y" * 19),
        ("x" * 60, "X" + "x" * (NAME_MAX - 1)),
        # A space right after NAME_MAX: the full length is kept.
        ("x" * NAME_MAX + " yy", "X" + "x" * (NAME_MAX - 1)),
        ("x" * NAME_MAX, "X" + "x" * (NAME_MAX - 1)),
    ],
)
def test_a_long_name_is_cut_at_a_word_boundary_when_one_is_near(description, name):
    assert default_name(description=description) == name
    assert len(name) <= NAME_MAX


@pytest.mark.parametrize(
    ("file_name", "name"),
    [
        ("maria.headshot.jpg", "Maria headshot"),  # only the last extension goes
        ("  maria--smith.png  ", "Maria smith"),  # separators collapse into one space
        ("jean-luc picard.png", "Jean luc picard"),
        ("Grandma", "Grandma"),  # no extension at all
    ],
)
def test_a_meaningful_file_name_becomes_the_name(file_name, name):
    assert default_name(file_name=file_name) == name


def test_a_long_file_name_is_cut_like_a_description():
    stem = "grandmother_margaret_at_the_seaside_in_summer"
    name = default_name(file_name=f"{stem}.jpg")
    assert name == "Grandmother margaret at the seaside in"
    assert len(name) <= NAME_MAX


def test_no_description_and_a_technical_file_name_give_no_name():
    assert default_name(description=None, file_name="IMG_0001.HEIC") is None
    assert default_name(description="", file_name=None) is None


@pytest.mark.parametrize("value", [None, "", "   ", 7, ["Maria"]])
def test_a_kept_name_that_is_not_words_is_none(value):
    assert name_of({"name": value}) is None


def test_a_kept_name_is_trimmed_and_steps_without_one_have_none():
    assert name_of({"name": "  Rex  "}) == "Rex"
    assert name_of({}) is None


# --- prompts ---------------------------------------------------------------------------


def test_every_model_and_look_has_its_style_and_its_subject():
    pairs = {(model, look) for model in MODELS for look in LOOKS}
    assert set(prompts.LOOK_WORDS) == pairs
    assert set(prompts.PREPARE_SUBJECT) == pairs
    assert set(prompts.FRAMING) == set(MODELS) == set(prompts.DEFAULT_SUBJECT)


@pytest.mark.parametrize(
    ("words", "quoted"),
    [
        ('  a  "big"\n\tcat ', "\"a 'big' cat\""),  # one line, single quotes inside
        (None, '""'),
        ("a" + " " * 500 + "b", '"a b"'),  # blanks collapse before the cut
        ("x" * (MAX_WORDS + 10), '"' + "x" * MAX_WORDS + '"'),
    ],
)
def test_the_owners_words_are_quoted_on_one_line_and_cut_at_max_words(words, quoted):
    assert prompts._quoted(words) == quoted


def test_the_requirements_are_framing_light_backdrop_avoid_then_the_look():
    assert prompts._requirements("animal", "animation") == " ".join(
        (
            prompts.FRAMING["animal"],
            prompts.LIGHT,
            prompts.BACKDROP,
            prompts.AVOID,
            prompts.LOOK_WORDS[("animal", "animation")],
        )
    )


@pytest.mark.parametrize("description", [None, "", "   "])
def test_a_character_without_a_description_is_the_models_default_subject(description):
    text = prompts.character_prompt("human", "cartoon", description)
    assert text.startswith(
        "Create a portrait of a character for a talking avatar. The character, in the "
        'owner\'s words: "a friendly, approachable adult".'
    )
    assert text.endswith(prompts._requirements("human", "cartoon"))


def test_an_animals_character_is_asked_for_as_an_animal_character():
    text = prompts.character_prompt("animal", "realistic", "  a grey cat  ")
    assert 'The animal character, in the owner\'s words: "a grey cat".' in text
    assert "a friendly dog" not in text


@pytest.mark.parametrize("instruction", [None, "", "  \n"])
def test_an_upload_without_an_instruction_asks_for_the_look_alone(instruction):
    assert prompts.prepare_prompt("animal", "cartoon", instruction) == (
        prompts.PREPARE_SUBJECT[("animal", "cartoon")]
        + " "
        + prompts._requirements("animal", "cartoon")
    )


def test_an_uploads_instruction_is_quoted_between_the_subject_and_the_requirements():
    text = prompts.prepare_prompt("human", "realistic", ' no "glasses" ')
    subject = prompts.PREPARE_SUBJECT[("human", "realistic")]
    assert text == (
        f"{subject} The owner also asks for this change, in their words: \"no 'glasses'\". "
        "Apply it without changing anything that follows. "
        + prompts._requirements("human", "realistic")
    )


@pytest.mark.parametrize(("model", "noun"), [("human", "person"), ("animal", "animal")])
def test_a_change_keeps_the_same_person_or_animal(model, noun):
    text = prompts.change_prompt(model, "animation", "a red scarf")
    assert text.startswith(
        "Edit this avatar portrait. Apply only this change, in the owner's words: "
        f'"a red scarf". Keep everything else exactly as it is: the same {noun} and identity'
    )
    assert text.endswith(prompts._requirements(model, "animation"))


# --- versions --------------------------------------------------------------------------


def _item(key: str, source: str | None, **extra) -> dict:
    return {"key": key, "width": 600, "height": 750, "from": source, **extra}


def _adjust(**extra) -> dict:
    return {
        "mode": "regenerate",
        "look": "realistic",
        "instruction": None,
        "rejected": None,
        **extra,
    }


def _made() -> dict:
    """An upload "use my original photo" framed and cut out, an AI result
    with its cut-out, and a change of it that could not be cut."""
    return {
        "current": "adjusted:1",
        "background": "keep",
        "plan": make_plan("human", "realistic", "upload"),
        "name": "Maria",
        "items": {
            "original": _item("k/original", None),
            "framed": _item("k/framed", "original"),
            "cutout": _item("k/cutout", "framed", cutout=True),
            "adjusted:0": _item("k/a0", "original", adjust=_adjust()),
            "cutout:0": _item("k/c0", "adjusted:0", cutout=True),
            "adjusted:1": _item("k/a1", "adjusted:0", adjust=_adjust(instruction="a hat")),
        },
    }


UPLOAD = make_plan("human", "realistic", "upload")


@pytest.mark.parametrize(
    ("step_id", "version"),
    [
        ("original", "original"),
        ("framed", "original"),
        ("cutout", "original"),
        ("adjusted:0", "adjusted:0"),
        ("cutout:0", "adjusted:0"),
        ("adjusted:1", "adjusted:1"),
        ("adjusted:9", None),
        (None, None),
    ],
)
def test_each_image_belongs_to_the_version_it_shows(step_id, version):
    assert version_of(_made(), step_id) == version


def test_a_cutout_of_the_upload_itself_is_the_original_version():
    steps = {"items": {"original": _item("o", None), "cutout": _item("c", "original")}}
    assert version_of(steps, "cutout") == "original"
    assert version_of(None, "original") is None


@pytest.mark.parametrize("version", ["cutout:0", "cutout", "framed", "adjusted:9", "", "plan"])
def test_only_a_version_can_be_chosen(version):
    with pytest.raises(Validation422) as refused:
        use_version(_made(), version, UPLOAD)
    assert refused.value.code == "unknown_version"
    assert refused.value.status_code == 422


def test_steps_with_nothing_in_them_have_no_version():
    with pytest.raises(Validation422) as refused:
        use_version(None, "original", UPLOAD)
    assert refused.value.code == "unknown_version"


def test_a_result_that_failed_its_checks_cannot_be_chosen():
    steps = _made()
    steps["items"]["adjusted:0"]["adjust"]["rejected"] = {"code": "eyes_closed"}
    with pytest.raises(Validation422) as refused:
        use_version(steps, "adjusted:0", UPLOAD)
    assert refused.value.code == "candidate_rejected"


@pytest.mark.parametrize("look", ["animation", "cartoon"])
def test_the_upload_of_a_stylised_plan_is_not_a_version_even_when_prepared(look):
    with pytest.raises(Validation422) as refused:
        use_version(_made(), "original", make_plan("human", look, "upload"))
    assert refused.value.code == "original_not_for_look"


def test_an_upload_never_framed_nor_cut_out_is_not_prepared_yet():
    steps = {
        "current": "cutout:0",
        "items": {
            "original": _item("k/original", None),
            "adjusted:0": _item("k/a0", "original", adjust=_adjust()),
            "cutout:0": _item("k/c0", "adjusted:0", cutout=True),
        },
    }
    with pytest.raises(Conflict409) as refused:
        use_version(steps, "original", UPLOAD)
    assert refused.value.code == "version_not_prepared"
    assert refused.value.status_code == 409


def test_a_framed_upload_goes_back_to_the_cutout_of_its_framing():
    steps = _made()
    record = {
        "mode": "original",
        "look": "realistic",
        "instruction": None,
        "step": "framed",
        "cut": True,
    }
    anchors = {"id": "f1", "frame": "k/framed", "marks": {"left_eye": {"x": 1, "y": 2}}}
    steps["items"]["framed"][KEPT_RECORD] = record
    steps["items"]["framed"][KEPT_ANCHORS] = anchors
    out, kept, made = use_version(steps, "original", UPLOAD)
    assert (out["current"], out["background"]) == ("cutout", "remove")
    assert made == record and made is not record
    assert kept == anchors


def test_an_upload_cut_out_without_framing_is_prepared_and_its_record_rebuilt():
    """No face to frame on: the cut-out was made of the upload itself."""
    steps = {
        "current": "cutout",
        "items": {
            "original": _item("k/original", None),
            "cutout": _item("k/cutout", "original", cutout=True),
        },
    }
    out, kept, record = use_version(steps, "original", UPLOAD)
    assert (out["current"], out["background"]) == ("cutout", "remove")
    assert kept is None
    assert record == {
        "mode": "original",
        "look": "realistic",
        "instruction": None,
        "step": "original",
        "cut": True,
    }


def test_an_upload_nothing_could_cut_is_prepared_by_its_record_and_kept_opaque():
    record = {
        "mode": "original",
        "look": "realistic",
        "instruction": None,
        "step": "original",
        "cut": False,
    }
    steps = {
        "current": "adjusted:0",
        "items": {
            "original": _item("k/original", None, **{KEPT_RECORD: record}),
            "adjusted:0": _item("k/a0", "original", adjust=_adjust()),
        },
    }
    out, _, made = use_version(steps, "original", UPLOAD)
    assert (out["current"], out["background"]) == ("original", "keep")
    assert made == record


def test_a_cutout_of_the_upload_does_not_stand_for_its_framing():
    """The framing replaced the upload: a cut-out still made of the upload
    is not the framing's, so the framing is shown opaque."""
    steps = _made()
    steps["items"]["cutout"]["from"] = "original"
    out, _, record = use_version(steps, "original", UPLOAD)
    assert (out["current"], out["background"]) == ("framed", "keep")
    assert record["step"] == "framed" and record["cut"] is False


def test_a_generated_characters_picture_is_a_version_in_any_look():
    plan = make_plan("animal", "cartoon", "generate", "a fox")
    steps = {
        "current": "adjusted:0",
        "items": {
            "original": _item(
                "k/original", None, generated={"model": "m", "style": "s", "source_avatar_id": None}
            ),
            "adjusted:0": _item("k/a0", "original", adjust=_adjust(mode="generate")),
        },
    }
    out, kept, record = use_version(steps, "original", plan)
    assert (out["current"], out["background"]) == ("original", "keep")
    assert kept is None
    assert record == {
        "mode": "generate",
        "look": "cartoon",
        "instruction": None,
        "step": "original",
        "cut": False,
    }


def test_an_ai_result_goes_back_to_its_cutout():
    out, _, record = use_version(_made(), "adjusted:0", UPLOAD)
    assert (out["current"], out["background"]) == ("cutout:0", "remove")
    assert record == {
        "mode": "ai",
        "look": "realistic",
        "instruction": None,
        "step": "adjusted:0",
        "cut": True,
    }


def test_an_ai_result_that_was_never_cut_out_is_shown_opaque():
    out, _, record = use_version(_made(), "adjusted:1", UPLOAD)
    assert (out["current"], out["background"]) == ("adjusted:1", "keep")
    assert record == {
        "mode": "change",
        "look": "realistic",
        "instruction": "a hat",
        "step": "adjusted:1",
        "cut": False,
    }


@pytest.mark.parametrize(
    ("adjust", "mode", "look"),
    [
        ({"mode": "generate", "instruction": "taller"}, "generate", "animation"),
        ({"mode": "stylise", "instruction": "a hat", "look": "cartoon"}, "change", "cartoon"),
        ({"mode": "stylise", "instruction": None}, "ai", "animation"),
        ({"mode": "regenerate", "instruction": ""}, "ai", "animation"),
    ],
)
def test_an_old_versions_record_is_read_off_its_adjust(adjust, mode, look):
    """A generate stays a generate even with words; any other with words
    was a change; the look recorded on the step wins over the plan's."""
    steps = {
        "items": {
            "original": _item("o", None),
            "adjusted:3": _item("a3", "original", adjust=adjust),
        },
    }
    _, _, record = use_version(steps, "adjusted:3", make_plan("human", "animation", "upload"))
    assert record == {
        "mode": mode,
        "look": look,
        "instruction": adjust["instruction"],
        "step": "adjusted:3",
        "cut": False,
    }


def test_a_kept_record_is_copied_and_says_whether_the_cutout_is_shown_now():
    steps = _made()
    kept = {
        "mode": "change",
        "look": "animation",
        "instruction": "smile",
        "step": "adjusted:0",
        "cut": False,
    }
    steps["items"]["adjusted:0"][KEPT_RECORD] = kept
    _, _, record = use_version(steps, "adjusted:0", UPLOAD)
    assert record == {**kept, "cut": True}
    assert record is not kept
    assert steps["items"]["adjusted:0"][KEPT_RECORD]["cut"] is False


def test_kept_anchors_are_a_deep_copy():
    steps = _made()
    anchors = {"id": "a0", "frame": "k/a0", "marks": {"left_eye": {"x": 1, "y": 2}}}
    steps["items"]["adjusted:0"][KEPT_ANCHORS] = anchors
    _, kept, _ = use_version(steps, "adjusted:0", UPLOAD)
    assert kept == anchors
    kept["marks"]["left_eye"]["x"] = 99
    assert steps["items"]["adjusted:0"][KEPT_ANCHORS]["marks"]["left_eye"]["x"] == 1


def test_anchors_kept_on_a_cutout_are_not_the_versions():
    """Anchors are kept on the opaque step only."""
    steps = _made()
    steps["items"]["cutout:0"][KEPT_ANCHORS] = {"id": "stray"}
    _, kept, _ = use_version(steps, "adjusted:0", UPLOAD)
    assert kept is None


def test_choosing_a_version_never_edits_the_steps_it_was_given():
    steps = _made()
    steps["items"]["adjusted:0"][KEPT_ANCHORS] = {"id": "a0", "marks": {}}
    before = copy.deepcopy(steps)
    out, _, _ = use_version(steps, "adjusted:0", UPLOAD)
    assert steps == before
    assert out is not steps and out["items"] is not steps["items"]
    assert out["items"]["adjusted:0"] is not steps["items"]["adjusted:0"]
    # Everything else the steps carry comes along unchanged.
    assert out["plan"] == steps["plan"] and out["name"] == "Maria"
    assert out["items"] == steps["items"]


# --- prepare: the cut-out --------------------------------------------------------------


@pytest.fixture
def cutters(monkeypatch):
    """The segmenter and the keyer, scripted: each answer is bytes, None or
    an exception to raise. Records who was asked."""
    asked: list[str] = []
    script: dict[str, object] = {"segment": b"SEGMENTED", "backdrop": b"KEYED"}

    def answer(name, data):
        asked.append(name)
        assert data == b"PNG"
        result = script[name]
        if isinstance(result, BaseException):
            raise result
        return result

    monkeypatch.setattr(segment, "remove_background", lambda data: answer("segment", data))
    monkeypatch.setattr(backdrop, "cut_backdrop", lambda data: answer("backdrop", data))
    return asked, script


def test_a_person_is_cut_by_the_segmenter_alone(cutters):
    asked, _ = cutters
    assert prepare.cut_out(b"PNG", "human") == b"SEGMENTED"
    assert asked == ["segment"]


def test_a_person_without_a_segmenter_goes_to_the_keyer_quietly(cutters, caplog):
    asked, script = cutters
    script["segment"] = segment.SegmentationUnavailable("no model on this server")
    with caplog.at_level(logging.ERROR, logger="liveface.wizard"):
        assert prepare.cut_out(b"PNG", "human") == b"KEYED"
    assert asked == ["segment", "backdrop"]
    assert caplog.records == []


def test_a_segmenter_that_fails_is_logged_and_the_keyer_takes_the_person(cutters, caplog):
    asked, script = cutters
    script["segment"] = RuntimeError("onnx went away")
    with caplog.at_level(logging.ERROR, logger="liveface.wizard"):
        assert prepare.cut_out(b"PNG", "human") == b"KEYED"
    assert asked == ["segment", "backdrop"]
    assert [r.getMessage() for r in caplog.records] == [
        "segmenting a prepared picture failed; keying its backdrop"
    ]


@pytest.mark.parametrize("face_type", ["animal", "cartoon"])
def test_anything_but_a_person_goes_straight_to_the_keyer(cutters, face_type):
    asked, _ = cutters
    assert prepare.cut_out(b"PNG", face_type) == b"KEYED"
    assert asked == ["backdrop"]


def test_a_picture_the_keyer_cannot_cut_is_kept_as_it_is(cutters):
    _, script = cutters
    script["backdrop"] = None
    assert prepare.cut_out(b"PNG", "animal") is None


def test_a_keyer_that_fails_leaves_the_picture_uncut(cutters, caplog):
    asked, script = cutters
    script["segment"] = segment.SegmentationUnavailable("none")
    script["backdrop"] = ValueError("not an image")
    with caplog.at_level(logging.ERROR, logger="liveface.wizard"):
        assert prepare.cut_out(b"PNG", "human") is None
    assert asked == ["segment", "backdrop"]
    assert [r.getMessage() for r in caplog.records] == [
        "keying a prepared picture's backdrop failed"
    ]


# --- prepare: the refunds --------------------------------------------------------------


@pytest.mark.parametrize(("before", "after"), [(3, 2), (1, 0), (0, 0), (None, 0), ("2", 1)])
def test_a_refund_gives_one_try_back_and_never_goes_below_zero(before, after):
    usage = {"prepare_rounds": before, "free_clears": 2, "next_adjusted": 4}
    prepare._refund(usage)
    assert usage == {"prepare_rounds": after, "free_clears": 2, "next_adjusted": 4}


@pytest.mark.parametrize(("before", "after"), [(3, 2), (1, 0), (0, 0), (None, 0)])
def test_a_free_refund_gives_one_free_removal_back_and_never_goes_below_zero(before, after):
    usage = {"prepare_rounds": 5, "free_clears": before}
    prepare._refund_free(usage)
    assert usage == {"prepare_rounds": 5, "free_clears": after}


def test_a_refund_of_a_counter_never_set_leaves_it_at_zero():
    usage: dict = {}
    prepare._refund(usage)
    prepare._refund_free(usage)
    assert usage == {"prepare_rounds": 0, "free_clears": 0}


# --- prepare: settle -------------------------------------------------------------------


class FakeStorage:
    def __init__(self) -> None:
        self.files: dict[str, tuple[bytes, str]] = {}

    async def put_bytes(self, key: str, data: bytes, content_type: str) -> None:
        self.files[key] = (data, content_type)

    async def get_bytes(self, key: str) -> bytes:
        return self.files[key][0]

    async def exists(self, key: str) -> bool:
        return key in self.files

    async def delete(self, key: str) -> None:
        self.files.pop(key, None)


def _found(detected: bool) -> dict:
    return {
        "image_size": [600, 750],
        "detected": detected,
        "base": [[1.0, 2.0, 0.0]],
        "marks": {"left_eye": {"x": 1.0, "y": 2.0}},
        "validation": {
            "ok": True,
            "reasons": [],
            "warnings": [],
            "detected": detected,
            "one_click": detected,
        },
    }


class Settling:
    """What settle reaches for, replaced: the storage, the CPU thread, the
    cut-out, the face finder and the vision model's points."""

    def __init__(self, monkeypatch) -> None:
        self.storage = FakeStorage()
        self.cut: bytes | None = b"CUT"
        self.detected = True
        self.ai: tuple[dict | None, dict | None] = (None, None)
        self.cut_calls: list[tuple] = []
        self.detect_calls: list[tuple] = []
        self.ai_calls: list[tuple] = []

        async def inline(fn, /, *args, **kwargs):
            return fn(*args, **kwargs)

        def cut_out(png, face_type):
            self.cut_calls.append((png, face_type))
            return self.cut

        def detect_anchors(png, face_type):
            self.detect_calls.append((png, face_type))
            return _found(self.detected)

        async def ai_points(job, params, data, face_type, size):
            self.ai_calls.append((params, data, face_type, size))
            return copy.deepcopy(self.ai)

        monkeypatch.setattr(prepare, "get_storage", lambda: self.storage)
        monkeypatch.setattr(prepare, "run_cpu", inline)
        monkeypatch.setattr(prepare, "cut_out", cut_out)
        monkeypatch.setattr(svc, "detect_anchors", detect_anchors)
        monkeypatch.setattr(detect, "ai_points", ai_points)


@pytest.fixture
def settling(monkeypatch) -> Settling:
    return Settling(monkeypatch)


def _job() -> Job:
    return Job(id="job1", org_id="org1", subject_id="cr1", step="prepare", revision=3)


def _settle_steps() -> dict:
    return {
        "current": "original",
        "background": None,
        "items": {
            "original": _item("orgs/org1/creations/cr1/original-a.png", None),
            "adjusted:2": _item("orgs/org1/creations/cr1/adjusted2-b.png", "original"),
        },
    }


async def test_settle_stores_the_cutout_makes_it_current_and_finds_the_face_on_it(settling):
    job, steps, new_keys = _job(), _settle_steps(), ["earlier"]
    anchors, cut = await prepare.settle(
        job, Creation(face_type="human"), steps, "adjusted:2", b"PNG", None, new_keys
    )
    assert cut is True
    key = new_keys[1]
    assert new_keys == ["earlier", key]
    assert key.startswith("orgs/org1/creations/cr1/cutout2-") and key.endswith(".png")
    assert settling.storage.files == {key: (b"CUT", "image/png")}
    assert steps["items"]["cutout:2"] == {
        "key": key,
        "width": 600,
        "height": 750,
        "from": "adjusted:2",
        "cutout": True,
    }
    assert (steps["current"], steps["background"]) == ("cutout:2", "remove")
    assert settling.cut_calls == [(b"PNG", "human")]
    # The face is found on what is shown: the cut-out.
    assert settling.detect_calls == [(b"CUT", "human")]
    assert len(anchors["id"]) == 32 and int(anchors["id"], 16) >= 0
    assert anchors == {
        "id": anchors["id"],
        # Bound to the opaque picture's pixel grid, which its cut-out shares.
        "frame": "orgs/org1/creations/cr1/adjusted2-b.png",
        "face_type": "human",
        "source": "mediapipe",
        **_found(True),
    }
    assert (job.fraction, job.label) == (0.85, "finding the face")


async def test_settle_keeps_the_anchors_on_the_opaque_step_as_a_deep_copy(settling):
    steps = _settle_steps()
    anchors, _ = await prepare.settle(
        _job(), Creation(face_type="human"), steps, "adjusted:2", b"PNG", None, []
    )
    kept = steps["items"]["adjusted:2"][KEPT_ANCHORS]
    assert kept == anchors
    assert kept is not anchors and kept["marks"] is not anchors["marks"]
    assert KEPT_ANCHORS not in steps["items"]["cutout:2"]


async def test_settle_cuts_the_upload_out_as_the_one_cutout(settling):
    steps, new_keys = _settle_steps(), []
    _, cut = await prepare.settle(
        _job(), Creation(face_type="human"), steps, "original", b"PNG", None, new_keys
    )
    assert cut is True
    assert new_keys[0].startswith("orgs/org1/creations/cr1/cutout-")
    assert steps["items"]["cutout"]["from"] == "original"
    assert (steps["current"], steps["background"]) == ("cutout", "remove")


async def test_settle_keeps_a_picture_nothing_could_cut_opaque(settling):
    settling.cut = None
    steps, new_keys = _settle_steps(), []
    anchors, cut = await prepare.settle(
        _job(), Creation(face_type="animal"), steps, "adjusted:2", b"PNG", None, new_keys
    )
    assert cut is False
    assert new_keys == [] and settling.storage.files == {}
    assert "cutout:2" not in steps["items"]
    assert (steps["current"], steps["background"]) == ("adjusted:2", "keep")
    assert settling.detect_calls == [(b"PNG", "animal")]
    assert anchors["frame"] == "orgs/org1/creations/cr1/adjusted2-b.png"
    assert steps["items"]["adjusted:2"][KEPT_ANCHORS] == anchors


async def test_settle_places_the_template_when_no_face_was_detected(settling):
    settling.detected = False
    anchors, _ = await prepare.settle(
        _job(), Creation(face_type="human"), _settle_steps(), "adjusted:2", b"PNG", None, []
    )
    assert anchors["source"] == "template"


async def test_settle_refuses_a_creation_without_a_line_before_touching_anything(settling):
    steps = _settle_steps()
    before = copy.deepcopy(steps)
    with pytest.raises(Validation422) as refused:
        await prepare.settle(
            _job(), Creation(face_type=None), steps, "adjusted:2", b"PNG", None, []
        )
    assert refused.value.code == "face_type_required"
    assert steps == before and settling.storage.files == {} and settling.cut_calls == []


async def test_settle_takes_the_vision_models_points_for_an_animal_with_consent(settling):
    ai = _found(True)
    ai["base"] = [[5.0, 6.0, 0.0]]
    settling.ai = (ai, None)
    settling.detected = False
    anchors, _ = await prepare.settle(
        _job(),
        Creation(face_type="animal"),
        _settle_steps(),
        "adjusted:2",
        b"PNG",
        "consent1",
        [],
    )
    assert anchors["source"] == "ai" and anchors["base"] == [[5.0, 6.0, 0.0]]
    digest = hashlib.sha256(b"CUT").hexdigest()
    assert settling.ai_calls == [
        ({"sha256": digest, "charged": False}, b"CUT", "animal", (600, 750))
    ]


async def test_settle_shows_why_the_vision_models_points_were_not_used(settling):
    warning = {"code": "ai_points_refused", "detail": "The AI declined"}
    settling.ai = (None, warning)
    settling.detected = False
    anchors, _ = await prepare.settle(
        _job(),
        Creation(face_type="cartoon"),
        _settle_steps(),
        "adjusted:2",
        b"PNG",
        "consent1",
        [],
    )
    assert anchors["source"] == "template"
    assert anchors["validation"]["warnings"] == [warning]


async def test_settle_without_points_or_warning_keeps_what_the_detector_found(settling):
    settling.ai = (None, None)
    anchors, _ = await prepare.settle(
        _job(),
        Creation(face_type="animal"),
        _settle_steps(),
        "adjusted:2",
        b"PNG",
        "consent1",
        [],
    )
    assert anchors["source"] == "mediapipe" and anchors["validation"]["warnings"] == []
    assert len(settling.ai_calls) == 1


@pytest.mark.parametrize(
    ("face_type", "detected", "consent_id"),
    [
        ("animal", False, None),  # no consent: never asked
        ("human", False, "consent1"),  # a person: MediaPipe fits better
        ("cartoon", True, "consent1"),  # a drawing MediaPipe saw
    ],
)
async def test_settle_does_not_ask_the_vision_model_when_it_is_not_wanted(
    settling, face_type, detected, consent_id
):
    settling.detected = detected
    await prepare.settle(
        _job(),
        Creation(face_type=face_type),
        _settle_steps(),
        "adjusted:2",
        b"PNG",
        consent_id,
        [],
    )
    assert settling.ai_calls == []
