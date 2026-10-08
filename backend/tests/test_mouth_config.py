"""The continuous mouth as a draft/published avatar property."""

import io

import numpy as np
import pytest
from PIL import Image

from tests.conftest import create_org, create_ready_avatar, register_and_login


@pytest.fixture
async def setup(client):
    headers = await register_and_login(client, "mouthowner")
    org_id = await create_org(client, headers)
    avatar_id = await create_ready_avatar(client, headers, org_id)
    key = await client.post(
        f"/orgs/{org_id}/api-keys", json={"name": "w", "allowed_domains": []}, headers=headers
    )
    return headers, org_id, avatar_id, {"X-Api-Key": key.json()["plaintext"]}


def _png() -> bytes:
    buffer = io.BytesIO()
    Image.fromarray(np.full((64, 64, 3), 180, dtype=np.uint8)).save(buffer, format="PNG")
    return buffer.getvalue()


@pytest.fixture
def open_mouth_photo(monkeypatch):
    """Skip real face detection, the cut to the lips and the teeth test:
    accept any image as a valid mouth photo (all three are tested on real
    pixels in test_mouth_photo)."""
    from app.services import mouth_photo, portrait_photo
    from app.services.dental_photo import Acceptance

    monkeypatch.setattr(
        portrait_photo,
        "prepare_photo",
        lambda data, purpose: (data, {"points": [], "inner_lip_ring": []}, None),
    )
    monkeypatch.setattr(
        mouth_photo,
        "teeth_verdict",
        lambda photo, rig: Acceptance(True, 400, 20000, 0.12, 0.14),
    )
    monkeypatch.setattr(mouth_photo, "crop_to_mouth", lambda png, rig: (png, rig))


async def test_existing_avatars_keep_the_classic_mouth(client, setup):
    headers, org_id, avatar_id, key = setup
    detail = (await client.get(f"/orgs/{org_id}/avatars/{avatar_id}", headers=headers)).json()
    assert detail["mouth"] is None
    served = (await client.get(f"/embed/v1/avatars/{avatar_id}", headers=key)).json()
    assert served["mouth"] is None


async def test_choosing_the_mouth_is_a_draft_until_published(client, setup):
    headers, org_id, avatar_id, key = setup
    url = f"/orgs/{org_id}/avatars/{avatar_id}"
    body = {"mouth": {"renderer": "continuous", "profile": {"teethScale": 1.1}}}
    patched = await client.patch(url, json=body, headers=headers)
    assert patched.status_code == 200
    assert patched.json()["unpublished"] is True
    assert patched.json()["mouth"]["renderer"] == "continuous"
    assert patched.json()["mouth"]["profile"]["teethScale"] == 1.1

    # Visitors still get the classic mouth.
    assert (await client.get(f"/embed/v1/avatars/{avatar_id}", headers=key)).json()["mouth"] is None

    await client.post(f"{url}/publish", headers=headers)
    served = (await client.get(f"/embed/v1/avatars/{avatar_id}", headers=key)).json()
    assert served["mouth"]["renderer"] == "continuous"
    assert served["mouth"]["profile"]["teethScale"] == 1.1
    assert served["mouth"]["oral"] is None


async def test_the_fit_profile_is_range_checked(client, setup):
    """A published config is served to strangers; the client's clamp is not
    a reason to trust it."""
    headers, org_id, avatar_id, _ = setup
    bad = {"mouth": {"renderer": "continuous", "profile": {"teethScale": 9}}}
    response = await client.patch(f"/orgs/{org_id}/avatars/{avatar_id}", json=bad, headers=headers)
    assert response.status_code == 422
    unknown = {"mouth": {"renderer": "hologram"}}
    response = await client.patch(
        f"/orgs/{org_id}/avatars/{avatar_id}", json=unknown, headers=headers
    )
    assert response.status_code == 422


async def test_the_teeth_photo_is_published_as_a_copy(client, setup, open_mouth_photo):
    headers, org_id, avatar_id, key = setup
    url = f"/orgs/{org_id}/avatars/{avatar_id}"
    uploaded = await client.post(
        f"{url}/mouth-photo", files={"file": ("ee.png", _png(), "image/png")}, headers=headers
    )
    assert uploaded.status_code == 200, uploaded.text
    assert uploaded.json()["mouth"]["has_oral_photo"] is True
    # Storage keys never leave the server.
    assert "oral_image_key" not in uploaded.json()["mouth"]
    detail = (await client.get(url, headers=headers)).json()
    assert detail["mouth_photo"]["image_url"]

    # Not visible to visitors yet.
    assert (await client.get(f"/embed/v1/avatars/{avatar_id}", headers=key)).json()["mouth"] is None

    await client.post(f"{url}/publish", headers=headers)
    served = (await client.get(f"/embed/v1/avatars/{avatar_id}", headers=key)).json()
    assert served["mouth"]["oral"]["image_url"]
    assert "/published/" in served["mouth"]["oral"]["image_url"]

    # Removing the draft photo must not reach the published snapshot.
    removed = await client.delete(f"{url}/mouth-photo", headers=headers)
    assert removed.json()["mouth"]["has_oral_photo"] is False
    still = (await client.get(f"/embed/v1/avatars/{avatar_id}", headers=key)).json()
    assert still["mouth"]["oral"]["image_url"]


async def test_discard_restores_the_published_mouth(client, setup, open_mouth_photo):
    headers, org_id, avatar_id, _ = setup
    url = f"/orgs/{org_id}/avatars/{avatar_id}"
    await client.post(
        f"{url}/mouth-photo", files={"file": ("ee.png", _png(), "image/png")}, headers=headers
    )
    await client.post(f"{url}/publish", headers=headers)
    await client.patch(url, json={"mouth": {"renderer": "classic"}}, headers=headers)
    await client.delete(f"{url}/mouth-photo", headers=headers)

    await client.post(f"{url}/discard-draft", headers=headers)
    detail = (await client.get(url, headers=headers)).json()
    assert detail["mouth"]["renderer"] == "continuous"
    assert detail["mouth"]["has_oral_photo"] is True
    assert detail["unpublished"] is False


async def test_discard_with_nothing_published_clears_a_draft_mouth(client, setup):
    headers, org_id, avatar_id, _ = setup
    url = f"/orgs/{org_id}/avatars/{avatar_id}"
    await client.patch(url, json={"mouth": {"renderer": "continuous"}}, headers=headers)
    await client.post(f"{url}/discard-draft", headers=headers)
    assert (await client.get(url, headers=headers)).json()["mouth"] is None


async def test_share_pages_carry_the_published_mouth(client, setup):
    headers, org_id, avatar_id, _ = setup
    url = f"/orgs/{org_id}/avatars/{avatar_id}"
    await client.patch(url, json={"mouth": {"renderer": "continuous"}}, headers=headers)
    await client.post(f"{url}/publish", headers=headers)
    token = (await client.post(f"{url}/share", headers=headers)).json()["share_token"]
    shared = (await client.get(f"/public/v1/avatars/{token}")).json()
    assert shared["mouth"]["renderer"] == "continuous"


async def test_another_org_cannot_touch_your_mouth_photo(client, setup, open_mouth_photo):
    headers, org_id, avatar_id, _ = setup
    other = await register_and_login(client, "mouthintruder")
    other_org = await create_org(client, other)
    response = await client.post(
        f"/orgs/{other_org}/avatars/{avatar_id}/mouth-photo",
        files={"file": ("ee.png", _png(), "image/png")},
        headers=other,
    )
    assert response.status_code == 404


async def test_a_closed_mouth_photo_is_refused(client, setup, monkeypatch):
    """The real validator's message reaches the user; nothing is stored."""
    from app.core.errors import Validation422
    from app.services import portrait_photo

    def refuse(data, purpose):
        assert purpose == "mouth"
        raise Validation422("use a photo with teeth", code="reference_mouth_closed")

    monkeypatch.setattr(portrait_photo, "prepare_photo", refuse)
    headers, org_id, avatar_id, _ = setup
    url = f"/orgs/{org_id}/avatars/{avatar_id}"
    response = await client.post(
        f"{url}/mouth-photo", files={"file": ("x.png", _png(), "image/png")}, headers=headers
    )
    assert response.status_code == 422
    assert (await client.get(url, headers=headers)).json()["mouth"] is None


@pytest.mark.parametrize("face_type", ["animal", "cartoon"])
async def test_the_photographic_mouth_is_for_human_faces_only(client, setup, face_type):
    """It paints human enamel and lips; in a muzzle or a drawn face those
    are someone's teeth in the wrong face."""
    headers, org_id, avatar_id, _ = setup
    url = f"/orgs/{org_id}/avatars/{avatar_id}"
    await client.patch(url, json={"face_type": face_type}, headers=headers)
    response = await client.patch(url, json={"mouth": {"renderer": "continuous"}}, headers=headers)
    assert response.status_code == 422
    assert response.json()["code"] == "mouth_not_for_face_type"
    # Nor in one request that changes both.
    both = await client.patch(
        url, json={"face_type": face_type, "mouth": {"renderer": "continuous"}}, headers=headers
    )
    assert both.status_code == 422
    assert (
        await client.patch(url, json={"mouth": {"renderer": "classic"}}, headers=headers)
    ).status_code == 200


async def test_a_face_that_stops_being_human_loses_the_photographic_mouth(client, setup):
    headers, org_id, avatar_id, _ = setup
    url = f"/orgs/{org_id}/avatars/{avatar_id}"
    body = {"mouth": {"renderer": "continuous", "profile": {"teethScale": 1.1}}}
    await client.patch(url, json=body, headers=headers)
    switched = (await client.patch(url, json={"face_type": "animal"}, headers=headers)).json()
    assert switched["mouth"]["renderer"] == "classic"
    assert switched["mouth"]["profile"]["teethScale"] == 1.1, "the fit is kept"


async def test_the_mouth_photo_is_refused_for_an_animal(client, setup, open_mouth_photo):
    headers, org_id, avatar_id, _ = setup
    url = f"/orgs/{org_id}/avatars/{avatar_id}"
    await client.patch(url, json={"face_type": "animal"}, headers=headers)
    response = await client.post(
        f"{url}/mouth-photo", files={"file": ("ee.png", _png(), "image/png")}, headers=headers
    )
    assert response.status_code == 422
    assert response.json()["code"] == "mouth_not_for_face_type"


async def test_publishing_never_ships_human_teeth_on_an_animal(client, setup):
    """Whatever route put the combination in the draft — an older row, a
    direct write — the published snapshot carries the classic mouth."""
    import json

    from sqlalchemy import update

    from app.db import get_session_factory
    from app.models import Avatar

    headers, org_id, avatar_id, key = setup
    url = f"/orgs/{org_id}/avatars/{avatar_id}"
    async with get_session_factory()() as db:
        await db.execute(
            update(Avatar)
            .where(Avatar.id == avatar_id)
            .values(face_type="animal", mouth_config=json.dumps({"renderer": "continuous"}))
        )
        await db.commit()
    await client.post(f"{url}/publish", headers=headers)
    served = (await client.get(f"/embed/v1/avatars/{avatar_id}", headers=key)).json()
    assert served["mouth"] is None
