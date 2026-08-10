
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
    # It returns a REAL transparent PNG, because the endpoint now re-derives
    # the thumbnail from whatever this produces — a dummy byte string would
    # skip the path that has to keep the transparency.
    def fake_cut_out(raw: bytes) -> bytes:
        import io

        from PIL import Image

        out = io.BytesIO()
        Image.new("RGBA", (300, 300), (0, 0, 0, 0)).save(out, format="PNG")
        return out.getvalue()

    monkeypatch.setattr(avatars_api, "remove_background", fake_cut_out)

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


async def _rig_of(client, org_id, avatar_id, headers):
    import json

    detail = (await client.get(f"/orgs/{org_id}/avatars/{avatar_id}", headers=headers)).json()
    raw = await client.get(detail["rig_url"])
    return json.loads(raw.content)


async def test_crop_moves_the_rig_with_the_image(client):
    """The rig is in image pixels, so a crop that ignores it puts the mesh
    beside the face instead of on it."""
    headers = await register_and_login(client, "cropper")
    org_id = await create_org(client, headers)
    avatar_id = await create_ready_avatar(client, headers, org_id)

    before = await _rig_of(client, org_id, avatar_id, headers)
    w, h = before["image_size"]

    response = await client.post(
        f"/orgs/{org_id}/avatars/{avatar_id}/crop",
        json={"x": 0.25, "y": 0.2, "width": 0.5, "height": 0.6},
        headers=headers,
    )
    assert response.status_code == 200, response.text
    assert response.json()["precrop_image_key"] is not None

    after = await _rig_of(client, org_id, avatar_id, headers)
    assert after["image_size"] == [round(w * 0.5), round(h * 0.6)]

    dx, dy = round(w * 0.25), round(h * 0.2)
    for (bx, by), (ax, ay) in zip(before["points"], after["points"]):
        assert abs(ax - (bx - dx)) <= 1, "every landmark shifts by the crop origin"
        assert abs(ay - (by - dy)) <= 1


async def test_crop_is_resettable_and_two_crops_reset_all_the_way(client):
    headers = await register_and_login(client, "cropper2")
    org_id = await create_org(client, headers)
    avatar_id = await create_ready_avatar(client, headers, org_id)
    original = (
        await client.get(f"/orgs/{org_id}/avatars/{avatar_id}", headers=headers)
    ).json()

    for _ in range(2):
        await client.post(
            f"/orgs/{org_id}/avatars/{avatar_id}/crop",
            json={"x": 0.1, "y": 0.1, "width": 0.7, "height": 0.7},
            headers=headers,
        )
    # The second crop must not overwrite the pointer with the first crop's
    # output, or reset would only undo one step.
    reset = await client.post(
        f"/orgs/{org_id}/avatars/{avatar_id}/crop", json={"reset": True}, headers=headers
    )
    assert reset.status_code == 200, reset.text
    assert reset.json()["precrop_image_key"] is None

    back = (await client.get(f"/orgs/{org_id}/avatars/{avatar_id}", headers=headers)).json()
    assert back["image_url"].split("?")[0] == original["image_url"].split("?")[0]


async def test_undo_restores_the_image_and_the_rig_together(client):
    """Crop rewrites rig.json in place, so undoing only the image would leave
    the landmarks in cropped coordinates — the mesh beside the face."""
    headers = await register_and_login(client, "undoer")
    org_id = await create_org(client, headers)
    avatar_id = await create_ready_avatar(client, headers, org_id)

    before = await _rig_of(client, org_id, avatar_id, headers)
    detail_before = (
        await client.get(f"/orgs/{org_id}/avatars/{avatar_id}", headers=headers)
    ).json()
    assert detail_before["undo_label"] is None

    cropped = await client.post(
        f"/orgs/{org_id}/avatars/{avatar_id}/crop",
        json={"x": 0.2, "y": 0.2, "width": 0.6, "height": 0.6},
        headers=headers,
    )
    assert cropped.json()["undo_label"] == "crop"

    undone = await client.post(f"/orgs/{org_id}/avatars/{avatar_id}/undo", headers=headers)
    assert undone.status_code == 200, undone.text
    assert undone.json()["undo_label"] is None
    assert undone.json()["precrop_image_key"] is None

    after = await _rig_of(client, org_id, avatar_id, headers)
    assert after["image_size"] == before["image_size"]
    assert after["points"] == before["points"], "the rig must come back too"


async def test_undo_steps_back_one_edit_at_a_time(client, monkeypatch):
    """Two different kinds of edit, undone in reverse order."""
    from app.api import avatars as avatars_api

    def fake_cut_out(raw: bytes) -> bytes:
        import io

        from PIL import Image

        out = io.BytesIO()
        Image.new("RGBA", (300, 300), (0, 0, 0, 0)).save(out, format="PNG")
        return out.getvalue()

    monkeypatch.setattr(avatars_api, "remove_background", fake_cut_out)

    headers = await register_and_login(client, "undoer2")
    org_id = await create_org(client, headers)
    avatar_id = await create_ready_avatar(client, headers, org_id)

    await client.post(
        f"/orgs/{org_id}/avatars/{avatar_id}/crop",
        json={"x": 0.1, "y": 0.1, "width": 0.8, "height": 0.8},
        headers=headers,
    )
    bg = await client.post(
        f"/orgs/{org_id}/avatars/{avatar_id}/background", json={"remove": True}, headers=headers
    )
    assert bg.json()["undo_label"] == "remove background"

    first = await client.post(f"/orgs/{org_id}/avatars/{avatar_id}/undo", headers=headers)
    assert first.json()["undo_label"] == "crop", "the crop is still there underneath"
    assert first.json()["original_image_key"] is None, "background removal is off again"

    second = await client.post(f"/orgs/{org_id}/avatars/{avatar_id}/undo", headers=headers)
    assert second.json()["undo_label"] is None
    assert second.json()["precrop_image_key"] is None


async def test_undo_with_nothing_to_undo_is_rejected(client):
    headers = await register_and_login(client, "undoer3")
    org_id = await create_org(client, headers)
    avatar_id = await create_ready_avatar(client, headers, org_id)
    response = await client.post(f"/orgs/{org_id}/avatars/{avatar_id}/undo", headers=headers)
    assert response.status_code == 409


async def test_crop_rejects_a_rectangle_that_leaves_almost_nothing(client):
    headers = await register_and_login(client, "cropper3")
    org_id = await create_org(client, headers)
    avatar_id = await create_ready_avatar(client, headers, org_id)
    response = await client.post(
        f"/orgs/{org_id}/avatars/{avatar_id}/crop",
        json={"x": 0.4, "y": 0.4, "width": 0.05, "height": 0.05},
        headers=headers,
    )
    assert response.status_code == 422


async def test_crop_rejects_a_rectangle_running_off_the_edge(client):
    headers = await register_and_login(client, "cropper4")
    org_id = await create_org(client, headers)
    avatar_id = await create_ready_avatar(client, headers, org_id)
    response = await client.post(
        f"/orgs/{org_id}/avatars/{avatar_id}/crop",
        json={"x": 0.7, "y": 0.1, "width": 0.6, "height": 0.5},
        headers=headers,
    )
    assert response.status_code == 422


async def test_cut_out_thumbnail_is_a_png_and_reverts_on_restore(client, monkeypatch):
    """The thumbnail has to follow the photo, in a format that can hold alpha.

    It is a JPEG for a normal photo, and a JPEG cannot store transparency —
    so leaving it alone after a removal means the dashboard, and anything
    else reading the thumbnail, still shows the old background.
    """
    from app.api import avatars as avatars_api

    headers = await register_and_login(client, "thumbowner")
    org_id = await create_org(client, headers)
    avatar_id = await create_ready_avatar(client, headers, org_id)

    def fake_cut_out(raw: bytes) -> bytes:
        import io

        from PIL import Image

        out = io.BytesIO()
        Image.new("RGBA", (300, 300), (0, 0, 0, 0)).save(out, format="PNG")
        return out.getvalue()

    monkeypatch.setattr(avatars_api, "remove_background", fake_cut_out)

    removed = await client.post(
        f"/orgs/{org_id}/avatars/{avatar_id}/background", json={"remove": True}, headers=headers
    )
    assert removed.status_code == 200, removed.text
    detail = (await client.get(f"/orgs/{org_id}/avatars/{avatar_id}", headers=headers)).json()
    assert ".png" in detail["thumbnail_url"], detail["thumbnail_url"]

    await client.post(
        f"/orgs/{org_id}/avatars/{avatar_id}/background", json={"remove": False}, headers=headers
    )
    restored = (await client.get(f"/orgs/{org_id}/avatars/{avatar_id}", headers=headers)).json()
    assert ".jpg" in restored["thumbnail_url"], restored["thumbnail_url"]


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
