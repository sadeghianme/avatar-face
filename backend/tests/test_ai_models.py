"""Model ids in one place, checked without spending anything, and Gemini's
refusals told apart from its failures. No request leaves the process."""

import base64

import pytest

from app.services import ai_models, imagegen
from tests.test_vision_points import FakeGemini


def test_every_model_is_named_once_and_pinned():
    assert imagegen.MODEL == ai_models.IMAGE_MODEL
    assert set(ai_models.ALL_MODELS.values()) == {ai_models.IMAGE_MODEL, ai_models.VISION_MODEL}
    for model in ai_models.ALL_MODELS.values():
        # A hot-swapped alias would change what the prompts produce under us.
        assert "latest" not in model and "preview" not in model and model.startswith("gemini-")


async def test_verification_fetches_each_models_description_only(monkeypatch):
    monkeypatch.setattr(ai_models, "api_key", lambda: "k")
    fake = FakeGemini(monkeypatch, body={"name": "models/x"})
    result = await ai_models.verify_models()
    assert result["ok"] is True
    assert [call["url"] for call in fake.sent] == [
        f"{ai_models.API_BASE}/{ai_models.IMAGE_MODEL}",
        f"{ai_models.API_BASE}/{ai_models.VISION_MODEL}",
    ]
    assert all("json" not in call for call in fake.sent), "a GET: nothing generated"


async def test_a_retired_model_is_reported_by_name(monkeypatch, caplog):
    monkeypatch.setattr(ai_models, "api_key", lambda: "k")
    FakeGemini(monkeypatch, status=404, body={"error": {"message": "not found"}})
    result = await ai_models.verify_models()
    assert result["ok"] is False
    assert result["models"]["vision"]["model"] == ai_models.VISION_MODEL
    assert result["models"]["vision"]["error"].startswith("404")

    with caplog.at_level("ERROR", logger="liveface.ai_models"):
        await ai_models.verify_at_startup()
    assert ai_models.VISION_MODEL in caplog.text and "NOT available" in caplog.text

    key_check = await imagegen.verify_key()
    assert key_check["ok"] is False and key_check["model"] == imagegen.MODEL
    assert set(key_check["models"]) == {"image", "vision"}


async def test_without_a_key_startup_checks_nothing(monkeypatch):
    monkeypatch.setattr(ai_models, "api_key", lambda: None)
    fake = FakeGemini(monkeypatch)
    await ai_models.verify_at_startup()
    assert fake.sent == []
    assert (await imagegen.verify_key()) == {"ok": False, "error": "no API key set"}


@pytest.mark.parametrize(
    "body, reason",
    [
        ({"promptFeedback": {"blockReason": "PROHIBITED_CONTENT"}}, "PROHIBITED_CONTENT"),
        ({"candidates": [{"finishReason": "IMAGE_SAFETY", "content": {}}]}, "IMAGE_SAFETY"),
        ({"candidates": [{"finishReason": "STOP", "content": {"parts": []}}]}, None),
        ({"candidates": [{"finishReason": "OTHER"}]}, None),
        ({"promptFeedback": {"blockReason": "BLOCK_REASON_UNSPECIFIED"}}, None),
    ],
)
def test_refusals_are_named_and_other_failures_are_not(body, reason):
    assert imagegen.refusal_reason(body) == reason


async def test_a_refused_edit_raises_the_refusal_and_an_image_carries_its_model(monkeypatch):
    monkeypatch.setattr(imagegen, "api_key", lambda: "k")
    FakeGemini(monkeypatch, body={"candidates": [{"finishReason": "IMAGE_SAFETY"}]})
    with pytest.raises(imagegen.ImageGenRefused) as refused:
        await imagegen.edit_image("p", b"src", "image/jpeg")
    assert refused.value.reason == "IMAGE_SAFETY"

    image = base64.b64encode(b"png-bytes").decode()
    fake = FakeGemini(
        monkeypatch,
        body={"candidates": [{"content": {"parts": [
            {"inlineData": {"mimeType": "image/png", "data": image}}
        ]}}]},
    )
    made = await imagegen.edit_image("p", b"src", "image/jpeg")
    assert made.image == b"png-bytes" and made.model == imagegen.MODEL
    sent = fake.sent[0]["json"]["contents"][0]["parts"]
    # Sent as prepared: the crop is not shrunk or re-encoded again.
    assert base64.b64decode(sent[1]["inline_data"]["data"]) == b"src"

    await imagegen.create_image("a fox")
    assert len(fake.sent[1]["json"]["contents"][0]["parts"]) == 1


async def test_an_http_failure_is_not_a_refusal(monkeypatch):
    monkeypatch.setattr(imagegen, "api_key", lambda: "k")
    FakeGemini(monkeypatch, status=500, body={})
    with pytest.raises(RuntimeError) as failed:
        await imagegen.edit_image("p", b"src", "image/jpeg")
    assert not isinstance(failed.value, imagegen.ImageGenRefused)
    # Never answered: nothing was billed, so it is not an answered failure.
    assert not isinstance(failed.value, imagegen.ImageGenNoImage)


@pytest.mark.parametrize(
    "body, reason",
    [
        ({"candidates": [{"finishReason": "NO_IMAGE",
                          "content": {"parts": [{"text": "I can't make that image."}]}}]},
         "NO_IMAGE"),
        ({"candidates": [{"finishReason": "IMAGE_OTHER"}]}, "IMAGE_OTHER"),
        ({"candidates": [{"content": {"parts": [{"text": "Here you go"}]}}]}, None),
    ],
)
async def test_an_answer_without_an_image_is_an_answered_call(monkeypatch, body, reason):
    """A 200 with no image and no policy reason was answered, and billed:
    it must be told apart from a call that never got through."""
    monkeypatch.setattr(imagegen, "api_key", lambda: "k")
    FakeGemini(monkeypatch, body=body)
    with pytest.raises(imagegen.ImageGenNoImage) as empty:
        await imagegen.edit_image("p", b"src", "image/jpeg")
    assert empty.value.answered is True
    assert empty.value.reason == reason
    assert not isinstance(empty.value, imagegen.ImageGenRefused)
