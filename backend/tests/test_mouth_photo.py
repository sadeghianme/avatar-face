"""A new person's mouth: the photographic one, with their own AI-made teeth.

Finishing a person's creation gives the avatar the photographic mouth and,
when the organization allows third-party AI and the member has agreed to
send photos to Google, an "ee" photo the image model makes of them, admitted
like an uploaded mouth photo. Everything short of that publishes with the
standard teeth (the Reference's own teeth photo) and a note saying why. The Mouth panel's action
(POST /avatars/{id}/mouth-kit, a job) does the same for an existing avatar,
as a draft edit.

These are the single "ee" photo's tests: what a finish (or the panel) makes
where the performance kit cannot be made, which is the case here, with no
landmark model configured (tests.test_mouth_kit gives the kit a detector).

No provider is called: `images` (tests.test_creation_ai.FakeImages) answers
with the Reference avatar's own AI "ee" photos, oral-detail-v3 (full crowns,
which the teeth test accepts) or v2 (tips only, which it refuses), and the
portrait check's detector is told their real landmarks (`mouth_detector`),
so the teeth test runs on real pixels.
"""

from __future__ import annotations

import io
import json
from pathlib import Path

import numpy as np
import pytest
from PIL import Image
from sqlalchemy import select

from app.db import get_session_factory
from app.models import Avatar, Creation
from app.services import disclosure, face_template, imagegen, mouth_photo, portrait_photo
from app.services import performance_kit as pk
from app.services import photo_adjust as pa
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
from tests.test_creations import _create

REFERENCE = Path(__file__).resolve().parents[2] / "frontend/public/lab/reference"


def _png(name: str) -> bytes:
    out = io.BytesIO()
    Image.open(REFERENCE / f"{name}.webp").convert("RGB").save(out, format="PNG")
    return out.getvalue()


FULL_CROWNS = _png("oral-detail-v3")
TIPS_ONLY = _png("oral-detail-v2")


class MouthDetector:
    """portrait_photo's landmarking, for the two reference mouth photos:
    their real detected points, told apart by their pixels."""

    def __init__(self, monkeypatch):
        self.rigs = {}
        for name in ("oral-detail-v3", "oral-detail-v2"):
            rig = json.loads((REFERENCE / f"{name}.rig.json").read_text())
            pixel = Image.open(REFERENCE / f"{name}.webp").convert("RGB").getpixel((600, 800))
            self.rigs[pixel] = np.array(rig["points"], dtype=float)
        monkeypatch.setattr(portrait_photo, "landmarks_from_image", self.detect)

    def detect(self, data: bytes):
        image = Image.open(io.BytesIO(data)).convert("RGB")
        points = self.rigs.get(image.getpixel((600, 800)))
        if points is None:
            from app.services.rig import synthetic_face_mesh

            return synthetic_face_mesh(*image.size), None, image.size, False
        return points.copy(), None, image.size, True


@pytest.fixture
def mouth_detector(monkeypatch):
    return MouthDetector(monkeypatch)


@pytest.fixture
def faces(monkeypatch):
    return Faces(monkeypatch)


@pytest.fixture
def images(monkeypatch):
    return FakeImages(monkeypatch)


async def _avatar(avatar_id: str) -> Avatar:
    async with get_session_factory()() as db:
        return (await db.execute(select(Avatar).where(Avatar.id == avatar_id))).scalar_one()


async def _finished_person(client, headers, org_id) -> tuple[str, Avatar, dict]:
    base, _ = await _create(client, headers, org_id)
    body = await _finish_and_wait(client, headers, base)
    avatar = await _avatar(body["avatar_id"])
    return body["avatar_id"], avatar, json.loads(avatar.published_config)


# --- the admission every mouth photo passes -------------------------------------------


def test_a_full_crown_photo_is_admitted(mouth_detector):
    photo, rig = mouth_photo.prepare_mouth_photo(FULL_CROWNS)
    stored = Image.open(io.BytesIO(photo))
    assert list(stored.size) == rig["image_size"], "the rig's pixel coordinates still hold"
    assert len(rig["points"]) == 478
    # What every visitor downloads: WebP of the lips, a sliver of the
    # lossless 1254 px face.
    assert stored.format == "WEBP"
    assert max(stored.size) < 1254 / 2
    assert len(photo) < len(FULL_CROWNS) / 20


def test_a_mouth_photo_is_cut_to_what_the_renderer_reads(mouth_detector):
    """The renderer (and the teeth test) read a mouth photo inside its lips
    only. Cut to them at whole pixels, the rig moved with it, the photo
    reads exactly as the whole one does."""
    whole, whole_rig, _ = portrait_photo.prepare_photo(FULL_CROWNS, "mouth")
    cut, rig = mouth_photo.crop_to_mouth(whole, whole_rig)
    with Image.open(io.BytesIO(cut)) as image:
        assert list(image.size) == rig["image_size"] and image.width < 700
    assert mouth_photo.teeth_verdict(cut, rig) == mouth_photo.teeth_verdict(whole, whole_rig)
    offset = np.asarray(whole_rig["points"]) - np.asarray(rig["points"])
    assert np.allclose(offset, offset[0], atol=0.011) and (offset[0] == offset[0].round()).all()
    # What the renderer reads of the rig, and nothing else.
    assert set(rig) == {"version", "image_size", "points", "inner_lip_ring", "outer_lip_ring"}
    # A photo that is all mouth already is left as it is.
    assert mouth_photo.crop_to_mouth(cut, rig) == (cut, rig)


async def test_a_teeth_call_that_timed_out_is_metered_as_the_kit_meters_it(client, monkeypatch):
    """Sent, and maybe billed: performance_kit.call_billing, the one
    classification, counts httpx's read timeout (imagegen's 90 s) as a
    call; the single "ee" photo meters it too, and says it timed out."""
    import httpx

    headers, org_id = await _org(client, "tmo")

    async def slow(prompt, payload, mime):
        raise httpx.ReadTimeout("read timed out")

    monkeypatch.setattr(imagegen, "configured", lambda: True)
    monkeypatch.setattr(imagegen, "edit_image", slow)
    monkeypatch.setattr(mouth_photo, "face_request",
                        lambda source: mouth_photo.Request(b"x", "image/jpeg"))
    with pytest.raises(mouth_photo.TeethFailure) as failed:
        await mouth_photo.make_teeth(org_id, FULL_CROWNS)
    assert failed.value.code == "timeout"
    assert await _usage(org_id, IMAGE_KIND) == [mouth_photo.TEETH_CALL]

    async def unreachable(prompt, payload, mime):
        raise httpx.ConnectTimeout("never connected")

    monkeypatch.setattr(imagegen, "edit_image", unreachable)
    with pytest.raises(mouth_photo.TeethFailure) as failed:
        await mouth_photo.make_teeth(org_id, FULL_CROWNS)
    assert failed.value.code == "provider_error"
    assert await _usage(org_id, IMAGE_KIND) == [mouth_photo.TEETH_CALL], "never reached Google"


async def test_a_consent_that_cannot_be_recorded_sends_nothing(client, monkeypatch):
    headers, org_id = await _org(client, "unrecorded")
    sent = []

    async def provider(prompt, payload, mime):
        sent.append(prompt)

    async def on_send():
        raise RuntimeError("database is locked")

    monkeypatch.setattr(imagegen, "configured", lambda: True)
    monkeypatch.setattr(imagegen, "edit_image", provider)
    monkeypatch.setattr(mouth_photo, "face_request",
                        lambda source: mouth_photo.Request(b"x", "image/jpeg"))
    with pytest.raises(mouth_photo.TeethFailure) as failed:
        await mouth_photo.make_teeth(org_id, FULL_CROWNS, on_send=on_send)
    assert failed.value.code == "consent_not_recorded" and sent == []


def test_a_tips_only_photo_is_refused_as_the_browser_would(mouth_detector):
    from app.core.errors import Validation422

    with pytest.raises(Validation422) as refused:
        mouth_photo.prepare_mouth_photo(TIPS_ONLY)
    assert refused.value.code == "mouth_teeth_unclear"
    assert refused.value.extra["coverage"] < 0.10


def test_the_teeth_disclosure_is_added_and_removed_without_touching_the_rest():
    touched = {"mode": "touchup", "model": "m1"}
    both = disclosure.with_ai_teeth(touched, "m2")
    assert both == {"mode": "touchup", "model": "m1", "teeth": {"model": "m2"}}
    assert touched == {"mode": "touchup", "model": "m1"}, "a new dict"
    assert disclosure.without_ai_teeth(both) == touched
    only = disclosure.with_ai_teeth(None, "m2")
    assert only["mode"] == "teeth"
    assert disclosure.without_ai_teeth(only) is None
    assert disclosure.without_ai_teeth(None) is None


# How a mouth without a teeth photo of its own seats and sizes its teeth:
# the standard teeth are the Reference's own photo, drawn as the Reference
# draws it (performance_kit.for_standard_teeth).
STANDARD_SEAT = {"teethY": pk.REFERENCE_TEETH_Y, "teethScale": pk.REFERENCE_TEETH_SCALE}


def test_only_a_person_starts_with_the_photographic_mouth():
    """With no teeth photo of its own yet: the standard teeth, seated and
    sized as the Reference draws them."""
    assert mouth_photo.default_config("human") == {"renderer": "continuous",
                                                   "profile": STANDARD_SEAT}
    assert mouth_photo.default_config("animal") is None
    assert mouth_photo.default_config("cartoon") is None


# --- at finish --------------------------------------------------------------------------


async def test_a_person_is_finished_with_their_own_ai_teeth(
    client, faces, images, mouth_detector
):
    headers, org_id = await _org(client, "smiler")
    consent_id = await ai_consent(client, headers, org_id)
    images.script = [FULL_CROWNS]
    avatar_id, avatar, published = await _finished_person(client, headers, org_id)

    # What was sent: the touch-up's face crop of the chosen picture, and
    # the teeth prompt, once.
    assert len(images.calls) == 1
    sent = Image.open(io.BytesIO(images.calls[0]["source"]))
    assert sent.size == (pa.CROP_SIZE, pa.CROP_SIZE) and sent.format == "JPEG"
    assert images.calls[0]["prompt"] == mouth_photo.TEETH_PROMPT
    assert await _usage(org_id, IMAGE_KIND) == ["teeth"]

    # Stored as the mouth photo, and published with the avatar.
    config = json.loads(avatar.mouth_config)
    assert config["renderer"] == "continuous"
    assert config["teeth"] == {"source": "ai", "model": imagegen.MODEL}
    # Drawn where the kit's teeth photo is: at the Reference's seat.
    assert config["profile"] == STANDARD_SEAT
    assert published["mouth"]["renderer"] == "continuous"
    assert published["mouth"]["oral_image_key"].startswith(f"orgs/{org_id}/avatars/{avatar_id}/published/")
    # Disclosed to visitors, with the consent that let the photo out.
    assert avatar.ai_edited == {"mode": "teeth", "model": imagegen.MODEL,
                                "teeth": {"model": imagegen.MODEL}}
    assert published["disclosure"]["ai_edited"]["mode"] == "teeth"
    assert consent_id in avatar.consent_ids

    detail = (await client.get(f"/orgs/{org_id}/avatars/{avatar_id}", headers=headers)).json()
    assert detail["mouth"]["has_oral_photo"] is True
    assert detail["mouth"]["teeth"] == {"source": "ai", "note": None}
    assert detail["mouth_photo"]["image_url"]
    assert detail["unpublished"] is False, "the first publish carries the teeth"


async def test_without_the_members_consent_nothing_is_sent(client, faces, images):
    headers, org_id = await _org(client, "private")
    _, avatar, published = await _finished_person(client, headers, org_id)
    assert images.calls == []
    assert await _usage(org_id, IMAGE_KIND) == []
    config = json.loads(avatar.mouth_config)
    assert config["renderer"] == "continuous", "the photographic mouth, the standard teeth"
    assert config["profile"] == STANDARD_SEAT
    assert "oral_image_key" not in config
    assert config["teeth"]["source"] is None
    assert config["teeth"]["note"]["code"] == "no_ai_consent"
    assert "oral_image_key" not in published["mouth"]
    assert published["mouth"]["renderer"] == "continuous"
    assert published["mouth"]["profile"] == STANDARD_SEAT
    # The note is kept with the snapshot (for Discard), never served.
    assert published["mouth"]["teeth"]["note"]["code"] == "no_ai_consent"
    assert avatar.ai_edited is None


async def test_with_ai_switched_off_nothing_is_sent(client, faces, images):
    headers, org_id = await _org(client, "switched")
    await ai_consent(client, headers, org_id)
    await client.patch(f"/orgs/{org_id}", json={"third_party_ai_enabled": False}, headers=headers)
    _, avatar, _ = await _finished_person(client, headers, org_id)
    assert images.calls == []
    assert json.loads(avatar.mouth_config)["teeth"]["note"]["code"] == "third_party_ai_disabled"


async def test_the_monthly_image_limit_holds_the_teeth_back(client, faces, images, monkeypatch):
    from app.core.config import get_settings

    headers, org_id = await _org(client, "capped")
    await ai_consent(client, headers, org_id)
    monkeypatch.setattr(get_settings(), "image_generation_monthly_limit", 0, raising=False)
    _, avatar, _ = await _finished_person(client, headers, org_id)
    assert images.calls == []
    assert json.loads(avatar.mouth_config)["teeth"]["note"]["code"] == "image_limit_reached"


async def test_a_refusal_is_asked_once_more_on_the_head_crop(
    client, faces, images, mouth_detector
):
    headers, org_id = await _org(client, "declined")
    await ai_consent(client, headers, org_id)
    images.script = ["refuse", FULL_CROWNS]
    # A face a quarter of the frame wide, so its head crop is a real crop.
    faces.by_size[(WIDTH, HEIGHT)] = face_template.place((150, 150, 250, 270))
    _, avatar, _ = await _finished_person(client, headers, org_id)
    assert len(images.calls) == 2
    retry = Image.open(io.BytesIO(images.calls[1]["source"]))
    assert retry.size != (pa.CROP_SIZE, pa.CROP_SIZE), "a different input, not the same request"
    assert await _usage(org_id, IMAGE_KIND) == ["teeth", "teeth"], "both answers were billed"
    assert json.loads(avatar.mouth_config)["teeth"]["source"] == "ai"


async def test_a_second_refusal_publishes_the_standard_teeth(client, faces, images):
    headers, org_id = await _org(client, "refused")
    await ai_consent(client, headers, org_id)
    images.script = ["refuse"]
    faces.by_size[(WIDTH, HEIGHT)] = face_template.place((150, 150, 250, 270))
    _, avatar, published = await _finished_person(client, headers, org_id)
    assert len(images.calls) == 2, "the face crop, then the head crop; never a third time"
    teeth = json.loads(avatar.mouth_config)["teeth"]
    assert teeth["note"]["code"] == "safety_refused"
    assert "oral_image_key" not in published["mouth"]
    assert published["mouth"]["profile"] == STANDARD_SEAT
    assert avatar.ai_edited is None


async def test_a_refusal_stands_when_the_head_crop_is_the_whole_photo(client, faces, images):
    headers, org_id = await _org(client, "fullframe")
    await ai_consent(client, headers, org_id)
    images.script = ["refuse"]
    _, avatar, _ = await _finished_person(client, headers, org_id)
    assert len(images.calls) == 1, "asking again would be the same request"
    assert json.loads(avatar.mouth_config)["teeth"]["note"]["code"] == "safety_refused"


async def test_a_photo_the_teeth_test_refuses_is_not_used(client, faces, images, mouth_detector):
    headers, org_id = await _org(client, "tips")
    await ai_consent(client, headers, org_id)
    images.script = [TIPS_ONLY]
    _, avatar, published = await _finished_person(client, headers, org_id)
    teeth = json.loads(avatar.mouth_config)["teeth"]
    assert teeth["note"]["code"] == "mouth_teeth_unclear"
    assert "oral_image_key" not in published["mouth"]
    assert await _usage(org_id, IMAGE_KIND) == ["teeth"], "answered, so billed"


async def test_a_crash_while_making_teeth_never_fails_the_finish(
    client, faces, images, monkeypatch
):
    async def broken(org_id, source, on_send=None):
        raise RuntimeError("disk full")

    monkeypatch.setattr(mouth_photo, "make_teeth", broken)
    headers, org_id = await _org(client, "crashy")
    await ai_consent(client, headers, org_id)
    _, avatar, published = await _finished_person(client, headers, org_id)
    assert json.loads(avatar.mouth_config)["teeth"]["note"]["code"] == "teeth_failed"
    assert published["mouth"]["renderer"] == "continuous"


async def test_an_animal_keeps_the_classic_mouth_and_sends_nothing(client, images):
    headers, org_id = await _org(client, "petowner")
    await ai_consent(client, headers, org_id)
    base, _ = await _create(client, headers, org_id, face_type="animal")
    from tests.test_creations import _detect, _run

    anchors = await _detect(client, headers, base)
    marks = anchors["marks"]
    response = await _run(
        client, headers, "POST", f"{base}/finish",
        json={"name": "Rex", "anchors_id": anchors["id"], "marks": marks},
    )
    assert response.status_code == 202, response.text
    avatar = await _avatar(response.json()["avatar_id"])
    assert avatar.mouth_config is None
    assert json.loads(avatar.published_config)["mouth"] is None
    assert images.calls == []


# --- on an existing avatar ---------------------------------------------------------------


async def _generate(client, headers, org_id, avatar_id, consent_id) -> dict:
    """The Mouth panel's AI action, run to its end: the job as it ended.
    Without a landmark model it makes the teeth alone."""
    from app.services.jobs import runner

    url = f"/orgs/{org_id}/avatars/{avatar_id}/mouth-kit"
    started = await client.post(url, json={"consent_id": consent_id}, headers=headers)
    assert started.status_code == 202, started.text
    await runner.drain()
    return (await client.get(url, headers=headers)).json()["job"]


async def test_existing_avatars_get_ai_teeth_as_a_draft_edit(
    client, faces, images, mouth_detector
):
    headers, org_id = await _org(client, "later")
    avatar_id, avatar, published = await _finished_person(client, headers, org_id)
    assert "oral_image_key" not in published["mouth"]

    missing = await client.post(f"/orgs/{org_id}/avatars/{avatar_id}/mouth-kit",
                                json={"consent_id": "nope"}, headers=headers)
    assert missing.status_code == 403 and missing.json()["code"] == "consent_required"
    assert images.calls == []

    consent_id = await ai_consent(client, headers, org_id)
    images.script = [FULL_CROWNS]
    job = await _generate(client, headers, org_id, avatar_id, consent_id)
    assert job["state"] == "done", job
    body = (await client.get(f"/orgs/{org_id}/avatars/{avatar_id}", headers=headers)).json()
    assert body["mouth"]["teeth"] == {"source": "ai", "note": None}
    assert body["mouth"]["has_oral_photo"] is True
    assert body["unpublished"] is True
    assert body["ai_edited"]["teeth"] == {"model": imagegen.MODEL}
    assert await _usage(org_id, IMAGE_KIND) == ["teeth"]

    # Visitors see nothing new until the owner publishes.
    row = await _avatar(avatar_id)
    assert json.loads(row.published_config)["mouth"] == published["mouth"]
    assert json.loads(row.published_config)["disclosure"]["ai_edited"] is None
    await client.post(f"/orgs/{org_id}/avatars/{avatar_id}/publish", headers=headers)
    row = await _avatar(avatar_id)
    assert json.loads(row.published_config)["mouth"]["oral_image_key"]
    assert json.loads(row.published_config)["disclosure"]["ai_edited"]["mode"] == "teeth"


async def test_making_teeth_reports_why_it_could_not(client, faces, images, mouth_detector):
    headers, org_id = await _org(client, "unlucky")
    avatar_id, _, _ = await _finished_person(client, headers, org_id)
    consent_id = await ai_consent(client, headers, org_id)

    images.script = ["refuse"]
    refused = await _generate(client, headers, org_id, avatar_id, consent_id)
    assert refused["state"] == "failed" and refused["error"]["code"] == "safety_refused"

    images.calls.clear()
    images.script = [TIPS_ONLY]
    unclear = await _generate(client, headers, org_id, avatar_id, consent_id)
    assert unclear["state"] == "failed" and unclear["error"]["code"] == "mouth_teeth_unclear"
    row = await _avatar(avatar_id)
    assert "oral_image_key" not in json.loads(row.mouth_config), "the draft is untouched"


async def test_making_teeth_needs_the_server_and_a_person(client, faces, images, monkeypatch):
    headers, org_id = await _org(client, "nokey")
    avatar_id, _, _ = await _finished_person(client, headers, org_id)
    consent_id = await ai_consent(client, headers, org_id)
    url = f"/orgs/{org_id}/avatars/{avatar_id}/mouth-kit"
    monkeypatch.setattr(imagegen, "configured", lambda: False)
    response = await client.post(url, json={"consent_id": consent_id}, headers=headers)
    assert response.status_code == 409 and response.json()["code"] == "imagegen_unavailable"

    await client.patch(f"/orgs/{org_id}/avatars/{avatar_id}", json={"face_type": "animal"},
                       headers=headers)
    response = await client.post(url, json={"consent_id": consent_id}, headers=headers)
    assert response.status_code == 422 and response.json()["code"] == "mouth_not_for_face_type"
    assert images.calls == []


async def test_the_owners_own_photo_replaces_ai_teeth_and_their_disclosure(
    client, faces, images, mouth_detector
):
    headers, org_id = await _org(client, "ownteeth")
    await ai_consent(client, headers, org_id)
    images.script = [FULL_CROWNS]
    avatar_id, avatar, _ = await _finished_person(client, headers, org_id)
    assert avatar.ai_edited["mode"] == "teeth"
    url = f"/orgs/{org_id}/avatars/{avatar_id}"

    uploaded = await client.post(
        f"{url}/mouth-photo", files={"file": ("ee.png", FULL_CROWNS, "image/png")},
        headers=headers,
    )
    assert uploaded.status_code == 200, uploaded.text
    assert uploaded.json()["mouth"]["teeth"]["source"] == "upload"
    assert uploaded.json()["ai_edited"] is None

    refused = await client.post(
        f"{url}/mouth-photo", files={"file": ("ee.png", TIPS_ONLY, "image/png")}, headers=headers
    )
    assert refused.status_code == 422 and refused.json()["code"] == "mouth_teeth_unclear"

    removed = await client.delete(f"{url}/mouth-photo", headers=headers)
    assert removed.json()["mouth"]["teeth"] == {"source": None, "note": None}
    assert removed.json()["mouth"]["renderer"] == "continuous"


async def test_removing_ai_teeth_removes_their_disclosure(client, faces, images, mouth_detector):
    headers, org_id = await _org(client, "untooth")
    await ai_consent(client, headers, org_id)
    images.script = [FULL_CROWNS]
    avatar_id, _, _ = await _finished_person(client, headers, org_id)
    removed = await client.delete(f"/orgs/{org_id}/avatars/{avatar_id}/mouth-photo",
                                  headers=headers)
    assert removed.json()["ai_edited"] is None
    assert removed.json()["mouth"]["has_oral_photo"] is False


# --- the consent that let a photo out ------------------------------------------------------


async def _creation(base: str) -> Creation:
    async with get_session_factory()() as db:
        creation_id = base.rsplit("/", 1)[1]
        return (await db.execute(select(Creation).where(Creation.id == creation_id))).scalar_one()


async def test_a_refused_finish_still_records_the_consent_that_sent_the_photo(
    client, faces, images
):
    headers, org_id = await _org(client, "audited")
    consent_id = await ai_consent(client, headers, org_id)
    images.script = ["refuse"]
    faces.by_size[(WIDTH, HEIGHT)] = face_template.place((150, 150, 250, 270))
    base, _ = await _create(client, headers, org_id)
    body = await _finish_and_wait(client, headers, base)
    assert len(images.calls) == 2, "two photos went to Google"
    avatar = await _avatar(body["avatar_id"])
    assert json.loads(avatar.mouth_config)["teeth"]["note"]["code"] == "safety_refused"
    assert consent_id in avatar.consent_ids
    assert consent_id in (await _creation(base)).consent_ids


async def test_a_consent_that_sent_nothing_is_not_recorded(client, faces, images, monkeypatch):
    headers, org_id = await _org(client, "unsent")
    consent_id = await ai_consent(client, headers, org_id)
    monkeypatch.setattr(imagegen, "configured", lambda: False)
    base, _ = await _create(client, headers, org_id)
    body = await _finish_and_wait(client, headers, base)
    avatar = await _avatar(body["avatar_id"])
    assert json.loads(avatar.mouth_config)["teeth"]["note"]["code"] == "imagegen_unavailable"
    assert consent_id not in (avatar.consent_ids or [])
    assert consent_id not in ((await _creation(base)).consent_ids or [])


async def test_teeth_that_failed_still_record_the_consent_that_sent_the_photo(
    client, faces, images, mouth_detector
):
    headers, org_id = await _org(client, "audited2")
    avatar_id, avatar, _ = await _finished_person(client, headers, org_id)
    assert not avatar.consent_ids or len(avatar.consent_ids) == 1, "the depiction statement"
    consent_id = await ai_consent(client, headers, org_id)
    images.script = [TIPS_ONLY]
    unclear = await _generate(client, headers, org_id, avatar_id, consent_id)
    assert unclear["state"] == "failed"
    row = await _avatar(avatar_id)
    assert consent_id in row.consent_ids
    assert "oral_image_key" not in json.loads(row.mouth_config)
    assert row.draft_revision == avatar.draft_revision, "not a change a visitor sees"


async def test_the_teeth_are_made_outside_the_runners_slot(client, faces, images, monkeypatch):
    """Up to two image-model calls of up to 90 s: holding one of the two
    running slots through them would queue everyone else's uploads."""
    from app.services.jobs import runner

    seen = {}
    real = mouth_photo.make_teeth

    async def watched(org_id, source, on_send=None):
        job = next(j for j in runner._jobs.values() if j.step == "finish")
        seen["holds_slot"] = job.holds_slot
        return await real(org_id, source, on_send=on_send)

    monkeypatch.setattr(mouth_photo, "make_teeth", watched)
    headers, org_id = await _org(client, "slotless")
    await ai_consent(client, headers, org_id)
    images.script = ["refuse"]
    await _finished_person(client, headers, org_id)
    assert seen == {"holds_slot": False}


# --- stored for visitors -------------------------------------------------------------------


async def test_the_mouth_photo_is_stored_and_served_as_webp(
    client, faces, images, mouth_detector
):
    from app.services.storage import get_storage

    headers, org_id = await _org(client, "slim")
    await ai_consent(client, headers, org_id)
    images.script = [FULL_CROWNS]
    avatar_id, avatar, published = await _finished_person(client, headers, org_id)
    draft_key = json.loads(avatar.mouth_config)["oral_image_key"]
    published_key = published["mouth"]["oral_image_key"]
    assert draft_key.endswith(".webp") and published_key.endswith(".webp")
    data = await get_storage().get_bytes(published_key)
    assert Image.open(io.BytesIO(data)).format == "WEBP"

    detail = (await client.get(f"/orgs/{org_id}/avatars/{avatar_id}", headers=headers)).json()
    url = detail["mouth_photo"]["image_url"]
    served = await client.get(url[url.index("/storage/"):])
    assert served.status_code == 200
    assert served.headers["content-type"] == "image/webp"


# --- the disclosure follows the teeth through Publish and Discard ---------------------------


async def _publish(client, headers, url):
    response = await client.post(f"{url}/publish", headers=headers)
    assert response.status_code == 200, response.text


async def _discard(client, headers, url):
    response = await client.post(f"{url}/discard-draft", headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


async def _later_edit(client, headers, url):
    """Any edit a visitor would notice, so the next Publish writes a snapshot."""
    response = await client.patch(
        url, json={"mouth": {"renderer": "continuous", "profile": {"teethY": 0.01}}},
        headers=headers,
    )
    assert response.status_code == 200, response.text


async def _served_disclosure(avatar_id):
    return json.loads((await _avatar(avatar_id)).published_config)["disclosure"]["ai_edited"]


async def _ai_teeth_person(client, headers, org_id):
    """A person finished with AI teeth (the caller scripts the answer)."""
    await ai_consent(client, headers, org_id)
    avatar_id, avatar, published = await _finished_person(client, headers, org_id)
    assert published["disclosure"]["ai_edited"]["mode"] == "teeth"
    return avatar_id, f"/orgs/{org_id}/avatars/{avatar_id}"


async def test_discarding_an_upload_brings_ai_teeth_back_labelled(
    client, faces, images, mouth_detector
):
    headers, org_id = await _org(client, "undoupload")
    images.script = [FULL_CROWNS]
    avatar_id, url = await _ai_teeth_person(client, headers, org_id)
    uploaded = await client.post(
        f"{url}/mouth-photo", files={"file": ("ee.png", FULL_CROWNS, "image/png")},
        headers=headers,
    )
    assert uploaded.json()["ai_edited"] is None

    discarded = await _discard(client, headers, url)
    assert discarded["mouth"]["teeth"]["source"] == "ai", "not the owner's photo"
    assert discarded["mouth"]["has_oral_photo"] is True
    assert discarded["ai_edited"]["teeth"] == {"model": imagegen.MODEL}

    await _later_edit(client, headers, url)
    await _publish(client, headers, url)
    assert (await _served_disclosure(avatar_id))["mode"] == "teeth"


async def test_discarding_a_removal_brings_ai_teeth_back_labelled(
    client, faces, images, mouth_detector
):
    headers, org_id = await _org(client, "undoremove")
    images.script = [FULL_CROWNS]
    avatar_id, url = await _ai_teeth_person(client, headers, org_id)
    await client.delete(f"{url}/mouth-photo", headers=headers)

    discarded = await _discard(client, headers, url)
    assert discarded["mouth"]["teeth"]["source"] == "ai"
    assert discarded["ai_edited"]["mode"] == "teeth"
    await _later_edit(client, headers, url)
    await _publish(client, headers, url)
    assert (await _served_disclosure(avatar_id))["mode"] == "teeth"


async def test_discarding_generated_teeth_takes_their_label_with_them(
    client, faces, images, mouth_detector
):
    headers, org_id = await _org(client, "undogenerate")
    avatar_id, _, _ = await _finished_person(client, headers, org_id)
    url = f"/orgs/{org_id}/avatars/{avatar_id}"
    consent_id = await ai_consent(client, headers, org_id)
    images.script = [FULL_CROWNS]
    made = await _generate(client, headers, org_id, avatar_id, consent_id)
    assert made["state"] == "done"
    assert (await _avatar(avatar_id)).ai_edited["mode"] == "teeth"

    discarded = await _discard(client, headers, url)
    assert discarded["ai_edited"] is None
    assert discarded["mouth"]["has_oral_photo"] is False
    assert discarded["mouth"]["teeth"]["source"] is None
    await _later_edit(client, headers, url)
    await _publish(client, headers, url)
    assert await _served_disclosure(avatar_id) is None


async def test_ai_teeth_the_classic_mouth_hides_are_not_disclosed(
    client, faces, images, mouth_detector
):
    headers, org_id = await _org(client, "classic")
    images.script = [FULL_CROWNS]
    avatar_id, url = await _ai_teeth_person(client, headers, org_id)

    await client.patch(url, json={"mouth": {"renderer": "classic"}}, headers=headers)
    await _publish(client, headers, url)
    assert await _served_disclosure(avatar_id) is None, "every visible pixel is the photo"
    row = await _avatar(avatar_id)
    assert row.ai_edited["mode"] == "teeth", "the draft keeps it with the photo"

    # A Discard from here keeps the draft's photo and its label together.
    await _later_edit(client, headers, url)
    discarded = await _discard(client, headers, url)
    assert discarded["mouth"]["renderer"] == "classic"
    assert discarded["mouth"]["teeth"]["source"] == "ai"
    assert discarded["ai_edited"]["mode"] == "teeth"

    # Back to the photographic mouth: the AI teeth show again, labelled.
    await _later_edit(client, headers, url)
    await _publish(client, headers, url)
    assert (await _served_disclosure(avatar_id))["mode"] == "teeth"


async def test_other_ai_edits_stay_disclosed_under_the_classic_mouth():
    from types import SimpleNamespace

    from app.services import publishing
    from app.services.storage import get_storage

    storage = get_storage()
    await storage.put_bytes("orgs/o/avatars/a/source.png", _png("oral-detail-v3"), "image/png")
    avatar = SimpleNamespace(
        id="a", org_id="o", draft_revision=3, image_key="orgs/o/avatars/a/source.png",
        rig_key=None, thumbnail_key=None, has_layers=False, framing="face",
        face_type="human", voice=None, published_config=None,
        mouth_config=json.dumps({"renderer": "classic", "profile": {}}),
        ai_edited=disclosure.with_ai_teeth({"mode": "touchup", "model": "m1"}, "m2"),
    )
    config = await publishing.publish(avatar, storage)
    assert config["disclosure"]["ai_edited"] == {"mode": "touchup", "model": "m1"}


def test_a_snapshot_from_before_the_teeth_record_is_restored_from_its_disclosure():
    from types import SimpleNamespace

    from app.services import publishing

    ai = disclosure.with_ai_teeth(None, "m")
    labelled = {"disclosure": {"ai_edited": ai}}
    assert publishing._restored_teeth(None, labelled, True) == {"source": "ai", "model": "m"}
    assert publishing._restored_teeth(None, {"disclosure": {"ai_edited": None}}, True) == {
        "source": "upload"
    }
    assert publishing._restored_teeth(None, labelled, False) is None
    gone = {"source": "ai", "model": "m"}
    assert publishing._restored_teeth(gone, labelled, False) is None, "no photo came back"
    note = {"source": None, "note": {"code": "no_ai_consent", "detail": "x"}}
    assert publishing._restored_teeth(note, labelled, False) == note

    # Published before disclosures: the draft's own, less teeth it no longer has.
    draft = SimpleNamespace(ai_edited={"mode": "touchup", "model": "m1", "teeth": {"model": "m"}})
    assert publishing._restored_ai_edited(draft, {}, None) == {"mode": "touchup", "model": "m1"}
