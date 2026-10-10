"""The AI expression pictures through the API: the choice, Make, Remove,
Publish (now and as a batch), Discard, the sweeper's collection, and the
kit following a crop.

No provider and no MediaPipe: `ExpressionWorld` runs the real
build_expressions with test_expression_kit's FakeEditor and scene on the
very picture and points each job hands it (as test_mouth_kit's KitWorld
does for the mouth kit); `Faces` stands in for MediaPipe in the wizard.
"""

from __future__ import annotations

import asyncio
import base64
import json
from datetime import UTC, datetime, timedelta

import numpy as np
import pytest
from sqlalchemy import select, update

from app.db import get_session_factory
from app.models import Avatar, Organization
from app.services import expression_kit, imagegen, sweeper
from app.services import performance_kit as pk
from app.services.expression_kit import batch, batching, jobs
from app.services.expression_kit.build import build_expressions
from app.services.jobs import runner
from app.services.performance_kit.requests import load_base_image
from app.services.storage import get_storage
from app.services.usage import IMAGE_KIND
from tests.test_creation_ai import Faces, ai_consent, finish_and_wait, usage_sources, user_and_org
from tests.test_creations import create_creation
from tests.test_expression_kit import NAMES, ExpressionScene, FakeEditor, expression_points

MODEL = "fake-image-model"


class LiveScene(ExpressionScene):
    """A scene on the picture and points a job was handed."""

    def __init__(self, reference, base_png: bytes, base_points):
        self.reference = reference
        self.base_png = base_png
        self.base_image = load_base_image(base_png)
        self.base_points = np.asarray(base_points, dtype=np.float64)
        self.truth = {name: expression_points(self.base_points, name) for name in NAMES}
        self.known = {}
        self.detect_calls = 0
        self.remember(self.base_image, self.base_points)


class ExpressionWorld:
    def __init__(self, monkeypatch, reference):
        self.behaviour: dict = {}
        self.scene: LiveScene | None = None
        self.editor: FakeEditor | None = None
        self.before_answer = None
        self.builds = 0
        # A batch's answers were drawn (and their landmarks told to the
        # scene) before it is checked: its kit keeps that scene.
        self.keep_scene = False

        async def build(base_png, base_points, edit_image, **kwargs):
            self.builds += 1
            if not (self.keep_scene and self.scene is not None):
                self.scene = LiveScene(reference, base_png, base_points)
                self.editor = FakeEditor(self.scene, self.behaviour)
            kwargs.update(detect=self.scene.detect, reference=reference)
            return await build_expressions(base_png, base_points, edit_image, **kwargs)

        monkeypatch.setattr(jobs, "build_expressions", build)
        monkeypatch.setattr(batching, "build_expressions", build)
        monkeypatch.setattr(imagegen, "configured", lambda: True)
        monkeypatch.setattr(imagegen, "edit_image", self.edit)

    async def edit(self, prompt, payload, mime):
        if self.before_answer is not None:
            await self.before_answer()
        return await self.editor(prompt, payload, mime)

    @property
    def requests(self) -> list:
        return self.editor.requests if self.editor else []


@pytest.fixture(scope="module")
def reference():
    return pk.load_reference()


@pytest.fixture
def faces(monkeypatch):
    return Faces(monkeypatch)


@pytest.fixture
def world(monkeypatch, reference):
    return ExpressionWorld(monkeypatch, reference)


async def set_switch(org_id: str, enabled: bool) -> None:
    async with get_session_factory()() as db:
        await db.execute(
            update(Organization)
            .where(Organization.id == org_id)
            .values(third_party_ai_enabled=enabled)
        )
        await db.commit()


async def embed_key(client, headers, org_id) -> dict:
    key = await client.post(
        f"/orgs/{org_id}/api-keys", json={"name": "w", "allowed_domains": []}, headers=headers
    )
    return {"X-Api-Key": key.json()["plaintext"]}


async def _avatar(avatar_id: str) -> Avatar:
    async with get_session_factory()() as db:
        return (await db.execute(select(Avatar).where(Avatar.id == avatar_id))).scalar_one()


async def _published(avatar_id: str) -> dict:
    return json.loads((await _avatar(avatar_id)).published_config)


async def _person(client, who: str):
    """A person finished without AI (no mouth kit), then the member agrees:
    (headers, org id, avatar id, avatar URL, consent id)."""
    headers, org_id = await user_and_org(client, who)
    base, _ = await create_creation(client, headers, org_id)
    body = await finish_and_wait(client, headers, base)
    avatar_id = body["avatar_id"]
    url = f"/orgs/{org_id}/avatars/{avatar_id}"
    consent_id = await ai_consent(client, headers, org_id)
    return headers, org_id, avatar_id, url, consent_id


async def _get(client, headers, url) -> dict:
    response = await client.get(f"{url}/expressions", headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


async def _choose(client, headers, url, **body):
    return await client.put(f"{url}/expressions", json=body, headers=headers)


async def _make(client, headers, url, consent_id):
    return await client.post(
        f"{url}/expressions/make", json={"consent_id": consent_id}, headers=headers
    )


# --- Made from the panel --------------------------------------------------------------------


async def test_make_draws_five_pictures_as_a_draft_edit(client, faces, world):
    headers, org_id, avatar_id, url, consent_id = await _person(client, "made")
    view = await _get(client, headers, url)
    assert view == {
        "ai": False,
        "delivery": "now",
        "kit": None,
        "pending": False,
        "manifest_url": None,
        "picture_urls": {},
        "job": None,
    }
    started = await _make(client, headers, url, consent_id)
    assert started.status_code == 202, started.text
    assert started.json()["job"]["step"] == "expression_kit"
    await runner.drain()
    view = await _get(client, headers, url)
    assert view["job"]["state"] == "done" and view["job"]["error"] is None
    assert view["ai"] is True and view["kit"]["made"] == 5 and view["kit"]["source"] == "panel"
    assert set(view["picture_urls"]) == set(NAMES) and view["manifest_url"]
    assert view["kit"]["shots"]["happy"]["smile"] is True
    assert sorted(world.requests) == sorted(NAMES)
    assert await usage_sources(org_id, IMAGE_KIND) == ["expressions"] * 5
    assert consent_id in (await _avatar(avatar_id)).consent_ids
    detail = (await client.get(url, headers=headers)).json()
    assert detail["unpublished"] is True
    assert detail["ai_edited"]["expressions"] == {"model": MODEL, "made": 5}
    # Visitors get them, and the label, when the owner publishes.
    assert (await _published(avatar_id)).get("expressions") is None
    await client.post(f"{url}/publish", headers=headers)
    published = await _published(avatar_id)
    assert published["expressions"]["manifest_key"].endswith("/expressions.json")
    assert set(published["expressions"]["image_keys"]) == set(NAMES)
    assert published["disclosure"]["ai_edited"]["expressions"]["made"] == 5
    assert world.builds == 1, "a publish with pictures made asks for nothing more"
    served = (
        await client.get(
            f"/embed/v1/avatars/{avatar_id}", headers=await embed_key(client, headers, org_id)
        )
    ).json()
    assert "/published/" in served["expressions"]["manifest_url"]
    assert set(served["expressions"]["image_urls"]) == set(NAMES)
    assert served["disclosure"]["ai_edited"]["expressions"] == {"model": MODEL, "made": 5}
    manifest = json.loads(await get_storage().get_bytes(published["expressions"]["manifest_key"]))
    assert expression_kit.is_expressions_manifest(manifest)


async def test_one_job_at_a_time_and_its_progress_is_counted(client, faces, world):
    headers, _, _, url, consent_id = await _person(client, "busy-expr")
    release = asyncio.Event()

    async def hold():
        await release.wait()

    world.before_answer = hold
    assert (await _make(client, headers, url, consent_id)).status_code == 202
    again = await _make(client, headers, url, consent_id)
    assert again.status_code == 409 and again.json()["code"] == "expressions_in_progress"
    for _ in range(300):
        job = (await _get(client, headers, url))["job"]
        if (job.get("progress") or {}).get("label") == jobs.MAKING_LABEL:
            break
        await asyncio.sleep(0.01)
    assert job["state"] == "running"
    assert job["progress"]["count"] == {"done": 0, "total": 5}
    release.set()
    await runner.drain()
    assert (await _get(client, headers, url))["job"]["state"] == "done"


async def test_make_needs_consent_the_switch_a_person_and_the_limit(client, faces, world):
    headers, org_id, avatar_id, url, consent_id = await _person(client, "refused-expr")
    no_consent = await client.post(
        f"{url}/expressions/make", json={"consent_id": "x"}, headers=headers
    )
    assert no_consent.status_code == 403 and no_consent.json()["code"] == "consent_required"
    assert (await _choose(client, headers, url, ai=True)).json()["code"] == "consent_required"
    await set_switch(org_id, False)
    off = await _make(client, headers, url, consent_id)
    assert off.status_code == 403 and off.json()["code"] == "third_party_ai_disabled"
    await set_switch(org_id, True)
    async with get_session_factory()() as db:
        row = (await db.execute(select(Avatar).where(Avatar.id == avatar_id))).scalar_one()
        row.face_type = "cartoon"
        await db.commit()
    animal = await _make(client, headers, url, consent_id)
    assert animal.status_code == 422 and animal.json()["code"] == "not_a_person"
    assert world.builds == 0


async def test_a_kit_that_makes_nothing_fails_and_keeps_pictures_made_before(client, faces, world):
    headers, org_id, avatar_id, url, consent_id = await _person(client, "nothing-expr")
    world.behaviour = {name: imagegen.ImageGenNoImage("NO_IMAGE") for name in NAMES}
    await _make(client, headers, url, consent_id)
    await runner.drain()
    view = await _get(client, headers, url)
    assert view["job"]["state"] == "failed" and view["job"]["error"]["code"] == "no_image"
    assert view["kit"]["made"] == 0
    assert {s["outcome"] for s in view["kit"]["shots"].values()} == {"no_image"}
    world.behaviour = {}
    await _make(client, headers, url, consent_id)
    await runner.drain()
    assert (await _get(client, headers, url))["kit"]["made"] == 5
    world.behaviour = {name: imagegen.ImageGenNoImage("NO_IMAGE") for name in NAMES}
    await _make(client, headers, url, consent_id)
    await runner.drain()
    view = await _get(client, headers, url)
    assert view["job"]["state"] == "failed" and view["kit"]["made"] == 5


async def test_turning_off_hides_them_and_remove_deletes_them(client, faces, world):
    headers, _, avatar_id, url, consent_id = await _person(client, "off-expr")
    await _make(client, headers, url, consent_id)
    await runner.drain()
    await client.post(f"{url}/publish", headers=headers)
    off = await _choose(client, headers, url, ai=False)
    assert off.status_code == 200 and off.json()["ai"] is False and off.json()["kit"]["made"] == 5
    assert (await client.get(url, headers=headers)).json()["unpublished"] is True
    await client.post(f"{url}/publish", headers=headers)
    published = await _published(avatar_id)
    assert published["expressions"] is None
    assert published["disclosure"]["ai_edited"] is None
    on = await _choose(client, headers, url, ai=True, consent_id=consent_id)
    assert on.json()["ai"] is True
    await client.post(f"{url}/publish", headers=headers)
    assert (await _published(avatar_id))["expressions"]["image_keys"]
    keys = [
        shot["image_key"]
        for shot in (await _avatar(avatar_id)).expression_config["kit"]["shots"].values()
    ]
    removed = await client.delete(f"{url}/expressions", headers=headers)
    assert removed.status_code == 200 and removed.json()["kit"] is None
    assert removed.json()["ai"] is False
    for key in keys:
        assert not await get_storage().exists(key)
    # The published copies stay until the next publish.
    assert (await _published(avatar_id))["expressions"]["image_keys"]


async def test_discard_brings_the_published_pictures_back(client, faces, world):
    headers, _, avatar_id, url, consent_id = await _person(client, "discard-expr")
    await _make(client, headers, url, consent_id)
    await runner.drain()
    await client.post(f"{url}/publish", headers=headers)
    await client.delete(f"{url}/expressions", headers=headers)
    discarded = await client.post(f"{url}/discard-draft", headers=headers)
    assert discarded.status_code == 200, discarded.text
    view = await _get(client, headers, url)
    assert view["ai"] is True and view["kit"]["made"] == 5
    assert set(view["picture_urls"]) == set(NAMES)
    assert discarded.json()["ai_edited"]["expressions"]["made"] == 5


async def test_a_crop_moves_the_pictures_with_the_face(client, faces, world):
    headers, _, avatar_id, url, consent_id = await _person(client, "crop-expr")
    await _make(client, headers, url, consent_id)
    await runner.drain()
    before = (await _avatar(avatar_id)).expression_config["kit"]
    old = json.loads(await get_storage().get_bytes(before["manifest_key"]))
    cropped = await client.post(
        f"{url}/crop", json={"x": 0.05, "y": 0.05, "width": 0.9, "height": 0.9}, headers=headers
    )
    assert cropped.status_code == 200, cropped.text
    kit = (await _avatar(avatar_id)).expression_config["kit"]
    assert kit["manifest_key"] != before["manifest_key"] and kit["rebased_at"]
    assert not await get_storage().exists(before["manifest_key"])
    rig = json.loads(await get_storage().get_bytes((await _avatar(avatar_id)).rig_key))
    new = json.loads(await get_storage().get_bytes(kit["manifest_key"]))
    assert new["image_size"] == rig["image_size"]
    moved = np.asarray(new["expressions"]["happy"]["targets"]) - np.asarray(new["base"])
    kept = np.asarray(old["expressions"]["happy"]["targets"]) - np.asarray(old["base"])
    assert np.allclose(moved, kept, atol=0.25)
    assert world.builds == 1


# --- Made by a publish -----------------------------------------------------------------------


async def test_a_publish_with_the_choice_on_makes_and_publishes_them(client, faces, world):
    headers, org_id, avatar_id, url, consent_id = await _person(client, "publish-expr")
    chosen = await _choose(client, headers, url, ai=True, consent_id=consent_id)
    assert chosen.status_code == 200 and chosen.json()["ai"] is True
    assert (await client.get(url, headers=headers)).json()["unpublished"] is False
    await client.post(f"{url}/publish", headers=headers)
    assert (await _get(client, headers, url))["job"]["step"] == "expression_kit"
    await runner.drain()
    published = await _published(avatar_id)
    assert set(published["expressions"]["image_keys"]) == set(NAMES)
    assert published["disclosure"]["ai_edited"]["expressions"]["made"] == 5
    # The kit completed that publish: the draft is still in step with it.
    detail = (await client.get(url, headers=headers)).json()
    assert detail["unpublished"] is False
    assert (await _get(client, headers, url))["kit"]["source"] == "publish"
    # The next publish asks for nothing more.
    await client.post(f"{url}/publish", headers=headers)
    await runner.drain()
    assert world.builds == 1
    assert await usage_sources(org_id, IMAGE_KIND) == ["expressions"] * 5


async def test_a_publish_kit_finishing_after_an_edit_is_a_draft_edit(client, faces, world):
    headers, _, avatar_id, url, consent_id = await _person(client, "late-expr")
    await _choose(client, headers, url, ai=True, consent_id=consent_id)
    release = asyncio.Event()

    async def hold():
        await release.wait()

    world.before_answer = hold
    await client.post(f"{url}/publish", headers=headers)
    await client.patch(url, json={"framing": "full"}, headers=headers)
    await client.post(f"{url}/publish", headers=headers)
    release.set()
    await runner.drain()
    # Published again meanwhile: not that revision any more, so a draft edit.
    published = await _published(avatar_id)
    assert published.get("expressions") is None
    assert (await client.get(url, headers=headers)).json()["unpublished"] is True


async def test_a_publish_never_fails_for_them_and_sends_nothing_without_leave(
    client, faces, world, monkeypatch
):
    headers, org_id, avatar_id, url, consent_id = await _person(client, "nopub-expr")
    await _choose(client, headers, url, ai=True, consent_id=consent_id)
    await set_switch(org_id, False)
    published = await client.post(f"{url}/publish", headers=headers)
    assert published.status_code == 200
    await runner.drain()
    assert world.builds == 0 and (await _get(client, headers, url))["job"] is None
    await set_switch(org_id, True)
    monkeypatch.setattr(imagegen, "configured", lambda: False)
    assert (await client.post(f"{url}/publish", headers=headers)).status_code == 200
    await runner.drain()
    assert world.builds == 0


# --- As a batch ------------------------------------------------------------------------------


class FakeBatches:
    """Gemini's batch mode: submit keeps the requests, poll answers each by
    the FakeEditor (its image as generateContent would send it)."""

    def __init__(self, monkeypatch, world: ExpressionWorld, reference):
        self.world = world
        self.reference = reference
        self.sent: dict[str, dict] = {}
        self.state = batch.SUCCEEDED
        monkeypatch.setattr(batch, "submit", self.submit)
        monkeypatch.setattr(batch, "poll", self.poll)

    async def submit(self, name, requests):
        self.sent = dict(requests)
        return "batches/7"

    async def poll(self, name):
        if self.state != batch.SUCCEEDED:
            return batch.BatchState(self.state, {}, {})
        answers = {}
        for key, body in self.sent.items():
            parts = body["contents"][0]["parts"]
            payload = base64.b64decode(parts[1]["inline_data"]["data"])
            generated = await self.world.editor(parts[0]["text"], payload, "image/jpeg")
            data = base64.b64encode(generated.image).decode()
            answers[key] = {
                "candidates": [
                    {
                        "content": {
                            "parts": [{"inlineData": {"mimeType": "image/png", "data": data}}]
                        }
                    }
                ]
            }
        return batch.BatchState(batch.SUCCEEDED, answers, {})


async def _batch_person(client, who, world, reference):
    headers, org_id, avatar_id, url, consent_id = await _person(client, who)
    chosen = await _choose(client, headers, url, ai=True, consent_id=consent_id, delivery="batch")
    assert chosen.json()["delivery"] == "batch"
    await client.post(f"{url}/publish", headers=headers)
    await runner.drain()
    avatar = await _avatar(avatar_id)
    world.scene = LiveScene(
        reference,
        await get_storage().get_bytes(avatar.image_key),
        json.loads(await get_storage().get_bytes(avatar.rig_key))["points"],
    )
    world.editor = FakeEditor(world.scene)
    world.keep_scene = True
    return headers, org_id, avatar_id, url


async def test_a_batch_publish_is_collected_checked_and_published(
    client, faces, world, monkeypatch, reference
):
    batches = FakeBatches(monkeypatch, world, reference)
    headers, org_id, avatar_id, url = await _batch_person(client, "batch-expr", world, reference)
    assert set(batches.sent) == set(NAMES)
    view = await _get(client, headers, url)
    assert view["pending"] is True and view["kit"] is None
    assert await usage_sources(org_id, IMAGE_KIND) == []
    await sweeper.sweep_once()
    view = await _get(client, headers, url)
    assert view["pending"] is False and view["kit"]["made"] == 5
    assert view["kit"]["source"] == "batch"
    published = await _published(avatar_id)
    assert set(published["expressions"]["image_keys"]) == set(NAMES)
    assert await usage_sources(org_id, IMAGE_KIND) == ["expressions"] * 5
    assert (await client.get(url, headers=headers)).json()["unpublished"] is False


async def test_a_batch_running_waits_then_expires_and_a_failed_one_is_given_up(
    client, faces, world, monkeypatch, reference
):
    batches = FakeBatches(monkeypatch, world, reference)
    batches.state = batch.RUNNING
    headers, _, avatar_id, url = await _batch_person(client, "batch-wait", world, reference)
    assert await expression_kit.collect_batches() == 0
    assert (await _get(client, headers, url))["pending"] is True
    async with get_session_factory()() as db:
        row = (await db.execute(select(Avatar).where(Avatar.id == avatar_id))).scalar_one()
        config = dict(row.expression_config)
        pending = dict(config["pending"])
        pending["submitted_at"] = (datetime.now(UTC) - timedelta(hours=27)).isoformat()
        config["pending"] = pending
        row.expression_config = config
        await db.commit()
    assert await expression_kit.collect_batches() == 1
    assert (await _get(client, headers, url))["pending"] is False

    batches.state = batch.FAILED
    await client.post(f"{url}/publish", headers=headers)
    await runner.drain()
    assert (await _get(client, headers, url))["pending"] is True
    assert await expression_kit.collect_batches() == 1
    view = await _get(client, headers, url)
    assert view["pending"] is False and view["kit"] is None


async def test_a_batch_google_refuses_fails_the_job(client, faces, world, monkeypatch):
    async def refuse(name, requests):
        raise batch.BatchError("the batch was not accepted (400)")

    monkeypatch.setattr(batch, "submit", refuse)
    headers, _, _, url, consent_id = await _person(client, "batch-refused")
    await _choose(client, headers, url, ai=True, consent_id=consent_id, delivery="batch")
    await client.post(f"{url}/publish", headers=headers)
    await runner.drain()
    view = await _get(client, headers, url)
    assert view["job"]["state"] == "failed" and view["job"]["error"]["code"] == "batch_refused"
    assert view["pending"] is False
