"""The expression pictures kept, published and shown (services.expressions,
expression_kit.storing and records), the disclosure, and Gemini's batch
mode as read and written (expression_kit.batch). No database, no network:
the avatar is a plain object, storage a dict, Google an httpx MockTransport.
"""

from __future__ import annotations

import base64
import io
import json
from types import SimpleNamespace

import httpx
import numpy as np
import pytest
from PIL import Image

from app.services import disclosure, expressions, imagegen
from app.services.expression_kit import batch, storing
from app.services.expression_kit.build import ExpressionsResult, Made
from app.services.expression_kit.manifest import ExpressionEntry, build_manifest

ORG, AVATAR = "o1", "a1"
ROOT = f"orgs/{ORG}/avatars/{AVATAR}/"


class FakeStorage:
    def __init__(self):
        self.files: dict[str, bytes] = {}
        self.deleted: list[str] = []
        self.fail_list = False

    async def put_bytes(self, key, data, content_type):
        self.files[key] = data

    async def get_bytes(self, key):
        if key not in self.files:
            raise FileNotFoundError(key)
        return self.files[key]

    async def exists(self, key):
        return key in self.files

    async def presign_get(self, key):
        return f"https://cdn.test/{key}"

    async def delete(self, key):
        self.deleted.append(key)
        self.files.pop(key, None)

    async def list_names(self, prefix):
        if self.fail_list:
            raise OSError("listing failed")
        return sorted({k[len(prefix) :].split("/")[0] for k in self.files if k.startswith(prefix)})


def avatar(**more):
    values = {
        "id": AVATAR,
        "org_id": ORG,
        "image_key": f"{ROOT}source.png",
        "expression_config": None,
        "ai_edited": None,
    }
    values.update(more)
    return SimpleNamespace(**values)


def points(shift=0.0) -> np.ndarray:
    rng = np.random.default_rng(3)
    base = rng.uniform(200, 600, size=(478, 2))
    base[234] = [150, 400]
    base[454] = [650, 400]
    return base + shift


def webp() -> bytes:
    out = io.BytesIO()
    Image.new("RGB", (8, 8), (200, 150, 120)).save(out, format="WEBP")
    return out.getvalue()


def result(names=("happy", "serious"), failed=("thinking",), model="m1") -> ExpressionsResult:
    base = points()
    entries = {n: ExpressionEntry((8, 8), base, base + 1.0, n == "happy") for n in names}
    manifest = (
        build_manifest(base, (800, 800), entries, kit_id="kit1", model=model) if names else None
    )
    report = {
        n: {"status": "ok", "outcome": "generated", "reason": None, "attempts": ["face_crop"]}
        for n in names
    }
    for n in failed:
        report[n] = {
            "status": "failed",
            "outcome": "rejected",
            "reason": {"code": "expression_not_reached", "detail": "no"},
            "attempts": ["face_crop"],
        }
    return ExpressionsResult(
        kit_id="kit1",
        manifest=manifest,
        made={n: Made(webp(), entries[n]) for n in names},
        report=report,
        calls=len(names) + len(failed),
        billed_calls=len(names) + len(failed),
        call_log=[],
        model=model,
    )


PICTURE = {"image_key": f"{ROOT}source.png", "image_size": [800, 800]}


async def stored(storage, a=None, **kwargs):
    a = a or avatar()
    previous = await storing.store(
        a, storage, result(**kwargs), source="panel", picture=dict(PICTURE)
    )
    return a, previous


# --- Stored on the draft ------------------------------------------------------------------


async def test_a_kit_is_stored_with_its_files_record_and_disclosure():
    storage = FakeStorage()
    a, previous = await stored(storage)
    assert previous == []
    config = a.expression_config
    kit = config["kit"]
    assert config["ai"] is True and config["pending"] is None
    assert kit["made"] == 2 and kit["source"] == "panel" and kit["model"] == "m1"
    assert kit["shots"]["happy"]["smile"] is True and kit["shots"]["serious"]["smile"] is False
    assert kit["shots"]["thinking"] == {
        "status": "failed",
        "outcome": "rejected",
        "reason": {"code": "expression_not_reached", "detail": "no"},
        "attempts": ["face_crop"],
    }
    keys = expressions.keys(config)
    assert len(keys) == 3 and all(k in storage.files for k in keys)
    assert all(expressions.EXPR_FILE.fullmatch(k.rsplit("/", 1)[1]) for k in keys)
    assert a.ai_edited == {
        "mode": "expressions",
        "model": "m1",
        "expressions": {"model": "m1", "made": 2},
    }
    # A second kit replaces the first: its files are handed back to delete.
    _, previous = await stored(storage, a)
    assert sorted(previous) == sorted(keys)


async def test_a_kit_that_made_nothing_names_no_file_and_discloses_nothing():
    storage = FakeStorage()
    a, _ = await stored(storage, names=())
    assert a.expression_config["kit"]["made"] == 0
    assert a.expression_config["kit"]["manifest_key"] is None
    assert storage.files == {} and a.ai_edited is None
    assert not expressions.shows(a.expression_config)


async def test_the_choice_turns_visitors_pictures_on_and_off_and_keeps_the_kit():
    storage = FakeStorage()
    a, _ = await stored(storage)
    assert storing.choose(a, False) is True
    assert a.expression_config["ai"] is False and a.expression_config["kit"]["made"] == 2
    assert a.ai_edited is None
    assert storing.choose(a, False) is False
    assert storing.choose(a, True, "c1") is True
    assert a.expression_config["consent_id"] == "c1"
    assert a.ai_edited["expressions"]["made"] == 2
    fresh = avatar()
    assert storing.choose(fresh, True, "c2") is False  # nothing made yet: nothing to see
    assert expressions.wants_kit(fresh.expression_config)


async def test_removing_drops_the_files_and_the_choice_and_drop_keeps_the_choice():
    storage = FakeStorage()
    a, _ = await stored(storage)
    keys = expressions.keys(a.expression_config)
    assert sorted(storing.remove(a)) == sorted(keys)
    assert a.expression_config["ai"] is False and a.expression_config["kit"] is None
    assert storing.remove(avatar()) == []
    b, _ = await stored(storage)
    named = expressions.keys(b.expression_config)
    assert sorted(storing.drop(b)) == sorted(named)
    assert b.expression_config["ai"] is True and b.expression_config["kit"] is None
    assert storing.drop(b) == []
    assert storing.drop(avatar()) == []


async def test_the_kit_follows_new_points_and_a_crop_without_ai():
    storage = FakeStorage()
    a, _ = await stored(storage)
    old_key = a.expression_config["kit"]["manifest_key"]
    assert await storing.follow_points(a, storage, points().tolist()) == []
    replaced = await storing.follow_points(
        a, storage, (points() - [30.0, 20.0]).tolist(), [700, 760]
    )
    assert replaced == [old_key]
    kit = a.expression_config["kit"]
    assert kit["manifest_key"] != old_key and kit["rebased_at"]
    assert kit["picture"]["image_size"] == [700, 760]
    moved = json.loads(storage.files[kit["manifest_key"]])
    assert np.allclose(
        np.asarray(moved["expressions"]["happy"]["targets"]),
        points() - [30.0, 20.0] + 1.0,
        atol=0.11,
    )
    # A kit that cannot follow (its manifest gone) is dropped.
    storage.files.pop(kit["manifest_key"])
    gone = await storing.follow_points(a, storage, points().tolist())
    assert a.expression_config["kit"] is None and len(gone) == 3
    assert await storing.follow_points(avatar(), storage, points().tolist()) == []


async def test_follow_rig_tells_a_crop_from_new_marks_from_nothing():
    storage = FakeStorage()
    a, _ = await stored(storage)
    rig = {"image_size": [800, 800], "points": points().tolist()}
    assert await storing.follow_rig(a, storage, None, rig) == []
    assert await storing.follow_rig(a, storage, rig, dict(rig)) == []
    remarked = {"image_size": [800, 800], "points": (points() + 2.0).tolist()}
    assert len(await storing.follow_rig(a, storage, rig, remarked)) == 1
    cropped = {"image_size": [700, 700], "points": (points() - 5.0).tolist()}
    assert len(await storing.follow_rig(a, storage, remarked, cropped)) == 1
    assert a.expression_config["kit"]["picture"]["image_size"] == [700, 700]


# --- Views --------------------------------------------------------------------------------


async def test_the_owner_sees_the_kit_and_its_pictures_never_the_keys():
    storage = FakeStorage()
    a, _ = await stored(storage)
    view = await expressions.owner_view(a, storage, job={"id": "j"})
    assert view["ai"] is True and view["delivery"] == "now" and view["pending"] is False
    assert set(view["picture_urls"]) == {"happy", "serious"}
    assert view["manifest_url"].startswith("https://cdn.test/")
    assert view["kit"]["shots"]["thinking"]["status"] == "failed"
    assert "image_key" not in json.dumps(view["kit"])
    assert view["job"] == {"id": "j"}
    empty = await expressions.owner_view(avatar(), storage)
    assert empty["ai"] is False and empty["kit"] is None and empty["picture_urls"] == {}
    assert expressions.public_kit(None) is None


async def test_visitors_get_the_published_pictures_presigned():
    storage = FakeStorage()
    assert await expressions.visitor_view(None, storage) is None
    view = await expressions.visitor_view(
        {"manifest_key": "m.json", "image_keys": {"happy": "h.webp"}, "kit": {}}, storage
    )
    assert view == {
        "manifest_url": "https://cdn.test/m.json",
        "image_urls": {"happy": "https://cdn.test/h.webp"},
    }


def test_load_copies_and_refuses_what_is_not_a_config():
    config = {"ai": True, "kit": None}
    a = avatar(expression_config=config)
    loaded = expressions.load(a)
    assert loaded == config and loaded is not config
    assert expressions.load(avatar(expression_config="nope")) is None
    assert not expressions.wants_kit(None)
    assert not expressions.wants_kit({"ai": True, "pending": {"name": "b"}})
    assert expressions.picture_of(a, (3.0, 4.0)) == {"image_key": a.image_key, "image_size": [3, 4]}


# --- Published ----------------------------------------------------------------------------


def copier(storage, prefix):
    async def copy(source, name, ext):
        if not source or source not in storage.files:
            return None
        target = f"{prefix}/{name}.{ext}"
        storage.files[target] = storage.files[source]
        return target

    return copy


async def test_publish_copies_while_chosen_and_disclosure_follows():
    storage = FakeStorage()
    a, _ = await stored(storage)
    published = await expressions.publish_expressions(a, copier(storage, "pub"))
    assert published["manifest_key"] == "pub/expressions.json"
    assert published["image_keys"] == {
        "happy": "pub/expr-happy.webp",
        "serious": "pub/expr-serious.webp",
    }
    assert expressions.published_disclosure(None, published)["expressions"] == {
        "model": "m1",
        "made": 2,
    }
    assert expressions.published_disclosure(a.ai_edited, None) is None
    storing.choose(a, False)
    assert await expressions.publish_expressions(a, copier(storage, "pub")) is None
    storing.choose(a, True, "c")
    for key in list(storage.files):
        if key.endswith(".webp"):
            storage.files.pop(key)
    assert await expressions.publish_expressions(a, copier(storage, "pub2")) is None
    storage.files.clear()
    assert await expressions.publish_expressions(a, copier(storage, "pub3")) is None


async def test_discard_restores_the_published_kit_into_fresh_keys():
    storage = FakeStorage()
    a, _ = await stored(storage)
    published = await expressions.publish_expressions(a, copier(storage, "pub"))
    draft = {"ai": False, "consent_id": "c9", "delivery": "batch", "kit": None}

    async def restore(source, name):
        if source is None or source not in storage.files:
            return None
        key = f"{ROOT}{name}-new.{source.rsplit('.', 1)[1]}"
        storage.files[key] = storage.files[source]
        return key

    restored = await expressions.restore(published, draft, restore)
    assert (
        restored["ai"] is True
        and restored["consent_id"] == "c9"
        and restored["delivery"] == "batch"
    )
    assert restored["kit"]["manifest_key"] == f"{ROOT}expr-manifest-new.json"
    assert restored["kit"]["shots"]["happy"]["image_key"] == f"{ROOT}expr-happy-new.webp"
    assert "image_key" not in restored["kit"]["shots"]["thinking"]
    assert await expressions.restore(None, None, restore) is None
    assert (await expressions.restore(None, draft, restore))["kit"] is None
    published["manifest_key"] = "gone.json"
    assert (await expressions.restore(published, draft, restore))["kit"] is None
    del published["image_keys"]["serious"]
    published["manifest_key"] = "pub/expressions.json"
    again = await expressions.restore(published, draft, restore)
    assert "image_key" not in again["kit"]["shots"]["serious"]


async def test_the_sweep_deletes_only_unnamed_expression_files():
    storage = FakeStorage()
    a, _ = await stored(storage)
    storage.files[f"{ROOT}expr-old-happy.webp"] = b"x"
    storage.files[f"{ROOT}mouth-1.webp"] = b"y"
    await expressions.sweep_files(ROOT, storage, a.expression_config)
    assert f"{ROOT}expr-old-happy.webp" not in storage.files
    assert f"{ROOT}mouth-1.webp" in storage.files
    assert all(k in storage.files for k in expressions.keys(a.expression_config))
    storage.fail_list = True
    await expressions.sweep_files(ROOT, storage, a.expression_config)


# --- The disclosure -----------------------------------------------------------------------


def test_expressions_rank_below_the_mouths_parts_and_the_picture():
    alone = disclosure.with_ai_expressions(None, "m", 5)
    assert alone == {"mode": "expressions", "model": "m", "expressions": {"model": "m", "made": 5}}
    with_teeth = disclosure.with_ai_teeth(alone, "t")
    assert with_teeth["mode"] == "teeth" and with_teeth["expressions"]["made"] == 5
    with_shapes = disclosure.with_ai_shapes(alone, "s", 6)
    assert with_shapes["mode"] == "mouth_shapes" and with_shapes["expressions"]
    picture = disclosure.with_ai_expressions({"mode": "touchup", "model": "p"}, "m", 3)
    assert picture["mode"] == "touchup" and picture["expressions"]["made"] == 3
    assert disclosure.without_ai_expressions(alone) is None
    assert disclosure.without_ai_expressions(None) is None
    assert disclosure.without_ai_expressions(with_shapes) == {
        "mode": "mouth_shapes",
        "model": "s",
        "mouth_shapes": {"model": "s", "generated": 6},
    }


# --- Gemini's batch mode ------------------------------------------------------------------


def image_answer() -> dict:
    data = base64.b64encode(b"picture").decode()
    return {
        "candidates": [
            {"content": {"parts": [{"inlineData": {"mimeType": "image/png", "data": data}}]}}
        ]
    }


def test_the_batch_body_carries_each_request_by_key():
    body = batch.batch_body("n", {"happy": {"contents": []}, "serious": {"contents": [1]}})
    requests = body["batch"]["input_config"]["requests"]["requests"]
    assert [r["metadata"]["key"] for r in requests] == ["happy", "serious"]
    assert requests[1]["request"] == {"contents": [1]}
    assert batch.batch_url().endswith(":batchGenerateContent")
    assert (
        batch.status_url("batches/9")
        == "https://generativelanguage.googleapis.com/v1beta/batches/9"
    )


@pytest.mark.parametrize(
    "body",
    [
        {
            "metadata": {"state": "BATCH_STATE_SUCCEEDED"},
            "response": {"inlinedResponses": {"inlinedResponses": "ANSWERS"}},
        },
        {"state": "JOB_STATE_SUCCEEDED", "dest": {"inlinedResponses": "ANSWERS"}},
        {"done": True, "response": {"inlined_responses": {"inlined_responses": "ANSWERS"}}},
        {"metadata": {"state": "SUCCEEDED", "output": {"inlinedResponses": "ANSWERS"}}},
    ],
)
def test_a_succeeded_batch_is_read_from_wherever_google_puts_it(body):
    answers = [
        {"response": image_answer(), "metadata": {"key": "happy"}},
        {"error": {"code": 13}, "metadata": {"key": "serious"}},
        {"response": image_answer()},
        "junk",
    ]
    text = json.dumps(body).replace('"ANSWERS"', json.dumps(answers))
    state = batch.read_state(json.loads(text))
    assert state.state == batch.SUCCEEDED
    assert set(state.answers) == {"happy"} and state.errors == {"serious": {"code": 13}}


@pytest.mark.parametrize(
    ("body", "expected"),
    [
        ({"metadata": {"state": "JOB_STATE_RUNNING"}}, batch.RUNNING),
        ({"state": "JOB_STATE_PENDING"}, batch.RUNNING),
        ({"state": "BATCH_STATE_FAILED"}, batch.FAILED),
        ({"state": "JOB_STATE_EXPIRED"}, batch.FAILED),
        ({"metadata": {"state": "JOB_STATE_CANCELLED"}}, batch.FAILED),
        ({"error": {"message": "x"}}, batch.FAILED),
        ({}, batch.RUNNING),
    ],
)
def test_a_batch_state_is_read(body, expected):
    state = batch.read_state(body)
    assert state.state == expected and state.answers == {}


async def test_the_answers_play_as_edits():
    refused = {"promptFeedback": {"blockReason": "SAFETY"}}
    state = batch.BatchState(batch.SUCCEEDED, {"happy": image_answer(), "serious": refused}, {})
    edit = batch.answers_as_edits(state, {"happy": "P1", "serious": "P2", "thinking": "P3"})
    generated = await edit("P1", b"", "image/jpeg")
    assert generated.image == b"picture"
    with pytest.raises(imagegen.ImageGenRefused):
        await edit("P2", b"", "image/jpeg")
    with pytest.raises(imagegen.ImageGenNoImage):
        await edit("P3", b"", "image/jpeg")
    with pytest.raises(imagegen.ImageGenNoImage):
        await edit("unknown", b"", "image/jpeg")


def mock_google(monkeypatch, handler):
    real = httpx.AsyncClient

    def client(*args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(handler)
        return real(*args, **kwargs)

    monkeypatch.setattr(batch.httpx, "AsyncClient", client)
    monkeypatch.setattr(imagegen, "api_key", lambda: "k")


async def test_a_batch_is_sent_and_read_back(monkeypatch):
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((request.method, str(request.url), request.headers["x-goog-api-key"]))
        if request.method == "POST":
            sent = json.loads(request.content)
            assert sent["batch"]["display_name"] == "liveface"
            return httpx.Response(200, json={"name": "batches/42"})
        return httpx.Response(200, json={"metadata": {"state": "JOB_STATE_RUNNING"}})

    mock_google(monkeypatch, handler)
    assert await batch.submit("liveface", {"happy": {}}) == "batches/42"
    assert (await batch.poll("batches/42")).state == batch.RUNNING
    assert seen[0][0] == "POST" and seen[1][1].endswith("/v1beta/batches/42")
    assert {key for *_, key in seen} == {"k"}


@pytest.mark.parametrize(
    ("status", "body"),
    [(400, {"error": "bad"}), (200, {"metadata": {}})],
)
async def test_a_batch_google_refuses_or_names_not_is_an_error(monkeypatch, status, body):
    mock_google(monkeypatch, lambda request: httpx.Response(status, json=body))
    with pytest.raises(batch.BatchError):
        await batch.submit("n", {})


async def test_a_batch_that_cannot_be_read_is_an_error_and_no_key_sends_nothing(monkeypatch):
    mock_google(monkeypatch, lambda request: httpx.Response(500, text="no"))
    with pytest.raises(batch.BatchError):
        await batch.poll("batches/1")
    monkeypatch.setattr(imagegen, "api_key", lambda: None)
    with pytest.raises(imagegen.ImageGenUnavailable):
        await batch.submit("n", {})


def test_the_edit_request_is_the_live_one():
    body = imagegen.edit_request("p", b"abc", "image/jpeg")
    parts = body["contents"][0]["parts"]
    assert parts[0] == {"text": "p"}
    assert base64.b64decode(parts[1]["inline_data"]["data"]) == b"abc"
    assert imagegen.answer_of(image_answer()).image == b"picture"
