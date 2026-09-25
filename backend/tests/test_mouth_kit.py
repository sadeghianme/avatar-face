"""Step 5, "Preparing your avatar": a person's own mouth shapes and teeth,
made at Finish and from the Mouth panel, stored as the avatar's own motion,
metered, published, disclosed, and following the avatar's later edits.

No provider and no MediaPipe. `KitWorld` gives the kit the Scene machinery
of tests.test_performance_kit on the very picture and points a finish (or
the panel's job) hands it: FakeProvider answers each pose edit with the
crop it was sent, marked, and the Scene's detector knows where the pose's
landmarks are in it (the Reference's movement, scaled to this face by its
mouth width). `Faces` stands in for MediaPipe in the wizard itself, as
everywhere in the creation tests.
"""

from __future__ import annotations

import asyncio
import io
import json
from pathlib import Path

import numpy as np
import pytest
from PIL import Image
from sqlalchemy import select, update

from app.core.config import get_settings
from app.db import get_session_factory
from app.models import Avatar, Organization
from app.services import face_template, imagegen, mouth_kit
from app.services import performance_kit as pk
from app.services.jobs import Job, runner
from app.services.storage import get_storage
from app.services.usage import IMAGE_KIND
from tests.test_creation_ai import (
    HEIGHT,
    WIDTH,
    Faces,
    FakeImages,
    _finish_and_wait,
    _org,
    _usage,
    ai_consent,
)
from tests.test_creations import _create, segmenter  # noqa: F401  (a fixture)
from tests.test_mouth_photo import FULL_CROWNS, MouthDetector
from tests.test_performance_kit import FakeProvider, Scene

MODEL = "fake-image-model"


# --- The kit's world -----------------------------------------------------------------


def isotropic_pose(shape: str, base_points: np.ndarray, reference: pk.ReferenceMotion) -> np.ndarray:
    """The Reference's `shape` on this face, scaled by mouth width alone:
    what a model that drew this person saying it would give back."""
    rest, pose = reference.rest, reference.poses[shape]
    scale = (np.linalg.norm(base_points[291] - base_points[61])
             / np.linalg.norm(rest[291] - rest[61]))
    return base_points + (pose - rest) * scale


class FinishScene(Scene):
    """A Scene on the picture and points the kit was handed."""

    def __init__(self, reference: pk.ReferenceMotion, base_png: bytes, base_points):
        self.reference = reference
        self.base_png = base_png
        self.base_image = pk._base_image(base_png)
        self.base_points = np.asarray(base_points, dtype=np.float64)
        self.truth = {s: isotropic_pose(s, self.base_points, reference) for s in pk.SHAPES}
        self.known = {}
        self.detect_calls = 0


class KitWorld:
    """build_kit with the Scene's detector and the Reference, and
    imagegen.edit_image answered by a FakeProvider on a FinishScene of the
    picture and points each kit is made from. `behaviour` is FakeProvider's;
    `before_answer`, when set, is awaited as each call arrives."""

    def __init__(self, monkeypatch, reference: pk.ReferenceMotion):
        self.reference = reference
        self.behaviour: dict = {}
        self.teeth_edge = 0.12
        self.before_answer = None
        self.scene: FinishScene | None = None
        self.provider: FakeProvider | None = None
        self.kits = 0
        real = pk.build_kit

        async def build(base_png, base_points, edit_image, **kwargs):
            self.kits += 1
            self.scene = FinishScene(reference, base_png, base_points)
            self.provider = FakeProvider(self.scene, self.behaviour, teeth_edge=self.teeth_edge)
            kwargs.update(detect=self.scene.detect, reference=reference)
            return await real(base_png, base_points, edit_image, **kwargs)

        monkeypatch.setattr(pk, "build_kit", build)
        monkeypatch.setattr(imagegen, "configured", lambda: True)
        monkeypatch.setattr(imagegen, "edit_image", self.edit)

    async def edit(self, prompt, payload, mime):
        if self.before_answer is not None:
            await self.before_answer()
        return await self.provider(prompt, payload, mime)

    @property
    def requests(self) -> list:
        return self.provider.requests if self.provider else []


@pytest.fixture(scope="module")
def reference() -> pk.ReferenceMotion:
    return pk.load_reference()


@pytest.fixture
def faces(monkeypatch):
    return Faces(monkeypatch)


@pytest.fixture
def world(monkeypatch, reference):
    return KitWorld(monkeypatch, reference)


@pytest.fixture
def images(monkeypatch):
    return FakeImages(monkeypatch)


@pytest.fixture
def mouth_detector(monkeypatch):
    return MouthDetector(monkeypatch)


# --- helpers -------------------------------------------------------------------------


async def _avatar(avatar_id: str) -> Avatar:
    async with get_session_factory()() as db:
        return (await db.execute(select(Avatar).where(Avatar.id == avatar_id))).scalar_one()


async def _config(avatar_id: str) -> dict:
    return json.loads((await _avatar(avatar_id)).mouth_config)


async def _published(avatar_id: str) -> dict:
    return json.loads((await _avatar(avatar_id)).published_config)


async def _finished(client, headers, org_id) -> tuple[str, str, str]:
    """A person finished through the wizard: (avatar id, its owner URL, the
    creation's URL)."""
    base, _ = await _create(client, headers, org_id)
    body = await _finish_and_wait(client, headers, base)
    avatar_id = body["avatar_id"]
    return avatar_id, f"/orgs/{org_id}/avatars/{avatar_id}", base


async def _manifest(key: str) -> dict:
    return json.loads(await get_storage().get_bytes(key))


def _targets(manifest: dict) -> dict[str, np.ndarray]:
    """Each pose of a kit manifest, back in the picture's pixels."""
    to_base = pk.manifest_to_base(manifest)
    return {pose["id"]: to_base(pose["points"]) for pose in manifest["poses"]}


def _path(url: str) -> str:
    return url[url.index("/storage/"):]


def _files(prefix: str) -> list[str]:
    root = Path(get_storage().root) / prefix
    if not root.exists():
        return []
    return sorted(str(p.relative_to(root)) for p in root.rglob("*") if p.is_file())


async def _set_switch(org_id: str, enabled: bool) -> None:
    async with get_session_factory()() as db:
        await db.execute(
            update(Organization).where(Organization.id == org_id)
            .values(third_party_ai_enabled=enabled)
        )
        await db.commit()


async def _embed_key(client, headers, org_id) -> dict:
    key = await client.post(
        f"/orgs/{org_id}/api-keys", json={"name": "w", "allowed_domains": []}, headers=headers
    )
    return {"X-Api-Key": key.json()["plaintext"]}


# --- At Finish -------------------------------------------------------------------------


async def test_finishing_a_person_prepares_their_own_mouth(client, faces, world):
    headers, org_id = await _org(client, "prepared")
    consent_id = await ai_consent(client, headers, org_id)
    avatar_id, url, base = await _finished(client, headers, org_id)
    avatar = await _avatar(avatar_id)
    config = json.loads(avatar.mouth_config)

    # Six pose edits of the chosen picture, each metered as a mouth shape.
    assert sorted(shape for shape, _ in world.requests) == sorted(pk.SHAPES)
    assert await _usage(org_id, IMAGE_KIND) == [mouth_kit.SHAPES_CALL] * 6

    # The avatar's own motion, beside its teeth photo.
    assert config["motion_key"].startswith(f"orgs/{org_id}/avatars/{avatar_id}/mouth-motion-")
    manifest = await _manifest(config["motion_key"])
    assert manifest["character"].startswith("avatar-v1:")
    assert [p["provenance"] for p in manifest["poses"]] == ["base"] + ["generated"] * 6
    # Its rest pose is the rig the owner confirmed.
    rig = json.loads(await get_storage().get_bytes(avatar.rig_key))
    assert np.allclose(_targets(manifest)["rest"], rig["points"], atol=1e-3)
    # The EE is the teeth photo, admitted like any mouth photo (WebP).
    assert config["teeth"] == {"source": "ai", "model": MODEL}
    assert config["oral_image_key"].endswith(".webp")
    photo = await get_storage().get_bytes(config["oral_image_key"])
    assert Image.open(io.BytesIO(photo)).format == "WEBP"
    # The profile is the kit's fit, true at the manifest's jaw range.
    assert config["profile"]["jawRange"] == manifest["jaw_range"]
    assert set(config["profile"]) == {"teethScale", "teethY", "warmth", "lipProjection",
                                      "jawRange"}
    kit = config["kit"]
    assert kit["state"] == "made" and kit["source"] == "finish"
    assert (kit["generated"], kit["retargeted"]) == (6, 0)
    assert kit["teeth"] == {"used": True, "reason": None}
    assert kit["recipe"]["prompts"] == pk.PROMPTS_VERSION and kit["model"] == MODEL
    assert kit["id"] == manifest["character"].split(":", 1)[1]

    # Disclosed, and the consent that let the pictures go is on record.
    assert avatar.ai_edited == {
        "mode": "teeth", "model": MODEL, "teeth": {"model": MODEL},
        "mouth_shapes": {"model": MODEL, "generated": 6},
    }
    assert consent_id in avatar.consent_ids
    async with get_session_factory()() as db:
        from app.models import Creation

        creation = (await db.execute(
            select(Creation).where(Creation.id == base.rsplit("/", 1)[1]))).scalar_one()
    assert consent_id in creation.consent_ids

    # The first publish carries all of it, as copies.
    published = json.loads(avatar.published_config)
    assert published["mouth"]["motion_key"] == (
        f"orgs/{org_id}/avatars/{avatar_id}/published/r0/mouth-motion.json")
    assert await _manifest(published["mouth"]["motion_key"]) == manifest
    assert published["disclosure"]["ai_edited"]["mouth_shapes"] == {"model": MODEL, "generated": 6}

    # The owner API: the draft motion signed, the kit summarised.
    detail = (await client.get(url, headers=headers)).json()
    assert detail["unpublished"] is False
    mouth = detail["mouth"]
    assert _path(mouth["motion_url"]).startswith(f"/storage/{config['motion_key']}")
    assert mouth["teeth"] == {"source": "ai", "note": None}
    assert mouth["kit"]["state"] == "made"
    assert (mouth["kit"]["generated"], mouth["kit"]["retargeted"]) == (6, 0)
    assert [s["shape"] for s in mouth["kit"]["shapes"]] == list(pk.SHAPES)
    assert all(s["provenance"] == "generated" and s["reason"] is None
               for s in mouth["kit"]["shapes"])
    assert mouth["kit"]["teeth"] == {"used": True, "reason": None}
    assert "motion_key" not in mouth and "kit" not in (mouth["kit"] or {})


async def test_visitors_fetch_the_motion_cross_origin_and_may_cache_it(client, faces, world):
    headers, org_id = await _org(client, "visited")
    await ai_consent(client, headers, org_id)
    avatar_id, url, _ = await _finished(client, headers, org_id)
    served = (await client.get(
        f"/embed/v1/avatars/{avatar_id}", headers=await _embed_key(client, headers, org_id)
    )).json()
    motion_url = served["mouth"]["motion_url"]
    assert "/published/" in motion_url

    origin = "https://shop.example"
    preflight = await client.options(
        _path(motion_url), headers={"Origin": origin, "Access-Control-Request-Method": "GET"})
    assert preflight.status_code == 204
    assert preflight.headers["access-control-allow-origin"] == origin
    fetched = await client.get(_path(motion_url), headers={"Origin": origin})
    assert fetched.status_code == 200
    assert fetched.headers["access-control-allow-origin"] == origin
    assert fetched.headers["content-type"].startswith("application/json")
    # A published copy is never written again: cached like its images.
    assert fetched.headers["cache-control"] == "private, max-age=300"
    assert fetched.json()["version"] == 2
    # The teeth photo's rig is fetched the same way, and cached the same way.
    rig = await client.get(_path(served["mouth"]["oral"]["rig_url"]), headers={"Origin": origin})
    assert rig.status_code == 200 and rig.headers["access-control-allow-origin"] == origin
    assert rig.headers["cache-control"] == "private, max-age=300"

    # The draft's JSON is revalidated (the draft rig is rewritten in place).
    detail = (await client.get(url, headers=headers)).json()
    draft = await client.get(_path(detail["mouth"]["motion_url"]), headers={"Origin": origin})
    assert draft.status_code == 200 and draft.headers["cache-control"] == "no-cache"
    draft_rig = await client.get(_path(detail["rig_url"]))
    assert draft_rig.headers["cache-control"] == "no-cache"

    # The share page's mouth names it too.
    token = (await client.post(f"{url}/share", headers=headers)).json()["share_token"]
    shared = (await client.get(f"/public/v1/avatars/{token}")).json()
    assert "/published/" in shared["mouth"]["motion_url"]


async def test_refused_shapes_are_the_references_and_every_answer_is_metered(
    client, faces, world
):
    refused = imagegen.ImageGenRefused("IMAGE_SAFETY")
    world.behaviour.update(oh=[refused, refused], th=[refused, refused])
    # A face a quarter of the frame wide, so its head crop is a real crop.
    faces.by_size[(WIDTH, HEIGHT)] = face_template.place((150, 150, 250, 270))
    headers, org_id = await _org(client, "partly")
    await ai_consent(client, headers, org_id)
    avatar_id, _, _ = await _finished(client, headers, org_id)
    config = await _config(avatar_id)
    kit = config["kit"]
    assert (kit["generated"], kit["retargeted"]) == (4, 2)
    for shape in ("oh", "th"):
        assert kit["shapes"][shape]["provenance"] == "retargeted"
        assert kit["shapes"][shape]["reason"]["code"] == "safety_refused"
        # Asked once more on the head crop, never a third time.
        assert kit["shapes"][shape]["attempts"] == [pk.FACE_CROP, pk.HEAD_CROP]
    manifest = await _manifest(config["motion_key"])
    assert [p["provenance"] for p in manifest["poses"][1:]] == [
        "generated", "generated", "generated", "retargeted", "generated", "retargeted"]
    # Every answer, refusals included, was billed and is metered.
    assert len(world.requests) == 8
    assert await _usage(org_id, IMAGE_KIND) == [mouth_kit.SHAPES_CALL] * 8
    assert (await _avatar(avatar_id)).ai_edited["mouth_shapes"] == {"model": MODEL, "generated": 4}


async def test_the_limit_reached_mid_kit_stops_it_and_metering_stays_right(
    client, faces, world, monkeypatch
):
    """Three calls fit in the month. The first three shapes go out together;
    the fourth finds three spent (or in flight) and nothing more is sent."""
    monkeypatch.setattr(get_settings(), "image_generation_monthly_limit", 3, raising=False)
    headers, org_id = await _org(client, "capped")
    await ai_consent(client, headers, org_id)
    avatar_id, _, _ = await _finished(client, headers, org_id)
    assert sorted(shape for shape, _ in world.requests) == ["aa", "ee", "oo"]
    assert await _usage(org_id, IMAGE_KIND) == [mouth_kit.SHAPES_CALL] * 3
    config = await _config(avatar_id)
    shapes = config["kit"]["shapes"]
    assert [s for s in pk.SHAPES if shapes[s]["provenance"] == "generated"] == ["aa", "ee", "oo"]
    for shape in ("oh", "fv", "th"):
        assert shapes[shape]["reason"]["code"] == "image_limit_reached"
        assert shapes[shape]["attempts"] == []
    # Its EE was among the three: the teeth are the person's own.
    assert config["teeth"]["source"] == "ai"


async def test_ai_switched_off_mid_kit_sends_nothing_more(client, faces, world):
    headers, org_id = await _org(client, "switched")
    await ai_consent(client, headers, org_id)
    arrived = 0
    all_in = asyncio.Event()

    async def switch_off_once_three_are_out():
        # The owner turns AI off while the first three calls are out.
        nonlocal arrived
        arrived += 1
        if arrived == 3:
            await _set_switch(org_id, False)
            all_in.set()
        await all_in.wait()

    world.before_answer = switch_off_once_three_are_out
    avatar_id, _, _ = await _finished(client, headers, org_id)
    assert len(world.requests) == 3
    assert await _usage(org_id, IMAGE_KIND) == [mouth_kit.SHAPES_CALL] * 3
    shapes = (await _config(avatar_id))["kit"]["shapes"]
    assert {s: shapes[s]["reason"]["code"] for s in ("oh", "fv", "th")} == dict.fromkeys(
        ("oh", "fv", "th"), "third_party_ai_disabled")


async def test_without_consent_nothing_is_made_and_the_bundled_motion_plays(
    client, faces, world
):
    headers, org_id = await _org(client, "unconsented")
    avatar_id, url, _ = await _finished(client, headers, org_id)
    assert world.kits == 0 and world.requests == []
    assert await _usage(org_id, IMAGE_KIND) == []
    config = await _config(avatar_id)
    assert "motion_key" not in config and "kit" not in config
    assert config["teeth"]["note"]["code"] == "no_ai_consent"
    detail = (await client.get(url, headers=headers)).json()
    assert detail["mouth"]["motion_url"] is None and detail["mouth"]["kit"] is None
    published = await _published(avatar_id)
    assert "motion_key" not in published["mouth"]
    served = (await client.get(
        f"/embed/v1/avatars/{avatar_id}", headers=await _embed_key(client, headers, org_id)
    )).json()
    assert served["mouth"]["motion_url"] is None
    assert (await _avatar(avatar_id)).ai_edited is None


async def test_ai_switched_off_or_unconfigured_makes_no_kit(client, faces, world, monkeypatch):
    headers, org_id = await _org(client, "offline")
    await ai_consent(client, headers, org_id)
    await _set_switch(org_id, False)
    avatar_id, _, _ = await _finished(client, headers, org_id)
    assert world.kits == 0
    assert (await _config(avatar_id))["teeth"]["note"]["code"] == "third_party_ai_disabled"

    await _set_switch(org_id, True)
    monkeypatch.setattr(imagegen, "configured", lambda: False)
    avatar_id, _, _ = await _finished(client, headers, org_id)
    assert world.kits == 0
    assert (await _config(avatar_id))["teeth"]["note"]["code"] == "imagegen_unavailable"


async def test_where_the_kit_cannot_be_made_the_teeth_are_made_alone(
    client, faces, images, mouth_detector
):
    """No face detector for the kit's registration (the default here): the
    single "ee" photo, so the person still gets their teeth."""
    headers, org_id = await _org(client, "teethonly")
    await ai_consent(client, headers, org_id)
    images.script = [FULL_CROWNS]
    avatar_id, url, _ = await _finished(client, headers, org_id)
    config = await _config(avatar_id)
    assert config["teeth"] == {"source": "ai", "model": imagegen.MODEL}
    assert "motion_key" not in config and "kit" not in config
    assert await _usage(org_id, IMAGE_KIND) == ["teeth"]
    assert (await _avatar(avatar_id)).ai_edited["mode"] == "teeth"
    assert "mouth_shapes" not in (await _avatar(avatar_id)).ai_edited


async def test_a_kit_that_breaks_never_fails_the_finish(client, faces, world, monkeypatch):
    """The kit fails after its calls (its fit breaks): the avatar is
    finished with standard teeth and the bundled motion, and every call it
    sent was metered as it came back."""

    def broken(*args, **kwargs):
        raise RuntimeError("the fit broke")

    monkeypatch.setattr(pk, "_finish", broken)
    headers, org_id = await _org(client, "broken")
    await ai_consent(client, headers, org_id)
    avatar_id, _, _ = await _finished(client, headers, org_id)
    config = await _config(avatar_id)
    assert config["teeth"]["note"]["code"] == "teeth_failed"
    assert "motion_key" not in config and "oral_image_key" not in config
    assert await _usage(org_id, IMAGE_KIND) == [mouth_kit.SHAPES_CALL] * 6
    avatar = await _avatar(avatar_id)
    assert avatar.ai_edited is None and avatar.published_config


async def test_a_kit_with_no_shape_of_its_own_discloses_none(client, faces, world):
    refused = imagegen.ImageGenRefused("IMAGE_SAFETY")
    world.behaviour.update({shape: [refused, refused] for shape in pk.SHAPES})
    headers, org_id = await _org(client, "allrefused")
    await ai_consent(client, headers, org_id)
    avatar_id, _, _ = await _finished(client, headers, org_id)
    config = await _config(avatar_id)
    # Stored all the same: the Reference's shapes, fitted to this face.
    manifest = await _manifest(config["motion_key"])
    assert [p["provenance"] for p in manifest["poses"][1:]] == ["retargeted"] * 6
    assert config["kit"]["generated"] == 0
    assert config["teeth"]["source"] is None
    assert config["teeth"]["note"]["code"] == "safety_refused"
    assert config["kit"]["teeth"]["reason"]["code"] == "safety_refused"
    assert (await _avatar(avatar_id)).ai_edited is None, "nothing AI-made is shown"


async def test_the_kit_waits_outside_the_runners_slot_and_counts_its_shapes(
    client, faces, world, monkeypatch
):
    slots: list[bool] = []

    async def finish_holds_no_slot():
        job = next(j for j in runner._jobs.values() if j.step == "finish")
        slots.append(job.holds_slot)

    world.before_answer = finish_holds_no_slot
    reports: list[tuple[str | None, tuple | None]] = []
    real = Job.report

    def spy(self, fraction, label=None, count=None):
        if self.step == "finish":
            reports.append((label, count))
        return real(self, fraction, label, count)

    monkeypatch.setattr(Job, "report", spy)
    headers, org_id = await _org(client, "slotless")
    await ai_consent(client, headers, org_id)
    await _finished(client, headers, org_id)
    assert slots == [False] * 6
    counts = [count for label, count in reports if label == mouth_kit.SHAPES_LABEL]
    assert counts[0] == (0, 6) and counts[-1] == (5, 6)
    assert [done for done, _ in counts] == sorted(done for done, _ in counts)
    stages = [label for label, _ in reports if label]
    assert stages.index(mouth_kit.SHAPES_LABEL) < stages.index(mouth_kit.FIT_LABEL)
    assert stages[-1] == "publishing"
    assert (mouth_kit.FIT_LABEL, None) in reports


async def test_a_running_finish_shows_how_many_shapes_are_done(client, faces, world):
    """JobOut.progress: the label and, for the shapes, a count."""
    from tests.test_creations import _detect, _get, depiction

    release = asyncio.Event()

    async def hold():
        await release.wait()

    world.before_answer = hold
    headers, org_id = await _org(client, "watched")
    await ai_consent(client, headers, org_id)
    base, _ = await _create(client, headers, org_id)
    anchors = await _detect(client, headers, base)
    started = await client.post(f"{base}/finish", headers=headers, json={
        "name": "Ada", "anchors_id": anchors["id"],
        "consent_id": await depiction(client, headers, base),
    })
    assert started.status_code == 202, started.text
    for _ in range(200):
        progress = ((await _get(client, headers, base))["job"] or {}).get("progress") or {}
        if progress.get("label") == mouth_kit.SHAPES_LABEL:
            break
        await asyncio.sleep(0.01)
    assert progress["label"] == "making the mouth shapes"
    assert progress["count"] == {"done": 0, "total": 6}
    release.set()
    await runner.drain()
    assert (await _get(client, headers, base))["status"] == "finished"


# --- Publishing, Discard, pruning, deletion ------------------------------------------------


async def _later_edit(client, headers, url, teeth_y: float = 0.01):
    response = await client.patch(url, json={"mouth": {
        "renderer": "continuous", "profile": {"teethY": teeth_y}}}, headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


async def test_published_motion_copies_are_pruned_and_deleted_with_the_avatar(
    client, faces, world
):
    headers, org_id = await _org(client, "pruned")
    await ai_consent(client, headers, org_id)
    avatar_id, url, _ = await _finished(client, headers, org_id)
    prefix = f"orgs/{org_id}/avatars/{avatar_id}/"
    for revision, teeth_y in ((1, 0.01), (2, 0.02)):
        await _later_edit(client, headers, url, teeth_y)
        assert (await client.post(f"{url}/publish", headers=headers)).status_code == 200
    files = _files(prefix)
    assert "published/r0/mouth-motion.json" not in files, "pruned with its revision"
    assert {"published/r1/mouth-motion.json", "published/r2/mouth-motion.json"} <= set(files)
    assert (await client.delete(url, headers=headers)).status_code == 204
    assert _files(prefix) == []


async def test_discard_brings_the_published_motion_back_labelled(client, faces, world):
    headers, org_id = await _org(client, "discarded")
    await ai_consent(client, headers, org_id)
    avatar_id, url, _ = await _finished(client, headers, org_id)
    published = await _published(avatar_id)
    # A crop drops the kit from the draft (a new picture) ...
    cropped = await client.post(f"{url}/crop", json={"x": 0.05, "y": 0.05, "width": 0.9,
                                                     "height": 0.9}, headers=headers)
    assert cropped.status_code == 200, cropped.text
    assert cropped.json()["mouth"]["motion_url"] is None
    assert "mouth_shapes" not in cropped.json()["ai_edited"]
    # ... and Discard brings back what visitors have: the motion, into a
    # fresh draft key, with its record and its label.
    discarded = await client.post(f"{url}/discard-draft", headers=headers)
    assert discarded.status_code == 200, discarded.text
    body = discarded.json()
    config = await _config(avatar_id)
    assert config["motion_key"] != published["mouth"]["motion_key"]
    assert "/published/" not in config["motion_key"]
    assert await _manifest(config["motion_key"]) == await _manifest(
        published["mouth"]["motion_key"])
    assert config["kit"]["state"] == "made"
    assert body["mouth"]["kit"]["state"] == "made" and body["mouth"]["motion_url"]
    assert body["ai_edited"]["mouth_shapes"] == {"model": MODEL, "generated": 6}


async def test_the_shapes_are_disclosed_only_while_visitors_see_them(client, faces, world):
    headers, org_id = await _org(client, "classic")
    await ai_consent(client, headers, org_id)
    avatar_id, url, _ = await _finished(client, headers, org_id)
    await client.patch(url, json={"mouth": {"renderer": "classic"}}, headers=headers)
    await client.post(f"{url}/publish", headers=headers)
    assert (await _published(avatar_id))["disclosure"]["ai_edited"] is None
    assert (await _avatar(avatar_id)).ai_edited["mouth_shapes"]["generated"] == 6, (
        "the draft keeps it with the motion")
    await _later_edit(client, headers, url)
    await client.post(f"{url}/publish", headers=headers)
    assert (await _published(avatar_id))["disclosure"]["ai_edited"]["mouth_shapes"] == {
        "model": MODEL, "generated": 6}


def test_the_disclosure_algebra_keeps_mouth_modes_right():
    from app.services.mouth_photo import with_ai_teeth, without_ai_teeth

    shapes = mouth_kit.with_ai_shapes(None, "m", 4)
    assert shapes == {"mode": "mouth_shapes", "model": "m",
                      "mouth_shapes": {"model": "m", "generated": 4}}
    both = with_ai_teeth(shapes, "t")
    assert both["mode"] == "teeth" and both["model"] == "t" and both["mouth_shapes"]["generated"] == 4
    assert without_ai_teeth(both) == shapes
    assert mouth_kit.without_ai_shapes(both) == {"mode": "teeth", "model": "t",
                                                 "teeth": {"model": "t"}}
    assert mouth_kit.without_ai_shapes(shapes) is None
    touched = {"mode": "touchup", "model": "p"}
    assert mouth_kit.with_ai_shapes(touched, "m", 6) == {**touched, "mouth_shapes": {
        "model": "m", "generated": 6}}
    assert mouth_kit.without_ai_shapes(mouth_kit.with_ai_shapes(touched, "m", 6)) == touched


# --- Later edits: re-marked points, a new picture -----------------------------------------


async def test_re_marked_points_move_the_kit_without_ai(client, faces, world):
    headers, org_id = await _org(client, "remarked")
    await ai_consent(client, headers, org_id)
    avatar_id, url, _ = await _finished(client, headers, org_id)
    before = await _config(avatar_id)
    old = await _manifest(before["motion_key"])
    calls = len(world.requests)

    anchors = (await client.get(f"{url}/rig-anchors", headers=headers)).json()["anchors"]
    mouth = anchors["mouth"]
    mouth["left"]["x"] -= 3
    mouth["right"]["x"] += 3
    saved = await client.post(f"{url}/rig-fit", json={"mouth": mouth, "persist": True},
                              headers=headers)
    assert saved.status_code == 200, saved.text
    rig = saved.json()["rig"]

    after = await _config(avatar_id)
    assert after["motion_key"] != before["motion_key"]
    assert not await get_storage().exists(before["motion_key"]), "the old draft file is gone"
    new = await _manifest(after["motion_key"])
    old_targets, new_targets = _targets(old), _targets(new)
    assert np.allclose(new_targets["rest"], rig["points"], atol=1e-3)
    assert not np.allclose(new_targets["rest"], old_targets["rest"], atol=1e-3)
    for shape in pk.SHAPES:
        assert np.allclose(new_targets[shape] - new_targets["rest"],
                           old_targets[shape] - old_targets["rest"], atol=1e-3), shape
    assert new["character"] == old["character"] and new["kit"] == old["kit"]
    assert after["kit"]["rebased_at"]
    assert len(world.requests) == calls, "no AI call"
    assert (await client.get(url, headers=headers)).json()["unpublished"] is True


async def test_a_redetection_of_the_same_picture_moves_the_kit_too(client, faces, world):
    """Re-detect (process_avatar) rebuilds the rig on the same picture: here
    without a landmark model, from the synthetic mesh, whose points are not
    the ones the owner confirmed at Finish."""
    headers, org_id = await _org(client, "redetected")
    await ai_consent(client, headers, org_id)
    avatar_id, url, _ = await _finished(client, headers, org_id)
    before = await _config(avatar_id)
    reset = await client.post(f"{url}/rig-reset", headers=headers)
    assert reset.status_code == 200, reset.text
    avatar = await _avatar(avatar_id)
    rig = json.loads(await get_storage().get_bytes(avatar.rig_key))
    after = json.loads(avatar.mouth_config)
    assert after["motion_key"] != before["motion_key"]
    assert np.allclose(_targets(await _manifest(after["motion_key"]))["rest"], rig["points"],
                       atol=1e-3)


async def test_a_new_picture_drops_the_kit_and_keeps_the_teeth(client, faces, world):
    headers, org_id = await _org(client, "recropped")
    consent_id = await ai_consent(client, headers, org_id)
    avatar_id, url, _ = await _finished(client, headers, org_id)
    before = await _config(avatar_id)
    cropped = await client.post(f"{url}/crop", json={"x": 0.05, "y": 0.05, "width": 0.9,
                                                     "height": 0.9}, headers=headers)
    assert cropped.status_code == 200, cropped.text
    config = await _config(avatar_id)
    assert "motion_key" not in config
    assert not await get_storage().exists(before["motion_key"])
    assert config["kit"]["state"] == "dropped"
    assert config["kit"]["dropped"]["code"] == "picture_changed"
    # The teeth photo is the person's, whatever the portrait: it stays.
    assert config["oral_image_key"] == before["oral_image_key"]
    assert config["teeth"]["source"] == "ai"
    body = cropped.json()
    assert body["mouth"]["kit"]["state"] == "dropped" and body["mouth"]["motion_url"] is None
    assert body["ai_edited"] == {"mode": "teeth", "model": MODEL, "teeth": {"model": MODEL}}
    # Published, visitors get the bundled motion, and no shapes label.
    await client.post(f"{url}/publish", headers=headers)
    published = await _published(avatar_id)
    assert "motion_key" not in published["mouth"]
    assert "mouth_shapes" not in published["disclosure"]["ai_edited"]
    # Undoing the crop puts another picture back: nothing of the kit returns
    # by itself; the Mouth panel makes it again for the picture there is.
    undone = await client.post(f"{url}/undo", headers=headers)
    assert undone.status_code == 200 and undone.json()["mouth"]["motion_url"] is None
    made = await client.post(f"{url}/mouth-kit", json={"consent_id": consent_id},
                             headers=headers)
    assert made.status_code == 202, made.text
    await runner.drain()
    assert (await _config(avatar_id))["kit"]["state"] == "made"


@pytest.mark.usefixtures("segmenter")
async def test_a_background_change_and_its_undo_keep_the_kit(client, faces, world):
    """A cut-out moves no pixel of the face: the kit stays through it, and
    through undoing it."""
    headers, org_id = await _org(client, "cutout")
    await ai_consent(client, headers, org_id)
    avatar_id, url, _ = await _finished(client, headers, org_id)
    before = await _config(avatar_id)
    removed = await client.post(f"{url}/background", json={"remove": True}, headers=headers)
    assert removed.status_code == 200, removed.text
    assert removed.json()["original_image_key"], "cut out"
    assert (await _config(avatar_id))["motion_key"] == before["motion_key"]
    undone = await client.post(f"{url}/undo", headers=headers)
    assert undone.status_code == 200, undone.text
    after = await _config(avatar_id)
    assert after["motion_key"] == before["motion_key"] and after["kit"]["state"] == "made"
    assert undone.json()["mouth"]["motion_url"]
    assert await get_storage().exists(before["motion_key"])


async def test_undoing_a_background_change_keeps_the_kit_and_a_crop_drops_it():
    """mouth_kit.follow_rig, as undo uses it: the same rig changes nothing;
    a rig for another picture size is another picture."""
    from types import SimpleNamespace

    row = SimpleNamespace(
        id="a", org_id="o",
        ai_edited={"mode": "mouth_shapes", "model": "m",
                   "mouth_shapes": {"model": "m", "generated": 6}},
        mouth_config=json.dumps({"renderer": "continuous", "profile": {},
                                 "motion_key": "orgs/o/avatars/a/mouth-motion-1.json",
                                 "kit": {"state": "made"}}),
    )
    rig = {"image_size": [400, 500], "points": [[1.0, 2.0]] * 478}
    assert await mouth_kit.follow_rig(row, None, rig, dict(rig)) == []
    assert json.loads(row.mouth_config)["motion_key"]
    other = await mouth_kit.follow_rig(row, None, rig, {**rig, "image_size": [360, 450]})
    assert other == ["orgs/o/avatars/a/mouth-motion-1.json"]
    config = json.loads(row.mouth_config)
    assert "motion_key" not in config and config["kit"]["state"] == "dropped"
    assert config["kit"]["dropped"]["code"] == "picture_changed"
    assert row.ai_edited is None


# --- The Mouth panel's action ----------------------------------------------------------------


async def _panel_person(client, who) -> tuple[dict, str, str, str]:
    """A person finished before AI was allowed (no kit), then the member
    agrees: (headers, org id, avatar URL, consent id)."""
    headers, org_id = await _org(client, who)
    avatar_id, url, _ = await _finished(client, headers, org_id)
    return headers, org_id, url, await ai_consent(client, headers, org_id)


async def _start(client, headers, url, consent_id):
    return await client.post(f"{url}/mouth-kit", json={"consent_id": consent_id},
                             headers=headers)


async def _job(client, headers, url) -> dict | None:
    response = await client.get(f"{url}/mouth-kit", headers=headers)
    assert response.status_code == 200, response.text
    return response.json()["job"]


async def test_the_mouth_panel_makes_the_kit_as_a_draft_edit(client, faces, world):
    headers, org_id, url, consent_id = await _panel_person(client, "panel")
    avatar_id = url.rsplit("/", 1)[1]
    assert await _job(client, headers, url) is None
    started = await _start(client, headers, url, consent_id)
    assert started.status_code == 202, started.text
    job = started.json()["job"]
    assert job["step"] == "mouth_kit" and job["state"] == "queued"
    await runner.drain()
    ended = await _job(client, headers, url)
    assert ended["id"] == job["id"] and ended["state"] == "done" and ended["error"] is None

    detail = (await client.get(url, headers=headers)).json()
    assert detail["unpublished"] is True
    assert detail["mouth"]["kit"]["generated"] == 6
    assert detail["mouth"]["teeth"]["source"] == "ai"
    assert detail["mouth"]["motion_url"]
    assert detail["ai_edited"]["mouth_shapes"] == {"model": MODEL, "generated": 6}
    assert (await _config(avatar_id))["kit"]["source"] == "mouth_panel"
    assert await _usage(org_id, IMAGE_KIND) == [mouth_kit.SHAPES_CALL] * 6
    assert consent_id in (await _avatar(avatar_id)).consent_ids
    # Visitors get nothing new until the owner publishes.
    published = await _published(avatar_id)
    assert "motion_key" not in published["mouth"]
    assert published["disclosure"]["ai_edited"] is None
    await client.post(f"{url}/publish", headers=headers)
    published = await _published(avatar_id)
    assert published["mouth"]["motion_key"].endswith("/mouth-motion.json")
    assert published["disclosure"]["ai_edited"]["mouth_shapes"]["generated"] == 6


async def test_one_kit_at_a_time_and_its_progress_is_counted(client, faces, world):
    headers, _, url, consent_id = await _panel_person(client, "busy")
    release = asyncio.Event()

    async def hold():
        await release.wait()

    world.before_answer = hold
    assert (await _start(client, headers, url, consent_id)).status_code == 202
    again = await _start(client, headers, url, consent_id)
    assert again.status_code == 409 and again.json()["code"] == "mouth_kit_in_progress"
    for _ in range(200):
        job = await _job(client, headers, url)
        if (job.get("progress") or {}).get("label") == mouth_kit.SHAPES_LABEL:
            break
        await asyncio.sleep(0.01)
    assert job["state"] == "running"
    assert job["progress"]["count"] == {"done": 0, "total": 6}
    release.set()
    await runner.drain()
    assert (await _job(client, headers, url))["state"] == "done"


async def test_the_panels_kit_needs_consent_the_switch_and_the_limit(
    client, faces, world, monkeypatch
):
    headers, org_id, url, consent_id = await _panel_person(client, "gated")
    missing = await _start(client, headers, url, "not-a-consent")
    assert missing.status_code == 403 and missing.json()["code"] == "consent_required"
    monkeypatch.setattr(get_settings(), "image_generation_monthly_limit", 0, raising=False)
    limited = await _start(client, headers, url, consent_id)
    assert limited.status_code == 429 and limited.json()["code"] == "image_limit_reached"
    monkeypatch.setattr(get_settings(), "image_generation_monthly_limit", 100, raising=False)
    await client.patch(f"/orgs/{org_id}", json={"third_party_ai_enabled": False}, headers=headers)
    off = await _start(client, headers, url, consent_id)
    assert off.status_code == 403 and off.json()["code"] == "third_party_ai_disabled"
    assert world.kits == 0 and await _usage(org_id, IMAGE_KIND) == []
    assert await _job(client, headers, url) is None


async def test_the_panels_kit_is_for_a_person_only(client, faces, world):
    headers, org_id, url, consent_id = await _panel_person(client, "petlike")
    await client.patch(url, json={"face_type": "animal"}, headers=headers)
    refused = await _start(client, headers, url, consent_id)
    assert refused.status_code == 422 and refused.json()["code"] == "mouth_not_for_face_type"


async def test_the_owners_teeth_are_never_replaced(client, faces, world, mouth_detector):
    headers, org_id, url, consent_id = await _panel_person(client, "ownteeth")
    avatar_id = url.rsplit("/", 1)[1]
    uploaded = await client.post(f"{url}/mouth-photo", files={
        "file": ("ee.png", FULL_CROWNS, "image/png")}, headers=headers)
    assert uploaded.status_code == 200, uploaded.text
    await _later_edit(client, headers, url, teeth_y=0.03)
    before = await _config(avatar_id)

    assert (await _start(client, headers, url, consent_id)).status_code == 202
    await runner.drain()
    assert (await _job(client, headers, url))["state"] == "done"
    after = await _config(avatar_id)
    assert after["oral_image_key"] == before["oral_image_key"]
    assert after["teeth"] == {"source": "upload"}
    # Its shapes and its jaw range; the teeth fit stays the owner's.
    assert after["profile"]["teethY"] == 0.03
    assert after["profile"]["jawRange"] == (await _manifest(after["motion_key"]))["jaw_range"]
    assert after["kit"]["teeth"] == {"used": False, "reason": mouth_kit.OWNER_PHOTO}
    ai_edited = (await _avatar(avatar_id)).ai_edited
    assert ai_edited == {"mode": "mouth_shapes", "model": MODEL,
                         "mouth_shapes": {"model": MODEL, "generated": 6}}


async def test_a_kit_that_makes_nothing_fails_and_leaves_the_draft_alone(client, faces, world):
    refused = imagegen.ImageGenRefused("IMAGE_SAFETY")
    world.behaviour.update({shape: [refused, refused] for shape in pk.SHAPES})
    headers, org_id, url, consent_id = await _panel_person(client, "nothing")
    avatar_id = url.rsplit("/", 1)[1]
    before = (await _avatar(avatar_id)).mouth_config
    assert (await _start(client, headers, url, consent_id)).status_code == 202
    await runner.drain()
    job = await _job(client, headers, url)
    assert job["state"] == "failed" and job["error"]["code"] == "safety_refused"
    assert job["retryable"] is False
    assert (await _avatar(avatar_id)).mouth_config == before
    assert len(await _usage(org_id, IMAGE_KIND)) == len(world.requests), "every answer metered"


async def test_where_the_panel_cannot_make_a_kit_it_makes_the_teeth(
    client, faces, images, mouth_detector
):
    headers, org_id, url, consent_id = await _panel_person(client, "panelteeth")
    avatar_id = url.rsplit("/", 1)[1]
    images.script = [FULL_CROWNS]
    assert (await _start(client, headers, url, consent_id)).status_code == 202
    await runner.drain()
    assert (await _job(client, headers, url))["state"] == "done"
    config = await _config(avatar_id)
    assert config["teeth"] == {"source": "ai", "model": imagegen.MODEL}
    assert "motion_key" not in config
    assert await _usage(org_id, IMAGE_KIND) == ["teeth"]
    assert consent_id in (await _avatar(avatar_id)).consent_ids

    # With the owner's own teeth there is nothing it could bring.
    uploaded = await client.post(f"{url}/mouth-photo", files={
        "file": ("ee.png", FULL_CROWNS, "image/png")}, headers=headers)
    assert uploaded.status_code == 200
    assert (await _start(client, headers, url, consent_id)).status_code == 202
    await runner.drain()
    job = await _job(client, headers, url)
    assert job["state"] == "failed" and job["error"]["code"] == "landmarks_unavailable"


async def test_the_old_synchronous_teeth_route_is_gone(client, faces, world):
    headers, _, url, consent_id = await _panel_person(client, "oldroute")
    response = await client.post(f"{url}/mouth-photo/generate",
                                 json={"consent_id": consent_id}, headers=headers)
    assert response.status_code in (404, 405)


async def test_another_orgs_kit_is_not_yours(client, faces, world):
    headers, _, url, consent_id = await _panel_person(client, "ownerorg")
    other_headers, other_org = await _org(client, "stranger")
    foreign = url.replace(url.split("/")[2], other_org)
    assert (await client.get(f"{foreign}/mouth-kit", headers=other_headers)).status_code == 404
    started = await client.post(f"{foreign}/mouth-kit", json={"consent_id": consent_id},
                                headers=other_headers)
    assert started.status_code == 404


# --- The call guard ---------------------------------------------------------------------------


async def test_the_guard_meters_what_was_billed_as_the_kit_counts_it(client, monkeypatch):
    """One row per answered call, per timeout, per call cancelled in
    flight; none for a call that never reached the provider or failed
    without an answer."""
    headers, org_id = await _org(client, "guarded")
    outcomes = iter([
        None, imagegen.ImageGenRefused("SAFETY"), imagegen.ImageGenNoImage("NO_IMAGE"),
        TimeoutError(), RuntimeError("500"), imagegen.ImageGenUnavailable("no key"),
    ])

    async def provider(prompt, payload, mime):
        error = next(outcomes)
        if error is not None:
            raise error
        return imagegen.Generated(b"png", "image/png", MODEL)

    monkeypatch.setattr(imagegen, "edit_image", provider)
    sent = []

    async def on_send():
        sent.append(True)

    guard = mouth_kit.CallGuard(org_id, on_send)
    for _ in range(6):
        try:
            await guard("p", b"x", "image/jpeg")
        except (Exception, asyncio.CancelledError):
            pass
    assert sent == [True], "the consent is recorded once, before the first call"
    assert guard.sent == 6 and guard.metered == 4
    assert await _usage(org_id, IMAGE_KIND) == [mouth_kit.SHAPES_CALL] * 4


async def test_the_guard_stops_at_the_switch_before_anything_is_sent(client, monkeypatch):
    headers, org_id = await _org(client, "stopped")
    await _set_switch(org_id, False)
    called = []
    monkeypatch.setattr(imagegen, "edit_image", lambda *a: called.append(a))
    guard = mouth_kit.CallGuard(org_id, None)
    with pytest.raises(imagegen.ImageGenUnavailable) as stopped:
        await guard("p", b"x", "image/jpeg")
    assert pk.stop_reason(stopped.value)["code"] == "third_party_ai_disabled"
    assert called == [] and guard.sent == 0


def test_a_kit_whose_motion_did_not_come_back_is_restored_as_dropped():
    from app.services import publishing

    made = {"state": "made", "generated": 6, "model": "m"}
    assert publishing._restored_kit(made, True) == made
    gone = publishing._restored_kit(made, False)
    assert gone["state"] == "dropped" and gone["dropped"]["code"] == "motion_missing"
    dropped = {**made, "state": "dropped", "dropped": mouth_kit.PICTURE_CHANGED}
    assert publishing._restored_kit(dropped, False) == dropped
    assert publishing._restored_kit(None, True) is None
    # And no label for shapes that are not there.
    config = {"disclosure": {"ai_edited": {"mode": "mouth_shapes", "model": "m",
                                           "mouth_shapes": {"model": "m", "generated": 6}}}}
    assert publishing._restored_ai_edited(None, config, None, gone) is None
    assert publishing._restored_ai_edited(None, config, None, made)["mouth_shapes"] == {
        "model": "m", "generated": 6}
