"""What leaves a photo when we store it, and what cannot be recovered after.

Two leaks, both invisible in the dashboard:

- A removed background was only HIDDEN: alpha 0 over the original colours,
  so dropping the alpha channel of any cut-out, layer or thumbnail gave the
  room back. Every producer of a transparent PNG is checked here.
- A phone photo carries its GPS position and camera details in EXIF, and was
  stored (and served to visitors) with them.
"""

import io

import numpy as np
import pytest
from PIL import ExifTags, Image

from app.core.errors import Validation422
from app.services.photo_io import ingest_photo, png_bytes
from tests.conftest import create_org, create_ready_avatar, register_and_login


def hidden_colour(png: bytes) -> tuple[int, int]:
    """(transparent pixels, transparent pixels that still carry colour)."""
    rgba = np.asarray(Image.open(io.BytesIO(png)).convert("RGBA"))
    clear = rgba[:, :, 3] == 0
    return int(clear.sum()), int(rgba[clear, :3].any(axis=1).sum())


def assert_scrubbed(png: bytes) -> None:
    clear, leaking = hidden_colour(png)
    assert clear > 0, "the fixture should have produced transparent pixels"
    assert leaking == 0, f"{leaking} transparent pixels still hold the old colour"


def backdrop(width: int = 120, height: int = 160) -> np.ndarray:
    """A 'room': colour that varies everywhere, so nothing is zero by luck."""
    yy, xx = np.mgrid[0:height, 0:width]
    return np.dstack([40 + xx, 60 + yy // 2, 90 + (xx + yy) % 100]).astype(np.uint8)


def leaky_cutout() -> bytes:
    """A cut-out as an older pipeline (or another tool) wrote it: the
    backdrop still sits under alpha 0 on the left half."""
    rgba = np.dstack([backdrop(), np.full(backdrop().shape[:2], 255, dtype=np.uint8)])
    rgba[:, :60, 3] = 0
    buffer = io.BytesIO()
    Image.fromarray(rgba, mode="RGBA").save(buffer, format="PNG")
    return buffer.getvalue()


def opaque_png() -> bytes:
    buffer = io.BytesIO()
    Image.fromarray(backdrop()).save(buffer, format="PNG")
    return buffer.getvalue()


def phone_jpeg() -> bytes:
    """40x20 as stored, with EXIF saying 'rotate 90° to view' and a GPS fix."""
    exif = Image.Exif()
    exif[ExifTags.Base.Orientation] = 6
    exif[ExifTags.Base.Make] = "PhoneMaker"
    gps = exif.get_ifd(ExifTags.IFD.GPSInfo)
    gps[ExifTags.GPS.GPSLatitudeRef] = "N"
    gps[ExifTags.GPS.GPSLatitude] = (48.0, 51.0, 24.0)
    gps[ExifTags.GPS.GPSLongitudeRef] = "E"
    gps[ExifTags.GPS.GPSLongitude] = (2.0, 21.0, 3.0)
    buffer = io.BytesIO()
    Image.new("RGB", (40, 20), "#c08060").save(buffer, "JPEG", exif=exif)
    data = buffer.getvalue()
    assert Image.open(io.BytesIO(data)).getexif().get_ifd(ExifTags.IFD.GPSInfo), "fixture has GPS"
    return data


def assert_clean_upright(png: bytes) -> None:
    image = Image.open(io.BytesIO(png))
    assert image.format == "PNG"
    assert image.size == (20, 40), "EXIF orientation must be applied, not dropped"
    assert not image.getexif(), "no EXIF may survive"
    assert b"PhoneMaker" not in png and b"GPS" not in png


@pytest.fixture
def stub_segmenter(monkeypatch):
    """The segmenter model is not installed in tests; this one calls the left
    half of every photo background."""
    from app.services import segment

    def matte(image_bytes, prior_mask=None):
        rgb = np.asarray(Image.open(io.BytesIO(image_bytes)).convert("RGB")).astype(np.float32)
        alpha = np.ones(rgb.shape[:2], dtype=np.float32)
        alpha[:, : rgb.shape[1] // 2] = 0.0
        return rgb, alpha

    monkeypatch.setattr(segment, "person_matte", matte)


# --- ingest ---------------------------------------------------------------


def test_ingest_turns_the_photo_upright_and_drops_its_metadata():
    assert_clean_upright(ingest_photo(phone_jpeg()))


def test_ingest_judges_size_from_the_header_before_decoding(monkeypatch):
    """A tiny file can decode to gigabytes; the check must not decode it."""
    from PIL import ImageFile

    from app.services import photo_io

    monkeypatch.setattr(photo_io, "MAX_PIXELS", 100)

    def no_decode(self):
        raise AssertionError("pixels were decoded before the size check")

    monkeypatch.setattr(ImageFile.ImageFile, "load", no_decode)
    with pytest.raises(Validation422) as caught:
        ingest_photo(opaque_png())
    assert caught.value.code == "image_too_large"


def test_ingest_takes_a_24_megapixel_phone_photo_and_scales_it_down():
    """A current iPhone's default photo is 5712x4284, just over 24.4 million
    pixels; the cap is a bomb guard, not a reason to refuse a customer."""
    from app.services.photo_io import STORED_MAX_EDGE

    buffer = io.BytesIO()
    Image.new("RGB", (5712, 4284), "#c08060").save(buffer, "JPEG", quality=90)
    stored = Image.open(io.BytesIO(ingest_photo(buffer.getvalue(), STORED_MAX_EDGE)))
    assert stored.size == (STORED_MAX_EDGE, 1536)


def test_ingest_refuses_what_is_not_an_image():
    with pytest.raises(Validation422) as caught:
        ingest_photo(b"definitely not a photo")
    assert caught.value.code == "unreadable_image"


def test_ingest_scrubs_a_transparent_upload():
    assert_scrubbed(ingest_photo(leaky_cutout()))


def test_opaque_images_are_written_untouched():
    out = np.asarray(Image.open(io.BytesIO(png_bytes(Image.open(io.BytesIO(opaque_png()))))))
    assert np.array_equal(out, backdrop())


# --- every producer of a transparent PNG -----------------------------------


def test_background_removal(stub_segmenter):
    from app.services.segment import remove_background

    assert_scrubbed(remove_background(opaque_png()))


def test_layers_cut_from_a_cutout():
    from app.services.layers import build_layers

    layers = build_layers(leaky_cutout(), [70, 20, 110, 70])
    assert_scrubbed(layers["body"])
    assert_scrubbed(layers["head"])


def test_layers_cut_from_an_opaque_photo(stub_segmenter):
    from app.services.layers import build_layers

    layers = build_layers(opaque_png(), [70, 20, 110, 70])
    assert_scrubbed(layers["body"])
    assert_scrubbed(layers["head"])


def test_thumbnails_of_a_cutout():
    from app.services.rig import make_thumbnail

    thumb, content_type = make_thumbnail(leaky_cutout())
    assert content_type == "image/png"
    assert_scrubbed(thumb)


async def _org(client, who: str):
    headers = await register_and_login(client, who)
    return headers, await create_org(client, headers)


async def _stored(client, url: str) -> bytes:
    response = await client.get(url)
    assert response.status_code == 200, response.text
    return response.content


async def test_avatar_background_removal_and_its_derivatives(client, stub_segmenter):
    """The cut-out itself, its thumbnail, and a crop of it."""
    headers, org_id = await _org(client, "avatarcut")
    avatar_id = await create_ready_avatar(client, headers, org_id)
    base = f"/orgs/{org_id}/avatars/{avatar_id}"

    removed = await client.post(f"{base}/background", json={"remove": True}, headers=headers)
    assert removed.status_code == 200, removed.text
    detail = (await client.get(base, headers=headers)).json()
    assert_scrubbed(await _stored(client, detail["image_url"]))
    assert_scrubbed(await _stored(client, detail["thumbnail_url"]))

    await client.post(
        f"{base}/crop", json={"x": 0.1, "y": 0.1, "width": 0.8, "height": 0.8}, headers=headers
    )
    detail = (await client.get(base, headers=headers)).json()
    assert_scrubbed(await _stored(client, detail["image_url"]))


async def test_cropping_an_older_leaky_cutout_scrubs_it(client):
    from sqlalchemy import select

    from app.db import get_session_factory
    from app.models import Avatar
    from app.services.storage import get_storage

    headers, org_id = await _org(client, "oldcut")
    avatar_id = await create_ready_avatar(client, headers, org_id)
    async with get_session_factory()() as db:
        avatar = (await db.execute(select(Avatar).where(Avatar.id == avatar_id))).scalar_one()
        await get_storage().put_bytes(avatar.image_key, leaky_cutout(), "image/png")

    await client.post(
        f"/orgs/{org_id}/avatars/{avatar_id}/crop",
        json={"x": 0.0, "y": 0.0, "width": 0.9, "height": 0.9},
        headers=headers,
    )
    detail = (await client.get(f"/orgs/{org_id}/avatars/{avatar_id}", headers=headers)).json()
    assert_scrubbed(await _stored(client, detail["image_url"]))


# --- the presigned upload path ----------------------------------------------


async def _create(client, headers, org_id, data: bytes, mime: str = "image/jpeg") -> tuple[str, str]:
    """(avatar id, presigned upload URL), with `data` already PUT through it."""
    created = await client.post(
        f"/orgs/{org_id}/avatars",
        json={"name": "Phone", "content_type": mime},
        headers=headers,
    )
    body = created.json()
    put = await client.put(body["upload_url"], content=data, headers={"content-type": mime})
    assert put.status_code == 200, put.text
    return body["avatar"]["id"], body["upload_url"]


async def _presigned(client, headers, org_id, data: bytes) -> str:
    avatar_id, _ = await _create(client, headers, org_id, data)
    await client.post(f"/orgs/{org_id}/avatars/{avatar_id}/uploaded", headers=headers)
    return avatar_id


async def test_a_presigned_upload_is_cleaned_on_its_first_build(client):
    """The browser PUTs whatever it has straight into storage; the first
    build replaces it with the clean copy and deletes the original."""
    from app.services.storage import get_storage

    headers, org_id = await _org(client, "presigned")
    avatar_id = await _presigned(client, headers, org_id, phone_jpeg())
    detail = (await client.get(f"/orgs/{org_id}/avatars/{avatar_id}", headers=headers)).json()
    assert detail["status"] == "ready", detail
    assert detail["content_type"] == "image/png"
    assert_clean_upright(await _stored(client, detail["image_url"]))
    raw = f"orgs/{org_id}/avatars/{avatar_id}/source.jpg"
    assert not await get_storage().exists(raw), "the upload with GPS must not linger"
    rig = (await client.get(detail["rig_url"])).json()
    assert rig["image_size"] == [20, 40], "rigged upright, not on its side"


async def test_a_presigned_upload_over_the_pixel_cap_fails_clearly(client, monkeypatch):
    from app.services import photo_io

    monkeypatch.setattr(photo_io, "MAX_PIXELS", 100)
    headers, org_id = await _org(client, "hugeupload")
    avatar_id = await _presigned(client, headers, org_id, phone_jpeg())
    detail = (await client.get(f"/orgs/{org_id}/avatars/{avatar_id}", headers=headers)).json()
    assert detail["status"] == "failed"
    assert "megapixels" in detail["error"]


def png_with_metadata() -> bytes:
    """A PNG as a browser might send it: an eXIf chunk and hidden colour."""
    exif = Image.Exif()
    exif[ExifTags.Base.Make] = "PhoneMaker"
    buffer = io.BytesIO()
    Image.open(io.BytesIO(leaky_cutout())).save(buffer, "PNG", exif=exif)
    return buffer.getvalue()


async def test_uploads_are_stored_no_larger_than_the_stored_size(client, monkeypatch):
    """Both upload paths bound the photo, so no later step or visitor ever
    handles a full-size phone photo."""
    from app.services import photo_io

    monkeypatch.setattr(photo_io, "STORED_MAX_EDGE", 16)
    headers, org_id = await _org(client, "bounded")
    avatar_id = await _presigned(client, headers, org_id, phone_jpeg())
    detail = (await client.get(f"/orgs/{org_id}/avatars/{avatar_id}", headers=headers)).json()
    assert Image.open(io.BytesIO(await _stored(client, detail["image_url"]))).size == (8, 16)

    from app.services.jobs import runner

    created = await client.post(
        f"/orgs/{org_id}/creations", files={"file": ("p", phone_jpeg(), "image/jpeg")},
        headers=headers,
    )
    assert created.status_code == 202, created.text
    await runner.drain()
    creation = (
        await client.get(f"/orgs/{org_id}/creations/{created.json()['id']}", headers=headers)
    ).json()
    original = creation["steps"][0]
    assert (original["width"], original["height"]) == (8, 16)


async def test_a_second_put_through_the_upload_url_cannot_replace_the_live_image(client):
    """The presigned URL outlives the first build by an hour. Whatever is PUT
    through it later must not become the draft, or be published, uncleaned."""
    headers, org_id = await _org(client, "reput")
    avatar_id, upload_url = await _create(client, headers, org_id, png_with_metadata(), "image/png")
    base = f"/orgs/{org_id}/avatars/{avatar_id}"
    await client.post(f"{base}/uploaded", headers=headers)
    detail = (await client.get(base, headers=headers)).json()
    assert detail["status"] == "ready", detail
    clean = await _stored(client, detail["image_url"])
    assert b"PhoneMaker" not in clean
    assert_scrubbed(clean)

    again = await client.put(upload_url, content=png_with_metadata(), headers={"content-type": "image/png"})
    assert again.status_code == 200
    detail = (await client.get(base, headers=headers)).json()
    assert await _stored(client, detail["image_url"]) == clean

    published = await client.post(f"{base}/publish", headers=headers)
    assert published.status_code == 200, published.text
    from sqlalchemy import select

    from app.db import get_session_factory
    from app.models import Avatar
    from app.services.publishing import config_of
    from app.services.storage import get_storage

    async with get_session_factory()() as db:
        avatar = (await db.execute(select(Avatar).where(Avatar.id == avatar_id))).scalar_one()
    assert await get_storage().get_bytes(config_of(avatar)["image_key"]) == clean


async def test_a_restart_after_ingest_leaves_an_avatar_retry_can_finish(client, monkeypatch):
    """The first build swaps the upload for its clean copy. A deploy restart
    later in the same build must leave the row naming a file that exists,
    or Retry refuses and the avatar can never be recovered."""
    import asyncio

    from app.db import get_session_factory
    from app.services import rig
    from app.services.avatars import build
    from app.services.storage import get_storage

    headers, org_id = await _org(client, "restarted")
    avatar_id, _ = await _create(client, headers, org_id, phone_jpeg())
    detect = rig.landmarks_from_image

    def shutdown(data):
        raise asyncio.CancelledError  # what a shutdown raises in a running task

    monkeypatch.setattr(rig, "landmarks_from_image", shutdown)
    with pytest.raises(asyncio.CancelledError):
        await build.process_avatar(avatar_id)
    monkeypatch.setattr(rig, "landmarks_from_image", detect)
    async with get_session_factory()() as db:
        assert await build.fail_interrupted(db) == 1

    base = f"/orgs/{org_id}/avatars/{avatar_id}"
    retried = await client.post(f"{base}/retry", headers=headers)
    assert retried.status_code == 200, retried.text
    detail = (await client.get(base, headers=headers)).json()
    assert detail["status"] == "ready", detail
    assert_clean_upright(await _stored(client, detail["image_url"]))
    raw = f"orgs/{org_id}/avatars/{avatar_id}/source.jpg"
    assert not await get_storage().exists(raw)


async def test_removing_the_background_takes_the_backdrop_layer_with_it(client, stub_segmenter):
    """The opaque photo's background layer is the room with the person
    painted out. Behind a cut-out it is the removed background, back again."""
    from sqlalchemy import select

    from app.db import get_session_factory
    from app.models import Avatar
    from app.services.layers import layer_key
    from app.services.publishing import config_of
    from app.services.storage import get_storage

    headers, org_id = await _org(client, "backdrop")
    avatar_id = await create_ready_avatar(client, headers, org_id)
    base = f"/orgs/{org_id}/avatars/{avatar_id}"
    backdrop = layer_key(org_id, avatar_id, "background")

    async def layers() -> set[str]:
        return set((await client.get(base, headers=headers)).json()["layer_urls"] or {})

    async def published_layers() -> set[str]:
        async with get_session_factory()() as db:
            avatar = (await db.execute(select(Avatar).where(Avatar.id == avatar_id))).scalar_one()
        return set(config_of(avatar)["layer_keys"] or {})

    assert await layers() == {"background", "body", "head"}
    await client.post(f"{base}/background", json={"remove": True}, headers=headers)
    assert await layers() == {"body", "head"}
    assert not await get_storage().exists(backdrop)
    await client.post(f"{base}/publish", headers=headers)
    assert await published_layers() == {"body", "head"}

    # Restoring the photo brings its backdrop back; discarding that edit
    # returns to the published cut-out, and must take the backdrop away again.
    await client.post(f"{base}/background", json={"remove": False}, headers=headers)
    assert await layers() == {"background", "body", "head"}
    discarded = await client.post(f"{base}/discard-draft", headers=headers)
    assert discarded.status_code == 200, discarded.text
    assert await layers() == {"body", "head"}
    assert not await get_storage().exists(backdrop)
