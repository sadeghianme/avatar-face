"""The point finder: the request it makes, and what it does with answers.

No request leaves the process: `FakeGemini` stands in for httpx and answers
with what each test gives it, recording what it was sent. The answers are
built in Gemini's own convention ([y, x], 0-1000) from pixel positions, so
a test can say "the left eye is here" in pixels and check the marks land
there, whichever way round the model named things.
"""

import json

import httpx
import numpy as np
import pytest

from app.services import ai_models, face_template
from app.services import vision_points as vp
from app.services.anchor_fit import HEAD, HEAD_DIAGONALS, LEFT_EYE, MOUTH, RIGHT_EYE

SIZE = (600, 800)  # not square, so a transposed answer cannot pass by symmetry


def to_answer(xy: tuple[float, float], size=SIZE) -> list[int]:
    """(x, y) pixels → Gemini's [y, x] in 0-1000."""
    return [round(xy[1] / size[1] * 1000), round(xy[0] / size[0] * 1000)]


def face_in_pixels(box=(150, 200, 450, 600)) -> dict[str, tuple[float, float]]:
    """A plausible face, named by IMAGE side, from the template's landmarks."""
    points = face_template.place(box)

    def at(i):
        return tuple(points[i])

    seam = (points[13] + points[14]) / 2
    left, right = points[MOUTH["left"]], points[MOUTH["right"]]
    return {
        "head_top": at(HEAD["top"]),
        "head_left": at(HEAD["left"]),
        "head_right": at(HEAD["right"]),
        **{f"left_eye_{k}": at(v) for k, v in LEFT_EYE.items()},
        **{f"right_eye_{k}": at(v) for k, v in RIGHT_EYE.items()},
        "mouth_left": tuple(left),
        "mouth_left_mid": tuple((left + seam) / 2),
        "mouth_center": tuple(seam),
        "mouth_right_mid": tuple((seam + right) / 2),
        "mouth_right": tuple(right),
        "chin": at(HEAD["bottom"]),
        "left_pupil": at(468),
        "right_pupil": at(473),
    }


def answer_for(face: dict, face_type: str, size=SIZE) -> dict[str, list[int]]:
    return {name: to_answer(face[name], size) for name in vp.ANCHORS[face_type]}


def body_with(answer: dict, found: bool = True) -> dict:
    return {
        "candidates": [
            {
                "content": {"parts": [{"text": json.dumps({"face_found": found, **answer})}]},
                "finishReason": "STOP",
            }
        ]
    }


# --- the request --------------------------------------------------------------------


def test_the_request_asks_for_structured_yx_points_by_image_side():
    body = vp.build_request("animal", b"jpeg", "image/jpeg")
    config = body["generationConfig"]
    assert config["responseMimeType"] == "application/json"
    schema = config["responseJsonSchema"]
    assert set(schema["required"]) == {"face_found", *vp.ANCHORS["animal"]}
    point = schema["properties"]["chin"]
    assert point["minItems"] == point["maxItems"] == 2
    assert point["items"]["maximum"] == 1000
    prompt = body["contents"][0]["parts"][0]["text"]
    assert "[y, x]" in prompt and "0-1000" in prompt
    assert "IMAGE's left" in prompt
    assert body["contents"][0]["parts"][1]["inline_data"]["mime_type"] == "image/jpeg"


def test_animations_are_asked_for_pupils_and_animals_are_not():
    assert "left_pupil" in vp.ANCHORS["cartoon"]
    assert "left_pupil" not in vp.ANCHORS["animal"]


def test_the_model_is_a_pinned_id_from_the_one_config_place():
    assert vp.MODEL == ai_models.VISION_MODEL
    assert "latest" not in vp.MODEL and "preview" not in vp.MODEL


class FakeGemini:
    """httpx.AsyncClient for the point finder: records, answers as told."""

    def __init__(self, monkeypatch, status=200, body=None):
        self.status, self.body, self.sent = status, body or {}, []
        fake = self

        class Client:
            def __init__(self, *args, **kwargs):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *exc):
                return False

            async def post(self, url, headers=None, json=None):
                fake.sent.append({"url": url, "headers": headers, "json": json})
                return httpx.Response(fake.status, json=fake.body)

            async def get(self, url, headers=None):
                fake.sent.append({"url": url, "headers": headers})
                return httpx.Response(fake.status, json=fake.body)

        monkeypatch.setattr(httpx, "AsyncClient", Client)


@pytest.fixture
def keyed(monkeypatch):
    monkeypatch.setattr(ai_models, "api_key", lambda: "test-key")


async def test_request_points_posts_to_the_vision_model_and_parses(monkeypatch, keyed):
    face = face_in_pixels()
    fake = FakeGemini(monkeypatch, body=body_with(answer_for(face, "animal")))
    points = await vp.request_points(b"jpeg", "image/jpeg", "animal")
    assert fake.sent[0]["url"] == ai_models.generate_url(ai_models.VISION_MODEL)
    assert fake.sent[0]["headers"] == {"x-goog-api-key": "test-key"}
    assert points["chin"] == to_answer(face["chin"])


async def test_without_a_key_nothing_is_sent(monkeypatch):
    monkeypatch.setattr(ai_models, "api_key", lambda: None)
    fake = FakeGemini(monkeypatch)
    with pytest.raises(vp.VisionUnavailable):
        await vp.request_points(b"jpeg", "image/jpeg", "animal")
    assert fake.sent == []


async def test_a_safety_refusal_is_named_and_counts_as_answered(monkeypatch, keyed):
    FakeGemini(monkeypatch, body={"promptFeedback": {"blockReason": "SAFETY"}})
    with pytest.raises(vp.VisionRefused) as refused:
        await vp.request_points(b"jpeg", "image/jpeg", "animal")
    assert refused.value.code == "safety_refused"
    assert refused.value.answered is True


async def test_an_http_error_was_not_answered(monkeypatch, keyed):
    FakeGemini(monkeypatch, status=503, body={"error": "busy"})
    with pytest.raises(vp.VisionError) as failed:
        await vp.request_points(b"jpeg", "image/jpeg", "animal")
    assert failed.value.answered is False


@pytest.mark.parametrize(
    "body, code",
    [
        ({"candidates": [{"content": {"parts": [{"text": "not json"}]}}]}, "ai_points_failed"),
        (body_with({}, found=False), "ai_no_face"),
        (body_with({"chin": [5000, 1]}), "ai_points_failed"),
    ],
)
def test_unusable_answers_are_refused(body, code):
    with pytest.raises(vp.VisionError) as failed:
        vp.parse_answer(body, "animal")
    assert failed.value.code == code


def test_thought_parts_are_not_read_as_the_answer():
    face = face_in_pixels()
    body = body_with(answer_for(face, "animal"))
    body["candidates"][0]["content"]["parts"].insert(0, {"text": "thinking…", "thought": True})
    assert vp.parse_answer(body, "animal")["chin"] == to_answer(face["chin"])


# --- conventions ----------------------------------------------------------------------


def test_points_are_y_then_x():
    # 100 down, 900 across: near the top right corner.
    x, y = vp.to_pixels([100, 900], SIZE)
    assert (x, y) == pytest.approx((540.0, 80.0))


def test_marks_land_where_the_face_is():
    face = face_in_pixels()
    marks = vp.to_marks(answer_for(face, "animal"), SIZE, "animal")
    tolerance = max(SIZE) / 1000  # one unit of Gemini's grid
    assert marks["left_eye"]["left"]["x"] == pytest.approx(face["left_eye_left"][0], abs=tolerance)
    assert marks["chin"]["y"] == pytest.approx(face["chin"][1], abs=tolerance)
    assert marks["head"]["bottom"] == marks["chin"]
    assert len(marks["mouth_line"]) == 5
    assert [p["x"] for p in marks["mouth_line"]] == sorted(p["x"] for p in marks["mouth_line"])
    assert "left_pupil" not in marks


def test_an_answer_named_by_the_subjects_side_gives_the_same_marks():
    """The subject's left eye is on the IMAGE's right. A model that names
    parts that way swaps every left and right; the marks must not care."""
    face = face_in_pixels()
    by_image = answer_for(face, "cartoon")
    by_subject = {
        name.replace("left", "·").replace("right", "left").replace("·", "right"): value
        for name, value in by_image.items()
    }
    assert by_subject != by_image
    assert vp.to_marks(by_subject, SIZE, "cartoon") == vp.to_marks(by_image, SIZE, "cartoon")


def test_an_x_y_answer_read_as_y_x_is_implausible():
    face = face_in_pixels()
    transposed = {name: [p[1], p[0]] for name, p in answer_for(face, "animal").items()}
    marks = vp.to_marks(transposed, SIZE, "animal")
    assert vp.check_geometry(marks, SIZE) != []
    assert vp.anchors_from_points(transposed, SIZE, "animal").anchors is None


def test_implausible_faces_are_named():
    face = face_in_pixels()
    upside_down = dict(face)
    upside_down["mouth_center"] = (face["mouth_center"][0], face["head_top"][1] + 5)
    marks = vp.to_marks(answer_for(upside_down, "animal"), SIZE, "animal")
    assert "the mouth is not below the eyes" in vp.check_geometry(marks, SIZE)

    tiny = face_in_pixels(box=(290, 390, 310, 410))
    marks = vp.to_marks(answer_for(tiny, "animal"), SIZE, "animal")
    assert vp.check_geometry(marks, SIZE) == ["the head is too small or upside down"]


# --- to anchors -----------------------------------------------------------------------


@pytest.mark.parametrize("face_type", ["animal", "cartoon"])
def test_a_good_answer_becomes_anchors_that_fit(face_type):
    face = face_in_pixels()
    result = vp.anchors_from_points(answer_for(face, face_type), SIZE, face_type)
    assert result.problems == []
    anchors = result.anchors
    assert anchors["image_size"] == list(SIZE)
    # A pre-fill, never a detection: finishing still wants every part.
    assert anchors["detected"] is False
    assert anchors["validation"] == {
        "ok": True,
        "reasons": [],
        "warnings": [],
        "detected": False,
        "one_click": False,
    }
    assert len(anchors["base"]) == 478
    assert ("left_pupil" in anchors["marks"]) is (face_type == "cartoon")
    assert "mouth_line" in anchors["marks"] and "chin" in anchors["marks"]
    # The model names the head's edges; the outline between them opens
    # where the fit of those edges put it, so all eight handles are there.
    assert set(anchors["marks"]["head"]) == {"left", "right", "top", "bottom", *HEAD_DIAGONALS}
    # The base is the template over the head the model found.
    base = np.array(anchors["base"])
    assert base[:, 0].min() == pytest.approx(anchors["marks"]["head"]["left"]["x"], abs=3)


def test_a_fit_the_validator_refuses_is_not_used():
    face = face_in_pixels()
    crossed = dict(face)
    # The mouth line wider than the head, crossing over the cheeks.
    crossed["mouth_left"] = (face["head_left"][0] - 40, face["mouth_left"][1])
    crossed["mouth_right"] = (face["head_right"][0] + 40, face["mouth_right"][1])
    result = vp.anchors_from_points(answer_for(crossed, "animal"), SIZE, "animal")
    assert result.anchors is None and result.problems


def test_the_request_never_asks_for_the_thinking_level_the_model_rejects():
    """gemini-3.8-flash answers thinkingLevel "minimal" with a 400, which made
    every AI points request fail in production; "low" is accepted (checked
    against the real model, 2026-10-03)."""
    request = vp.build_request("animal", b"x", "image/jpeg")
    assert request["generationConfig"]["thinkingConfig"] == {"thinkingLevel": "low"}
