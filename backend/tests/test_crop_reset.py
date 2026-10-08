"""Crop reset puts the rig back, rather than re-detecting it.

Re-detection threw away what matters most on the faces that need it most:
an animal's hand-placed marks (no detector finds a muzzle, so the marks ARE
the fit) and its muzzle viseme table (detection ran without the face type).
"""

import io

import numpy as np
import pytest
from PIL import Image

from app.services.rig import ANIMAL_VISEME_BLENDSHAPES
from tests.conftest import create_org, register_and_login, sample_png

MARKS = {
    "head": {
        "left": {"x": 70, "y": 200},
        "right": {"x": 250, "y": 200},
        "top": {"x": 160, "y": 60},
        "bottom": {"x": 160, "y": 340},
    },
    "mouth": {
        "left": {"x": 125, "y": 270},
        "right": {"x": 195, "y": 272},
        "top": {"x": 160, "y": 262},
        "bottom": {"x": 160, "y": 290},
    },
}


def textured_png() -> bytes:
    """Every pixel different from its neighbours, so a crop can be found in
    it again — as in any real photo."""
    rgb = np.random.default_rng(7).integers(0, 256, size=(400, 320, 3), dtype=np.uint8)
    buffer = io.BytesIO()
    Image.fromarray(rgb).save(buffer, format="PNG")
    return buffer.getvalue()


async def _marked_animal(client, who: str, image: bytes):
    headers = await register_and_login(client, who)
    org_id = await create_org(client, headers)
    created = (
        await client.post(
            f"/orgs/{org_id}/avatars",
            json={"name": "Dog", "content_type": "image/png", "face_type": "animal"},
            headers=headers,
        )
    ).json()
    await client.put(created["upload_url"], content=image, headers={"content-type": "image/png"})
    avatar_id = created["avatar"]["id"]
    base = f"/orgs/{org_id}/avatars/{avatar_id}"
    await client.post(f"{base}/uploaded", headers=headers)
    saved = await client.post(f"{base}/rig-fit", json={**MARKS, "persist": True}, headers=headers)
    assert saved.status_code == 200, saved.text
    return headers, base


async def _rig(client, headers, base) -> dict:
    detail = (await client.get(base, headers=headers)).json()
    return (await client.get(detail["rig_url"])).json()


async def _crop(client, headers, base, **rect):
    response = await client.post(f"{base}/crop", json=rect, headers=headers)
    assert response.status_code == 200, response.text


async def _reset(client, headers, base):
    response = await client.post(f"{base}/crop", json={"reset": True}, headers=headers)
    assert response.status_code == 200, response.text
    assert response.json()["precrop_image_key"] is None


def assert_same_rig(after: dict, before: dict) -> None:
    assert after["image_size"] == before["image_size"]
    assert np.allclose(after["points"], before["points"], atol=1e-6)
    assert np.allclose(after["face_box"], before["face_box"], atol=1e-6)
    assert after["user_anchors"] == before["user_anchors"]
    assert after["visemes"] == ANIMAL_VISEME_BLENDSHAPES
    assert "crop_origin" not in after


async def test_reset_after_two_crops_restores_the_marked_rig_exactly(client):
    headers, base = await _marked_animal(client, "dog1", sample_png())
    before = await _rig(client, headers, base)

    await _crop(client, headers, base, x=0.1, y=0.2, width=0.8, height=0.7)
    first = await _rig(client, headers, base)
    assert first["crop_origin"] == [32, 80]
    await _crop(client, headers, base, x=0.25, y=0.0, width=0.5, height=0.5)
    assert (await _rig(client, headers, base))["crop_origin"] == [32 + 64, 80]

    await _reset(client, headers, base)
    assert_same_rig(await _rig(client, headers, base), before)


async def test_a_redetect_of_the_crop_keeps_its_origin(client):
    """Reset marks re-runs the pipeline on the cropped photo: the points are
    new, but where the crop sits in the full photo is not."""
    headers, base = await _marked_animal(client, "dog2", sample_png())
    await _crop(client, headers, base, x=0.1, y=0.2, width=0.8, height=0.7)
    await client.post(f"{base}/rig-reset", headers=headers)
    assert (await _rig(client, headers, base))["crop_origin"] == [32, 80]


async def _forget_origin(client, headers, base) -> None:
    """Make the stored rig look like one cropped before origins were kept."""
    import json

    from app.services.storage import get_storage

    rig = await _rig(client, headers, base)
    del rig["crop_origin"]
    detail = (await client.get(base, headers=headers)).json()
    avatar_id = base.rsplit("/", 1)[-1]
    org_id = detail["org_id"]
    await get_storage().put_bytes(
        f"orgs/{org_id}/avatars/{avatar_id}/rig.json", json.dumps(rig).encode(), "application/json"
    )


async def test_an_older_crop_is_found_in_the_photo_it_came_from(client):
    headers, base = await _marked_animal(client, "dog3", textured_png())
    before = await _rig(client, headers, base)
    await _crop(client, headers, base, x=0.1, y=0.2, width=0.6, height=0.5)
    await _forget_origin(client, headers, base)

    await _reset(client, headers, base)
    assert_same_rig(await _rig(client, headers, base), before)


async def test_an_unrecoverable_origin_re_detects_as_the_right_face_type(client):
    """A flat image matches everywhere, so the origin is unknowable. The
    fallback still builds an ANIMAL rig at the full photo's size; the marks,
    which cannot be placed without the origin, are not carried over."""
    headers, base = await _marked_animal(client, "dog4", sample_png())
    await _crop(client, headers, base, x=0.1, y=0.2, width=0.6, height=0.5)
    await _forget_origin(client, headers, base)

    await _reset(client, headers, base)
    rig = await _rig(client, headers, base)
    assert rig["image_size"] == [320, 400]
    assert rig["visemes"] == ANIMAL_VISEME_BLENDSHAPES
    assert "user_anchors" not in rig


@pytest.mark.parametrize("left, top", [(0, 0), (17, 5), (100, 150)])
def test_locating_a_crop(left, top):
    from app.services.avatars.photo import _locate_crop

    photo = Image.open(io.BytesIO(textured_png()))
    crop = photo.crop((left, top, left + 120, top + 90))
    assert _locate_crop(photo, crop) == (left, top)
    flat = Image.open(io.BytesIO(sample_png()))
    assert _locate_crop(flat, flat.crop((left, top, left + 120, top + 90))) is None


def test_a_crop_moves_every_kind_of_mark():
    """Mouth lines and chins are marks too; the source is not a point."""
    from app.services.avatars.photo import _move_anchors

    anchors = {
        "head": {
            "left": {"x": 10, "y": 20},
            "right": {"x": 30, "y": 20},
            "top": {"x": 20, "y": 5},
            "bottom": {"x": 20, "y": 40},
            "center": None,
        },
        "mouth_line": [{"x": 12 + i, "y": 30} for i in range(5)],
        "chin": {"x": 20, "y": 38},
        "source": "owner",
    }
    moved = _move_anchors(anchors, 5, 10)
    assert moved["head"]["left"] == {"x": 5, "y": 10}
    assert moved["head"]["center"] is None
    assert [p["x"] for p in moved["mouth_line"]] == [7, 8, 9, 10, 11]
    assert moved["chin"] == {"x": 15, "y": 28}
    assert moved["source"] == "owner"
    assert _move_anchors(moved, -5, -10) == anchors


async def test_overlapping_edits_of_one_avatar_run_one_after_the_other(client, monkeypatch):
    """The layer build waits on the shared CPU thread after crop has
    rewritten rig.json in place but before it commits the row. A second crop
    arriving then must start from the first's committed result, not from
    the old image and the already-moved rig (which moved the rig twice for
    one cut of the image: every mark 32x40 px off the face)."""
    import asyncio

    from app.services import jobs

    headers, base = await _marked_animal(client, "dog-race", textured_png())
    before = await _rig(client, headers, base)
    real_run_cpu = jobs.run_cpu
    busy_thread = asyncio.Event()

    async def behind_other_jobs(fn, *args, **kwargs):
        await busy_thread.wait()
        return await real_run_cpu(fn, *args, **kwargs)

    monkeypatch.setattr(jobs, "run_cpu", behind_other_jobs)
    rect = {"x": 0.1, "y": 0.1, "width": 0.8, "height": 0.8}
    crops = [
        asyncio.create_task(client.post(f"{base}/crop", json=rect, headers=headers))
        for _ in range(2)
    ]
    # Long enough for the second crop to reach every read it makes.
    await asyncio.sleep(0.3)
    busy_thread.set()
    assert [r.status_code for r in await asyncio.gather(*crops)] == [200, 200]

    rig = await _rig(client, headers, base)
    detail = (await client.get(base, headers=headers)).json()
    image = Image.open(io.BytesIO((await client.get(detail["image_url"])).content))
    # Cropped twice, image and rig alike: 320x400 → 256x320 → 204x256.
    assert list(image.size) == rig["image_size"] == [204, 256]
    assert rig["crop_origin"] == [32 + 26, 40 + 32]
    left, top = rig["crop_origin"]
    assert np.allclose(
        rig["face_box"], np.array(before["face_box"]) - [left, top, left, top], atol=1e-6
    )
