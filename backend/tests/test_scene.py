"""The scene an avatar is shown in (services.scene): zoom, pan and a
background behind a cut-out, saved on the avatar as a draft edit, published
by value with its picture copied like every other published file, and put
back by Discard. An avatar from before scenes has none and renders by its
framing.
"""

from __future__ import annotations

import io

import pytest
from PIL import Image

from app.services import scene as scene_service
from tests.conftest import create_org, create_ready_avatar, register_and_login


@pytest.fixture
async def setup(client):
    headers = await register_and_login(client, "scenic")
    org_id = await create_org(client, headers)
    avatar_id = await create_ready_avatar(client, headers, org_id)
    key = await client.post(
        f"/orgs/{org_id}/api-keys", json={"name": "w", "allowed_domains": []}, headers=headers
    )
    return headers, org_id, avatar_id, {"X-Api-Key": key.json()["plaintext"]}


def _picture(size=(640, 480), mode="RGB", fmt="PNG") -> bytes:
    image = Image.new(mode, size, (30, 90, 160, 255) if mode == "RGBA" else (30, 90, 160))
    out = io.BytesIO()
    image.save(out, format=fmt)
    return out.getvalue()


def _upload(client, org_id, avatar_id, headers, data=None, content_type="image/png"):
    return client.post(
        f"/orgs/{org_id}/avatars/{avatar_id}/scene-image",
        files={"file": ("bg.png", data if data is not None else _picture(), content_type)},
        headers=headers,
    )


# --- The numbers ---------------------------------------------------------------------


async def test_an_avatar_from_before_scenes_has_none_and_renders_by_its_framing(client, setup):
    headers, org_id, avatar_id, key = setup
    detail = await client.get(f"/orgs/{org_id}/avatars/{avatar_id}", headers=headers)
    assert detail.json()["scene"] is None
    assert detail.json()["scene_image_url"] is None
    served = await client.get(f"/embed/v1/avatars/{avatar_id}", headers=key)
    assert served.status_code == 200, served.text
    assert served.json()["scene"] is None
    assert served.json()["framing"] == "face"


async def test_a_scene_is_a_draft_edit_published_by_value(client, setup):
    headers, org_id, avatar_id, key = setup
    patched = await client.patch(
        f"/orgs/{org_id}/avatars/{avatar_id}",
        json={
            "scene": {
                "zoom": 1.2,
                "pan": {"x": -0.25, "y": 0.1},
                "background": {"kind": "color", "color": "#1E3A8A"},
            }
        },
        headers=headers,
    )
    assert patched.status_code == 200, patched.text
    body = patched.json()
    assert body["scene"] == {
        "zoom": 1.2,
        "pan": {"x": -0.25, "y": 0.1},
        "background": {"kind": "color", "has_image": False, "color": "#1e3a8a"},
    }
    assert body["unpublished"] is True
    # Visitors still see the published snapshot: no scene yet.
    served = await client.get(f"/embed/v1/avatars/{avatar_id}", headers=key)
    assert served.json()["scene"] is None
    published = await client.post(f"/orgs/{org_id}/avatars/{avatar_id}/publish", headers=headers)
    assert published.status_code == 200, published.text
    served = await client.get(f"/embed/v1/avatars/{avatar_id}", headers=key)
    assert served.json()["scene"] == {
        "zoom": 1.2,
        "pan": {"x": -0.25, "y": 0.1},
        "background": {"kind": "color", "color": "#1e3a8a"},
    }
    # The share page serves the same scene.
    shared = await client.post(f"/orgs/{org_id}/avatars/{avatar_id}/share", headers=headers)
    token = shared.json()["share_token"]
    public = await client.get(f"/public/v1/avatars/{token}")
    assert public.json()["scene"]["background"]["color"] == "#1e3a8a"


@pytest.mark.parametrize(
    "scene",
    [
        {"zoom": 1.5},
        {"zoom": -0.1},
        {"pan": {"x": 2}},
        {"pan": {"y": -1.01}},
        {"background": {"kind": "color", "color": "blue"}},
        {"background": {"kind": "color", "color": "#12345"}},
        {"background": {"kind": "shimmer"}},
    ],
)
async def test_the_ranges_are_the_engines(client, setup, scene):
    headers, org_id, avatar_id, _ = setup
    patched = await client.patch(
        f"/orgs/{org_id}/avatars/{avatar_id}", json={"scene": scene}, headers=headers
    )
    assert patched.status_code == 422, patched.text


async def test_a_colour_needs_a_colour_and_an_image_needs_a_picture(client, setup):
    headers, org_id, avatar_id, _ = setup
    no_colour = await client.patch(
        f"/orgs/{org_id}/avatars/{avatar_id}",
        json={"scene": {"background": {"kind": "color"}}},
        headers=headers,
    )
    assert no_colour.status_code == 422
    assert no_colour.json()["code"] == "scene_invalid"
    no_picture = await client.patch(
        f"/orgs/{org_id}/avatars/{avatar_id}",
        json={"scene": {"background": {"kind": "image"}}},
        headers=headers,
    )
    assert no_picture.status_code == 422
    assert no_picture.json()["code"] == "scene_image_missing"


async def test_the_framing_column_follows_the_zoom_both_ways(client, setup):
    headers, org_id, avatar_id, _ = setup
    full = await client.patch(
        f"/orgs/{org_id}/avatars/{avatar_id}", json={"scene": {"zoom": 0}}, headers=headers
    )
    assert full.json()["framing"] == "full"
    face = await client.patch(
        f"/orgs/{org_id}/avatars/{avatar_id}", json={"scene": {"zoom": 0.8}}, headers=headers
    )
    assert face.json()["framing"] == "face"
    # An old client setting the framing moves the scene's zoom with it.
    legacy = await client.patch(
        f"/orgs/{org_id}/avatars/{avatar_id}", json={"framing": "full"}, headers=headers
    )
    assert legacy.json()["scene"]["zoom"] == 0.0


def test_the_scene_of_a_framing():
    assert scene_service.from_framing("full")["zoom"] == 0.0
    assert scene_service.from_framing("face")["zoom"] == 1.0
    assert scene_service.framing_of({"zoom": 0.49}) == "full"
    assert scene_service.framing_of({"zoom": 0.5}) == "face"


# --- The picture ---------------------------------------------------------------------


async def test_a_background_picture_is_stored_shown_published_and_removed(client, setup):
    headers, org_id, avatar_id, key = setup
    from app.services.storage import get_storage

    storage = get_storage()
    uploaded = await _upload(client, org_id, avatar_id, headers)
    assert uploaded.status_code == 200, uploaded.text
    body = uploaded.json()
    assert body["scene"]["background"] == {"kind": "image", "has_image": True}
    assert body["unpublished"] is True
    detail = await client.get(f"/orgs/{org_id}/avatars/{avatar_id}", headers=headers)
    draft_url = detail.json()["scene_image_url"]
    assert draft_url and "scene-" in draft_url and "published" not in draft_url
    # Stored as WebP, no larger than the cap, with the alpha of a PNG kept.
    names = await storage.list_names(f"orgs/{org_id}/avatars/{avatar_id}/")
    draft_files = [n for n in names if scene_service.SCENE_FILE.fullmatch(n)]
    assert len(draft_files) == 1
    stored = await storage.get_bytes(f"orgs/{org_id}/avatars/{avatar_id}/{draft_files[0]}")
    assert Image.open(io.BytesIO(stored)).format == "WEBP"

    # Visitors: nothing until Publish, then a copy under the snapshot.
    served = await client.get(f"/embed/v1/avatars/{avatar_id}", headers=key)
    assert served.json()["scene"] is None
    await client.post(f"/orgs/{org_id}/avatars/{avatar_id}/publish", headers=headers)
    served = await client.get(f"/embed/v1/avatars/{avatar_id}", headers=key)
    background = served.json()["scene"]["background"]
    assert background["kind"] == "image"
    assert "/published/" in background["image_url"] and "scene.webp" in background["image_url"]
    assert "image_key" not in background

    # Replacing deletes the draft's old file, not the published copy.
    replaced = await _upload(client, org_id, avatar_id, headers, data=_picture((300, 300)))
    assert replaced.status_code == 200
    names = await storage.list_names(f"orgs/{org_id}/avatars/{avatar_id}/")
    assert len([n for n in names if scene_service.SCENE_FILE.fullmatch(n)]) == 1
    served = await client.get(f"/embed/v1/avatars/{avatar_id}", headers=key)
    assert served.json()["scene"]["background"]["kind"] == "image"

    # Removing: transparent again, the file gone; visitors keep theirs.
    removed = await client.delete(
        f"/orgs/{org_id}/avatars/{avatar_id}/scene-image", headers=headers
    )
    assert removed.status_code == 200
    assert removed.json()["scene"]["background"] == {"kind": "transparent", "has_image": False}
    names = await storage.list_names(f"orgs/{org_id}/avatars/{avatar_id}/")
    assert not [n for n in names if scene_service.SCENE_FILE.fullmatch(n)]
    served = await client.get(f"/embed/v1/avatars/{avatar_id}", headers=key)
    assert served.json()["scene"]["background"]["kind"] == "image"


async def test_discard_puts_the_published_picture_back_into_a_fresh_draft_file(client, setup):
    headers, org_id, avatar_id, key = setup
    from app.services.storage import get_storage

    storage = get_storage()
    await _upload(client, org_id, avatar_id, headers)
    await client.post(f"/orgs/{org_id}/avatars/{avatar_id}/publish", headers=headers)
    await client.delete(f"/orgs/{org_id}/avatars/{avatar_id}/scene-image", headers=headers)
    discarded = await client.post(
        f"/orgs/{org_id}/avatars/{avatar_id}/discard-draft", headers=headers
    )
    assert discarded.status_code == 200, discarded.text
    assert discarded.json()["scene"]["background"] == {"kind": "image", "has_image": True}
    assert discarded.json()["unpublished"] is False
    names = await storage.list_names(f"orgs/{org_id}/avatars/{avatar_id}/")
    assert len([n for n in names if scene_service.SCENE_FILE.fullmatch(n)]) == 1
    detail = await client.get(f"/orgs/{org_id}/avatars/{avatar_id}", headers=headers)
    assert "published" not in detail.json()["scene_image_url"]


async def test_old_published_pictures_are_pruned_with_their_revision(client, setup):
    headers, org_id, avatar_id, _ = setup
    from app.services.storage import get_storage

    storage = get_storage()
    await _upload(client, org_id, avatar_id, headers)
    await client.post(f"/orgs/{org_id}/avatars/{avatar_id}/publish", headers=headers)
    root = f"orgs/{org_id}/avatars/{avatar_id}/published/"
    first = await storage.list_names(root)
    for _ in range(2):
        await _upload(client, org_id, avatar_id, headers, data=_picture((200, 200)))
        await client.post(f"/orgs/{org_id}/avatars/{avatar_id}/publish", headers=headers)
    later = await storage.list_names(root)
    # The current and the previous revision stay; the first is gone.
    assert len(later) == 2
    assert first[0] not in later


async def test_a_picture_is_checked_before_it_is_stored(client, setup):
    headers, org_id, avatar_id, _ = setup
    wrong_type = await _upload(client, org_id, avatar_id, headers, content_type="text/plain")
    assert wrong_type.status_code == 422
    assert wrong_type.json()["code"] == "unsupported_image_type"
    not_a_picture = await _upload(client, org_id, avatar_id, headers, data=b"not a picture at all")
    assert not_a_picture.status_code == 422
    assert not_a_picture.json()["code"] == "scene_image_invalid"
    too_large = await _upload(
        client, org_id, avatar_id, headers, data=b"\x89PNG" + bytes(15 * 1024 * 1024)
    )
    assert too_large.status_code == 422
    assert too_large.json()["code"] == "image_too_large"


def test_a_big_picture_is_scaled_down_and_alpha_kept():
    small = scene_service.prepare_image(_picture((100, 50)))
    assert Image.open(io.BytesIO(small)).size == (100, 50)
    big = scene_service.prepare_image(_picture((5000, 2500)))
    assert Image.open(io.BytesIO(big)).size == (scene_service.MAX_SIDE, scene_service.MAX_SIDE // 2)
    with_alpha = Image.new("RGBA", (40, 40), (0, 0, 0, 0))
    out = io.BytesIO()
    with_alpha.save(out, format="PNG")
    stored = Image.open(io.BytesIO(scene_service.prepare_image(out.getvalue())))
    assert stored.mode == "RGBA"
    assert stored.getpixel((0, 0))[3] == 0


async def test_deleting_the_avatar_takes_its_pictures(client, setup):
    headers, org_id, avatar_id, _ = setup
    from app.services.storage import get_storage

    storage = get_storage()
    await _upload(client, org_id, avatar_id, headers)
    await client.post(f"/orgs/{org_id}/avatars/{avatar_id}/publish", headers=headers)
    deleted = await client.delete(f"/orgs/{org_id}/avatars/{avatar_id}", headers=headers)
    assert deleted.status_code == 204
    assert await storage.list_names(f"orgs/{org_id}/avatars/{avatar_id}/") == []
