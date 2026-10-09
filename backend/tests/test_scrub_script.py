"""The one-off rewrite of avatar images stored before they were written clean."""

import io

from PIL import ExifTags, Image
from sqlalchemy import select

from app.db import get_session_factory
from app.models import Avatar
from app.services.layers import layer_key
from app.services.publishing import config_of
from app.services.storage import get_storage
from scripts.scrub_stored_photos import scrub
from tests.conftest import create_org, create_ready_avatar, register_and_login
from tests.test_photo_privacy import (  # noqa: F401 (stub_segmenter is a fixture)
    assert_scrubbed,
    hidden_colour,
    leaky_cutout,
    phone_jpeg,
    stub_segmenter,
)


async def _avatar(avatar_id: str) -> Avatar:
    async with get_session_factory()() as db:
        return (await db.execute(select(Avatar).where(Avatar.id == avatar_id))).scalar_one()


async def _ready(client, who: str) -> tuple[dict, str, str]:
    headers = await register_and_login(client, who)
    org_id = await create_org(client, headers)
    return headers, org_id, await create_ready_avatar(client, headers, org_id)


async def test_dry_run_lists_apply_rewrites_and_a_rerun_finds_nothing(client):
    _, org_id, avatar_id = await _ready(client, "scrubber")
    storage = get_storage()
    avatar = await _avatar(avatar_id)
    # As an older pipeline left them: the draft image, a layer, and the
    # published copy all still hold the background under alpha 0.
    leaky = [avatar.image_key, layer_key(org_id, avatar_id, "head"), config_of(avatar)["image_key"]]
    for key in leaky:
        await storage.put_bytes(key, leaky_cutout(), "image/png")

    listed = await scrub(apply=False)
    assert sorted(key for key, _ in listed) == sorted(leaky)
    assert hidden_colour(await storage.get_bytes(leaky[0]))[1] > 0, "a dry run writes nothing"

    assert len(await scrub(apply=True)) == 3
    for key in leaky:
        assert_scrubbed(await storage.get_bytes(key))
    assert await scrub(apply=False) == []


async def test_a_raw_upload_and_its_published_copy_lose_their_metadata(client):
    """The state an avatar uploaded before ingest existed is in: the phone's
    JPEG as it came, GPS and all, and a published copy of it."""
    headers, org_id, avatar_id = await _ready(client, "rawjpeg")
    storage = get_storage()
    raw = f"orgs/{org_id}/avatars/{avatar_id}/source.jpg"
    await storage.put_bytes(raw, phone_jpeg(), "image/jpeg")
    async with get_session_factory()() as db:
        avatar = (await db.execute(select(Avatar).where(Avatar.id == avatar_id))).scalar_one()
        avatar.image_key = raw
        avatar.content_type = "image/jpeg"
        await db.commit()
    published = await client.post(f"/orgs/{org_id}/avatars/{avatar_id}/publish", headers=headers)
    assert published.status_code == 200, published.text
    live = config_of(await _avatar(avatar_id))["image_key"]
    assert live.endswith("image.jpg") and b"PhoneMaker" in await storage.get_bytes(live)

    assert {key for key, _ in await scrub(apply=False)} == {raw, live}
    await scrub(apply=True)
    for key in (raw, live):
        data = await storage.get_bytes(key)
        assert b"PhoneMaker" not in data and b"GPS" not in data
        image = Image.open(io.BytesIO(data))
        assert image.format == "JPEG" and image.size == (40, 20), "same file, same pixels"
        assert dict(image.getexif()) == {ExifTags.Base.Orientation: 6}, "orientation is kept"
    assert await scrub(apply=False) == []


async def test_a_backdrop_left_behind_a_cutout_is_deleted_and_unpublished(
    client,
    stub_segmenter,  # noqa: F811
):
    """Removing a background used to leave the opaque photo's background
    layer in place, and Publish copied it behind the cut-out."""
    headers, org_id, avatar_id = await _ready(client, "backdrop")
    storage = get_storage()
    avatar = await _avatar(avatar_id)
    backdrop = layer_key(org_id, avatar_id, "background")
    assert await storage.exists(backdrop), "an opaque photo gets a background layer"
    # The old removal: a cut-out in the draft, the backdrop untouched.
    await storage.put_bytes(avatar.image_key, leaky_cutout(), "image/png")
    await client.post(f"/orgs/{org_id}/avatars/{avatar_id}/publish", headers=headers)
    published_backdrop = config_of(await _avatar(avatar_id))["layer_keys"]["background"]

    listed = dict(await scrub(apply=False))
    assert listed[backdrop] == listed[published_backdrop] == "background layer behind a cut-out"
    assert await storage.exists(backdrop), "a dry run deletes nothing"

    await scrub(apply=True)
    assert not await storage.exists(backdrop)
    assert not await storage.exists(published_backdrop)
    assert "background" not in config_of(await _avatar(avatar_id))["layer_keys"]
    assert await scrub(apply=False) == []
