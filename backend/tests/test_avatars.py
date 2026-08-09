
from tests.conftest import create_org, create_ready_avatar, register_and_login, sample_png


async def test_create_avatar_returns_upload_url(client):
    headers = await register_and_login(client, "alice")
    org_id = await create_org(client, headers)
    response = await client.post(
        f"/orgs/{org_id}/avatars",
        json={"name": "Ava", "content_type": "image/png"},
        headers=headers,
    )
    assert response.status_code == 201
    body = response.json()
    assert body["avatar"]["status"] == "pending"
    assert body["upload_url"].startswith("http://testserver/storage/")


async def test_unsupported_content_type_rejected(client):
    headers = await register_and_login(client, "alice")
    org_id = await create_org(client, headers)
    response = await client.post(
        f"/orgs/{org_id}/avatars",
        json={"name": "Ava", "content_type": "image/gif"},
        headers=headers,
    )
    assert response.status_code == 422
    assert response.json()["code"] == "unsupported_image_type"


async def test_confirm_before_upload_fails(client):
    headers = await register_and_login(client, "alice")
    org_id = await create_org(client, headers)
    created = await client.post(
        f"/orgs/{org_id}/avatars",
        json={"name": "Ava", "content_type": "image/png"},
        headers=headers,
    )
    avatar_id = created.json()["avatar"]["id"]
    response = await client.post(
        f"/orgs/{org_id}/avatars/{avatar_id}/uploaded", headers=headers
    )
    assert response.status_code == 422
    assert response.json()["code"] == "image_missing"


async def test_full_pipeline_to_ready(client):
    headers = await register_and_login(client, "alice")
    org_id = await create_org(client, headers)
    avatar_id = await create_ready_avatar(client, headers, org_id)

    detail = (
        await client.get(f"/orgs/{org_id}/avatars/{avatar_id}", headers=headers)
    ).json()
    assert detail["status"] == "ready"
    assert detail["rig_url"] and detail["thumbnail_url"] and detail["image_url"]


async def test_rig_json_is_valid(client):
    headers = await register_and_login(client, "alice")
    org_id = await create_org(client, headers)
    avatar_id = await create_ready_avatar(client, headers, org_id)
    detail = (
        await client.get(f"/orgs/{org_id}/avatars/{avatar_id}", headers=headers)
    ).json()

    rig_response = await client.get(detail["rig_url"])
    assert rig_response.status_code == 200
    rig = rig_response.json()
    assert rig["version"] == 3
    assert len(rig["points"]) == 478
    assert len(rig["triangles"]) > 800
    assert len(rig["visemes"]) == 15
    assert set(rig["visemes"]["aa"]) == {
        "jawOpen", "mouthClose", "mouthPucker", "mouthFunnel", "mouthStretch", "mouthSmile",
    }
    # Synthetic rig must put the inner lip ring ON the mouth: inside face box,
    # in its lower half, tightly clustered.
    points = rig["points"]
    ring = [points[i] for i in rig["inner_lip_ring"]]
    x0, y0, x1, y1 = rig["face_box"]
    for x, y in ring:
        assert x0 <= x <= x1 and y0 + (y1 - y0) * 0.5 <= y <= y1
    xs = [p[0] for p in ring]
    assert (max(xs) - min(xs)) < (x1 - x0) * 0.6


async def test_thumbnail_served(client):
    headers = await register_and_login(client, "alice")
    org_id = await create_org(client, headers)
    avatar_id = await create_ready_avatar(client, headers, org_id)
    detail = (
        await client.get(f"/orgs/{org_id}/avatars/{avatar_id}", headers=headers)
    ).json()
    response = await client.get(detail["thumbnail_url"])
    assert response.status_code == 200
    assert response.headers["content-type"] == "image/jpeg"


async def test_avatars_are_org_scoped(client):
    alice = await register_and_login(client, "alice")
    bob = await register_and_login(client, "bob")
    org_a = await create_org(client, alice)
    org_b = await create_org(client, bob, "BobCo")
    avatar_id = await create_ready_avatar(client, alice, org_a)
    # Bob cannot see Alice's avatar — neither through her org nor his own.
    assert (
        await client.get(f"/orgs/{org_a}/avatars/{avatar_id}", headers=bob)
    ).status_code == 404
    assert (
        await client.get(f"/orgs/{org_b}/avatars/{avatar_id}", headers=bob)
    ).status_code == 404


async def test_delete_avatar(client):
    headers = await register_and_login(client, "alice")
    org_id = await create_org(client, headers)
    avatar_id = await create_ready_avatar(client, headers, org_id)
    response = await client.delete(
        f"/orgs/{org_id}/avatars/{avatar_id}", headers=headers
    )
    assert response.status_code == 204
    assert (
        await client.get(f"/orgs/{org_id}/avatars/{avatar_id}", headers=headers)
    ).status_code == 404


async def test_storage_url_tamper_rejected(client):
    headers = await register_and_login(client, "alice")
    org_id = await create_org(client, headers)
    created = await client.post(
        f"/orgs/{org_id}/avatars",
        json={"name": "Ava", "content_type": "image/png"},
        headers=headers,
    )
    upload_url = created.json()["upload_url"]
    tampered = upload_url.replace("source", "other")
    response = await client.put(
        tampered, content=sample_png(), headers={"Content-Type": "image/png"}
    )
    assert response.status_code == 401


async def test_retry_reenqueues(client):
    headers = await register_and_login(client, "alice")
    org_id = await create_org(client, headers)
    created = await client.post(
        f"/orgs/{org_id}/avatars",
        json={"name": "Ava", "content_type": "image/png"},
        headers=headers,
    )
    avatar_id = created.json()["avatar"]["id"]
    upload_url = created.json()["upload_url"]
    await client.put(upload_url, content=sample_png(), headers={"Content-Type": "image/png"})
    response = await client.post(
        f"/orgs/{org_id}/avatars/{avatar_id}/retry", headers=headers
    )
    assert response.status_code == 200
    detail = await client.get(f"/orgs/{org_id}/avatars/{avatar_id}", headers=headers)
    assert detail.json()["status"] == "ready"


async def test_background_removal_is_reversible(client, monkeypatch):
    """Replacing the photo is destructive, so the original has to survive it."""
    from app.api import avatars as avatars_api

    headers = await register_and_login(client, "bgowner")
    org_id = await create_org(client, headers)
    avatar_id = await create_ready_avatar(client, headers, org_id)

    before = (await client.get(f"/orgs/{org_id}/avatars/{avatar_id}", headers=headers)).json()
    assert before["original_image_key"] is None

    # A tiny stand-in for the segmenter: the real one needs a 244KB model that
    # is not present in CI, and what is under test here is the bookkeeping.
    monkeypatch.setattr(avatars_api, "remove_background", lambda raw: b"\x89PNG\r\n\x1a\n cut")

    removed = await client.post(
        f"/orgs/{org_id}/avatars/{avatar_id}/background", json={"remove": True}, headers=headers
    )
    assert removed.status_code == 200, removed.text
    assert removed.json()["original_image_key"] is not None

    # Removing twice must not lose the original by overwriting the pointer.
    again = await client.post(
        f"/orgs/{org_id}/avatars/{avatar_id}/background", json={"remove": True}, headers=headers
    )
    assert again.json()["original_image_key"] == removed.json()["original_image_key"]

    restored = await client.post(
        f"/orgs/{org_id}/avatars/{avatar_id}/background", json={"remove": False}, headers=headers
    )
    assert restored.json()["original_image_key"] is None

    after = (await client.get(f"/orgs/{org_id}/avatars/{avatar_id}", headers=headers)).json()
    assert after["image_url"] and before["image_url"]


async def test_background_removal_reports_when_unconfigured(client, monkeypatch):
    from app.api import avatars as avatars_api
    from app.services.segment import SegmentationUnavailable

    headers = await register_and_login(client, "bgnomodel")
    org_id = await create_org(client, headers)
    avatar_id = await create_ready_avatar(client, headers, org_id)

    def unavailable(_raw):
        raise SegmentationUnavailable("no model")

    monkeypatch.setattr(avatars_api, "remove_background", unavailable)
    response = await client.post(
        f"/orgs/{org_id}/avatars/{avatar_id}/background", json={"remove": True}, headers=headers
    )
    assert response.status_code == 409
    assert response.json()["code"] == "segmentation_unavailable"
