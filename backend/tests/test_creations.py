"""The creation wizard over the API: every route, every state change, and
the races between the owner's edits and the jobs working on them.

Tests run without a landmark or segmenter model. `face` stands in for
MediaPipe (the face template, found in the middle of every image), and
`segmenter` for the person segmenter (it calls the left half of every photo
background). `gate` holds every job at its first CPU section, so a test can
act while a job is in flight.
"""

import asyncio
import io
from pathlib import Path

import numpy as np
import pytest
from PIL import Image
from sqlalchemy import select, update

from app.core import config
from app.db import get_session_factory
from app.models import Avatar, Creation, CreationStatus
from app.services import creations as svc
from app.services import face_template, landmarks, segment
from app.services.jobs import runner
from app.services.storage import get_storage
from tests.conftest import create_org, register_and_login
from tests.test_photo_privacy import assert_clean_upright, assert_scrubbed, phone_jpeg

# --- fixtures and helpers -------------------------------------------------------


def portrait(width: int = 400, height: int = 500) -> bytes:
    """A photo with texture everywhere, so nothing about it is flat."""
    rng = np.random.default_rng(7)
    pixels = rng.integers(60, 200, size=(height, width, 3), dtype=np.uint8)
    buffer = io.BytesIO()
    Image.fromarray(pixels).save(buffer, format="PNG")
    return buffer.getvalue()


@pytest.fixture
def face(monkeypatch):
    """A detector that finds a frontal face in the middle of every image."""

    def detect(image):
        width, height = image.size
        points = face_template.place((0.3 * width, 0.2 * height, 0.7 * width, 0.7 * height))
        return landmarks.FaceLandmarks(points=points, z=np.zeros(len(points)))

    monkeypatch.setattr(landmarks, "detect", detect)


@pytest.fixture
def segmenter(monkeypatch):
    def matte(image_bytes, prior_mask=None):
        rgb = np.asarray(Image.open(io.BytesIO(image_bytes)).convert("RGB")).astype(np.float32)
        alpha = np.ones(rgb.shape[:2], dtype=np.float32)
        alpha[:, : rgb.shape[1] // 2] = 0.0
        return rgb, alpha

    monkeypatch.setattr(config.get_settings(), "segment_model_path", "/fake.tflite", raising=False)
    monkeypatch.setattr(segment, "person_matte", matte)


@pytest.fixture
def no_segmenter(monkeypatch):
    monkeypatch.setattr(config.get_settings(), "segment_model_path", None, raising=False)


class Gate:
    """Holds every creation job at its next CPU section until opened."""

    # The modules whose jobs run CPU sections (services.creations' works).
    JOB_MODULES = ("adjust", "detect", "finish", "generate", "ingest")

    def __init__(self, monkeypatch):
        from app.services.jobs import run_cpu

        self._monkeypatch = monkeypatch
        self._event = asyncio.Event()
        self._real = run_cpu

    def close(self) -> None:
        import importlib

        async def held(fn, *args, **kwargs):
            await self._event.wait()
            return await self._real(fn, *args, **kwargs)

        for name in self.JOB_MODULES:
            module = importlib.import_module(f"app.services.creations.{name}")
            self._monkeypatch.setattr(module, "run_cpu", held)

    def open(self) -> None:
        self._event.set()


@pytest.fixture
def gate(monkeypatch):
    return Gate(monkeypatch)


async def _org(client, who: str) -> tuple[dict, str]:
    headers = await register_and_login(client, who)
    return headers, await create_org(client, headers)


async def _upload(client, headers, org_id, data=None, face_type=None, content_type="image/png"):
    files = {"file": ("photo.png", data if data is not None else portrait(), content_type)}
    form = {"face_type": face_type} if face_type else {}
    return await client.post(f"/orgs/{org_id}/creations", files=files, data=form, headers=headers)


async def _get(client, headers, base) -> dict:
    response = await client.get(base, headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


async def _create(client, headers, org_id, **kwargs) -> tuple[str, dict]:
    response = await _upload(client, headers, org_id, **kwargs)
    assert response.status_code == 202, response.text
    base = f"/orgs/{org_id}/creations/{response.json()['id']}"
    await runner.drain()
    body = await _get(client, headers, base)
    assert body["job"]["state"] == "done", body["job"]
    return base, body


async def _run(client, headers, method: str, url: str, **kwargs):
    response = await client.request(method, url, headers=headers, **kwargs)
    await runner.drain()
    return response


async def _detect(client, headers, base) -> dict:
    response = await _run(client, headers, "POST", f"{base}/detect")
    assert response.status_code == 202, response.text
    anchors = (await _get(client, headers, base))["anchors"]
    assert anchors is not None
    return anchors


async def _until_running(client, headers, base) -> dict:
    for _ in range(100):
        body = await _get(client, headers, base)
        if body["job"] and body["job"]["state"] == "running":
            return body
        await asyncio.sleep(0.01)
    raise AssertionError("the job never started")


def _files(prefix: str) -> list[str]:
    root = Path(get_storage().root) / prefix
    if not root.exists():
        return []
    return sorted(str(p.relative_to(root)) for p in root.rglob("*") if p.is_file())


def _creation_prefix(base: str) -> str:
    _, _, org_id, _, creation_id = base.split("/")
    return svc.creation_prefix(org_id, creation_id)


async def _bytes_at(client, url: str) -> bytes:
    response = await client.get(url)
    assert response.status_code == 200, response.text
    return response.content


async def _row(creation_id: str) -> Creation:
    async with get_session_factory()() as db:
        return (await db.execute(select(Creation).where(Creation.id == creation_id))).scalar_one()


async def _avatar_row(avatar_id: str) -> Avatar | None:
    async with get_session_factory()() as db:
        return (
            await db.execute(select(Avatar).where(Avatar.id == avatar_id))
        ).scalar_one_or_none()


# A framing that changes the frame without cutting anything important off.
REFRAME = {"crop": {"x": 0.05, "y": 0.05, "w": 0.9, "h": 0.9}}
WHOLE = {"x": 0, "y": 0, "w": 1, "h": 1}


def _step(body: dict, step_id: str) -> dict | None:
    return next((s for s in body["steps"] if s["id"] == step_id), None)


# --- upload and analysis ----------------------------------------------------------


async def test_an_upload_is_ingested_analysed_and_suggested_human(client, face):
    headers, org_id = await _org(client, "alice")
    response = await _upload(client, headers, org_id)
    assert response.status_code == 202, response.text
    queued = response.json()
    assert queued["status"] == "draft"
    assert queued["job"]["step"] == "ingest"
    assert queued["job"]["state"] == "queued"
    assert queued["steps"] == []

    await runner.drain()
    body = await _get(client, headers, f"/orgs/{org_id}/creations/{queued['id']}")
    assert body["job"]["state"] == "done"
    assert body["current"] == "original"
    assert [s["id"] for s in body["steps"]] == ["original"]
    assert (body["steps"][0]["width"], body["steps"][0]["height"]) == (400, 500)
    assert body["analysis"]["detected"] is True
    assert body["analysis"]["suggested_face_type"] == "human"
    assert body["face_type"] == "human"
    framing = body["analysis"]["suggested_framing"]
    assert framing is not None and 0 <= framing["crop"]["x"] <= 1
    assert body["revision"] == 1


async def test_the_upload_is_stored_upright_and_without_its_metadata(client, face):
    headers, org_id = await _org(client, "phone")
    _, body = await _create(client, headers, org_id, data=phone_jpeg(), content_type="image/jpeg")
    assert_clean_upright(await _bytes_at(client, body["steps"][0]["url"]))
    # The raw upload (EXIF, GPS) is gone once the clean copy is stored.
    assert all(not name.startswith("incoming") for name in _files(_creation_prefix(
        f"/orgs/{org_id}/creations/{body['id']}"
    )))


async def test_no_face_suggests_no_line_and_the_wizard_must_ask(client):
    headers, org_id = await _org(client, "dog")
    base, body = await _create(client, headers, org_id)
    assert body["face_type"] is None
    assert body["analysis"]["suggested_face_type"] is None
    assert body["background_removal"] == {"available": False, "reason": "face_type_required"}
    response = await client.post(f"{base}/detect", headers=headers)
    assert response.status_code == 422
    assert response.json()["code"] == "face_type_required"


async def test_a_line_chosen_at_upload_is_kept(client, face):
    headers, org_id = await _org(client, "toon")
    _, body = await _create(client, headers, org_id, face_type="cartoon")
    assert body["face_type"] == "cartoon"
    assert body["analysis"]["suggested_face_type"] == "human"


async def test_uploads_that_cannot_succeed_are_refused_before_any_job(client, monkeypatch):
    headers, org_id = await _org(client, "refused")
    bad_type = await _upload(client, headers, org_id, content_type="image/gif")
    assert bad_type.status_code == 422 and bad_type.json()["code"] == "unsupported_image_type"
    unreadable = await _upload(client, headers, org_id, data=b"not a photo at all")
    assert unreadable.status_code == 422 and unreadable.json()["code"] == "unreadable_image"
    monkeypatch.setattr(svc, "MAX_UPLOAD_BYTES", 100)
    too_big = await _upload(client, headers, org_id)
    assert too_big.status_code == 422 and too_big.json()["code"] == "image_too_large"
    assert (await _get(client, headers, f"/orgs/{org_id}/creations")) == []
    assert _files(f"orgs/{org_id}/creations/") == []


async def test_the_header_is_read_off_the_loop_and_only_once_admitted(client, monkeypatch):
    """Reading a header walks untrusted markers in Python, seconds for a
    crafted file: it runs on a thread, and only after the refusals that cost
    nothing (the draft limit, the job caps), which also bound how many run."""
    import threading

    from app.services import photo_io

    loop_thread = threading.get_ident()
    probed_on: list[int] = []
    real_probe = photo_io.probe_photo

    def probe(data):
        probed_on.append(threading.get_ident())
        return real_probe(data)

    monkeypatch.setattr(photo_io, "probe_photo", probe)
    headers, org_id = await _org(client, "prober")
    assert (await _upload(client, headers, org_id)).status_code == 202
    await runner.drain()
    assert len(probed_on) == 1 and probed_on[0] != loop_thread

    held = [runner.reserve(org_id, f"busy-{i}", "detect", 0) for i in range(2)]
    try:
        busy = await _upload(client, headers, org_id)
        assert busy.status_code == 429
    finally:
        for job in held:
            runner.release(job)
    monkeypatch.setattr(svc.rules, "MAX_DRAFTS_PER_ORG", 1)
    full = await _upload(client, headers, org_id)
    assert full.status_code == 409 and full.json()["code"] == "too_many_drafts"
    assert len(probed_on) == 1


async def test_a_refused_header_gives_its_job_slot_back(client, monkeypatch):
    headers, org_id = await _org(client, "badheaders")
    # More refusals than the org's job cap: a slot kept by each would turn
    # the third into 429.
    for _ in range(runner.max_per_org + 1):
        refused = await _upload(client, headers, org_id, data=b"not a photo at all")
        assert refused.status_code == 422 and refused.json()["code"] == "unreadable_image"
    assert (await _upload(client, headers, org_id)).status_code == 202


async def test_a_photo_that_will_not_decode_fails_its_job_for_good(client):
    """The header is fine (so the request accepts it) but the pixels are
    not: the job fails, cannot be retried, and the raw upload is not kept."""
    headers, org_id = await _org(client, "truncated")
    data = portrait()
    response = await _upload(client, headers, org_id, data=data[: len(data) // 2])
    assert response.status_code == 202, response.text
    base = f"/orgs/{org_id}/creations/{response.json()['id']}"
    await runner.drain()
    body = await _get(client, headers, base)
    assert body["steps"] == []
    assert body["job"]["state"] == "failed"
    assert body["job"]["error"]["code"] == "unreadable_image"
    assert body["job"]["retryable"] is False
    assert _files(_creation_prefix(base)) == []
    retry = await client.post(f"{base}/retry", headers=headers)
    assert retry.status_code == 409 and retry.json()["code"] == "nothing_to_retry"


async def test_an_org_keeps_at_most_ten_drafts(client, monkeypatch):
    monkeypatch.setattr(svc.rules, "MAX_DRAFTS_PER_ORG", 2)
    headers, org_id = await _org(client, "hoarder")
    await _create(client, headers, org_id)
    await _create(client, headers, org_id)
    third = await _upload(client, headers, org_id)
    assert third.status_code == 409
    assert third.json()["code"] == "too_many_drafts"


async def test_resume_list_is_newest_activity_first_and_filters_by_status(client):
    headers, org_id = await _org(client, "resumer")
    older, _ = await _create(client, headers, org_id)
    newer, _ = await _create(client, headers, org_id)
    listed = await _get(client, headers, f"/orgs/{org_id}/creations?status=draft")
    assert [c["id"] for c in listed] == [newer.rsplit("/", 1)[1], older.rsplit("/", 1)[1]]

    await client.patch(older, json={"face_type": "animal"}, headers=headers)
    listed = await _get(client, headers, f"/orgs/{org_id}/creations?status=draft")
    assert listed[0]["id"] == older.rsplit("/", 1)[1]
    assert await _get(client, headers, f"/orgs/{org_id}/creations?status=finished") == []
    bad = await client.get(f"/orgs/{org_id}/creations?status=bogus", headers=headers)
    assert bad.status_code == 422


# --- org scoping --------------------------------------------------------------------


async def test_another_orgs_creation_is_not_found(client):
    headers, org_id = await _org(client, "owner")
    base, _ = await _create(client, headers, org_id)
    creation_id = base.rsplit("/", 1)[1]

    stranger, their_org = await _org(client, "stranger")
    theirs = f"/orgs/{their_org}/creations/{creation_id}"
    for method, suffix, body in (
        ("GET", "", None),
        ("PATCH", "", {"face_type": "animal"}),
        ("POST", "/choose", {"choice": "original"}),
        ("POST", "/background", {"mode": "keep"}),
        ("POST", "/detect", None),
        ("POST", "/preview-rig", {"anchors_id": "x"}),
        ("POST", "/finish", {"name": "Mine", "anchors_id": "x"}),
        ("POST", "/retry", None),
        ("DELETE", "", None),
    ):
        response = await client.request(method, theirs + suffix, json=body, headers=stranger)
        assert response.status_code == 404, (method, suffix, response.text)
        assert response.json()["code"] == "creation_not_found"
    assert await _get(client, stranger, f"/orgs/{their_org}/creations") == []
    # And the owner's org path is closed to a non-member.
    response = await client.get(base, headers=stranger)
    assert response.status_code == 404 and response.json()["code"] == "org_not_found"
    assert (await _get(client, headers, base))["status"] == "draft"


# --- framing and the line -------------------------------------------------------------


async def test_framing_is_a_new_step_and_never_touches_the_original(client, face):
    headers, org_id = await _org(client, "framer")
    base, before = await _create(client, headers, org_id)
    original_url = before["steps"][0]["url"]
    crop = {"x": 0.1, "y": 0.1, "w": 0.5, "h": 0.6}

    response = await client.patch(base, json={"crop": crop, "roll": 4.0}, headers=headers)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["current"] == "framed"
    assert body["revision"] == before["revision"] + 1
    framed = _step(body, "framed")
    assert (framed["width"], framed["height"]) == (200, 300)
    assert framed["from"] == "original" and framed["crop"] == crop and framed["roll"] == 4.0
    assert _step(body, "original")["url"].split("?")[0] == original_url.split("?")[0]
    assert Image.open(io.BytesIO(await _bytes_at(client, original_url))).size == (400, 500)

    # Roll alone keeps the crop; the same framing again changes nothing.
    again = (await client.patch(base, json={"roll": 4.0}, headers=headers)).json()
    assert again["revision"] == body["revision"]
    # Back to the whole, level photo is the original itself.
    whole = (
        await client.patch(base, json={"crop": WHOLE, "roll": 0}, headers=headers)
    ).json()
    assert whole["current"] == "original" and _step(whole, "framed") is None
    assert [n for n in _files(_creation_prefix(base)) if n.startswith("framed")] == []


async def test_framing_refuses_crops_it_cannot_use(client):
    headers, org_id = await _org(client, "badcrop")
    base, _ = await _create(client, headers, org_id)
    outside = await client.patch(
        base, json={"crop": {"x": 0.6, "y": 0, "w": 0.5, "h": 1}}, headers=headers
    )
    assert outside.status_code == 422 and outside.json()["code"] == "crop_out_of_bounds"
    tiny = await client.patch(
        base, json={"crop": {"x": 0, "y": 0, "w": 0.1, "h": 1}}, headers=headers
    )
    assert tiny.status_code == 422 and tiny.json()["code"] == "crop_too_small"
    steep = await client.patch(base, json={"roll": 60}, headers=headers)
    assert steep.status_code == 422


async def test_reframing_or_switching_line_drops_the_cutout_and_the_marks(client, face, segmenter):
    headers, org_id = await _org(client, "reframe")
    base, _ = await _create(client, headers, org_id)
    await _detect(client, headers, base)
    await _run(client, headers, "POST", f"{base}/background", json={"mode": "remove"})
    body = await _get(client, headers, base)
    assert body["current"] == "cutout" and body["anchors"] is not None
    cutout_file = [n for n in _files(_creation_prefix(base)) if n.startswith("cutout")]
    assert len(cutout_file) == 1

    body = (await client.patch(base, json=REFRAME, headers=headers)).json()
    assert [s["id"] for s in body["steps"]] == ["original", "framed"]
    assert body["current"] == "framed"
    assert body["anchors"] is None
    assert not [n for n in _files(_creation_prefix(base)) if n.startswith("cutout")]

    await _detect(client, headers, base)
    body = (await client.patch(base, json={"face_type": "cartoon"}, headers=headers)).json()
    assert body["face_type"] == "cartoon" and body["anchors"] is None
    # The same line again is not a change.
    same = (await client.patch(base, json={"face_type": "cartoon"}, headers=headers)).json()
    assert same["revision"] == body["revision"]


async def test_nothing_can_change_before_the_photo_is_ready(client, gate):
    headers, org_id = await _org(client, "early")
    gate.close()
    response = await _upload(client, headers, org_id)
    base = f"/orgs/{org_id}/creations/{response.json()['id']}"
    early = await client.patch(base, json={"face_type": "animal"}, headers=headers)
    assert early.status_code == 409 and early.json()["code"] == "creation_not_ready"
    gate.open()
    await runner.drain()
    assert (await _get(client, headers, base))["current"] == "original"


# --- background -----------------------------------------------------------------------


async def test_removing_the_background_blanks_the_room_and_keeps_the_marks(client, face, segmenter):
    headers, org_id = await _org(client, "cutter")
    base, _ = await _create(client, headers, org_id)
    anchors = await _detect(client, headers, base)

    response = await client.post(f"{base}/background", json={"mode": "remove"}, headers=headers)
    assert response.status_code == 202, response.text
    assert response.json()["job"]["step"] == "background"
    await runner.drain()
    body = await _get(client, headers, base)
    cutout = _step(body, "cutout")
    assert body["current"] == "cutout" and cutout["from"] == "original"
    assert_scrubbed(await _bytes_at(client, cutout["url"]))
    # No pixel moved, so the marks still hold, bound to the same frame.
    assert body["anchors"]["id"] == anchors["id"]
    assert body["anchors"]["image"] == "original"

    # Keep: back to the photo with its background; the cut-out stays choosable.
    kept = await client.post(f"{base}/background", json={"mode": "keep"}, headers=headers)
    assert kept.status_code == 200
    assert kept.json()["current"] == "original" and _step(kept.json(), "cutout")
    assert kept.json()["anchors"]["id"] == anchors["id"]
    # Remove again: the existing cut-out of this image is simply chosen.
    again = await client.post(f"{base}/background", json={"mode": "remove"}, headers=headers)
    assert again.status_code == 200 and again.json()["current"] == "cutout"


async def test_background_removal_is_offered_to_people_only(client, segmenter):
    headers, org_id = await _org(client, "lines")
    for face_type in ("animal", "cartoon"):
        base, body = await _create(client, headers, org_id, face_type=face_type)
        assert body["background_removal"] == {"available": False, "reason": "not_for_face_type"}
        response = await client.post(f"{base}/background", json={"mode": "remove"}, headers=headers)
        assert response.status_code == 422
        assert response.json()["code"] == "background_not_for_face_type"
        kept = await client.post(f"{base}/background", json={"mode": "keep"}, headers=headers)
        assert kept.status_code == 200


async def test_background_removal_needs_a_segmenter(client, face, no_segmenter):
    headers, org_id = await _org(client, "noseg")
    base, body = await _create(client, headers, org_id)
    assert body["background_removal"]["reason"] == "segmentation_unavailable"
    response = await client.post(f"{base}/background", json={"mode": "remove"}, headers=headers)
    assert response.status_code == 409
    assert response.json()["code"] == "segmentation_unavailable"


# --- choose -------------------------------------------------------------------------------


async def test_choosing_another_frame_clears_the_marks_and_a_cutout_does_not(
    client, face, segmenter
):
    headers, org_id = await _org(client, "chooser")
    base, _ = await _create(client, headers, org_id)
    await client.patch(base, json=REFRAME, headers=headers)
    anchors = await _detect(client, headers, base)
    assert anchors["image"] == "framed"
    await _run(client, headers, "POST", f"{base}/background", json={"mode": "remove"})

    choose = f"{base}/choose"
    to_framed = (await client.post(choose, json={"choice": "framed"}, headers=headers)).json()
    assert to_framed["current"] == "framed" and to_framed["anchors"]["id"] == anchors["id"]
    to_original = (
        await client.post(choose, json={"choice": "original"}, headers=headers)
    ).json()
    assert to_original["current"] == "original" and to_original["anchors"] is None
    assert to_original["revision"] == to_framed["revision"] + 1

    unknown = await client.post(f"{base}/choose", json={"choice": "adjusted:0"}, headers=headers)
    assert unknown.status_code == 422 and unknown.json()["code"] == "unknown_choice"
    raw_key = await client.post(
        choose, json={"choice": f"orgs/{org_id}/creations/x/original.png"}, headers=headers
    )
    assert raw_key.status_code == 422


# --- detect and preview ------------------------------------------------------------------


async def test_a_detected_human_opens_on_its_landmarks_and_may_finish_in_one_click(client, face):
    headers, org_id = await _org(client, "human")
    base, _ = await _create(client, headers, org_id)
    anchors = await _detect(client, headers, base)
    assert anchors["detected"] is True
    assert anchors["image"] == "original"
    assert anchors["image_size"] == [400, 500]
    assert {"head", "left_eye", "right_eye", "mouth", "left_pupil", "right_pupil"} == set(
        anchors["marks"]
    )
    assert anchors["validation"]["ok"] is True
    assert anchors["validation"]["one_click"] is True


async def test_an_animal_is_placed_from_the_template_and_never_one_click(client, face):
    headers, org_id = await _org(client, "animal")
    base, _ = await _create(client, headers, org_id, face_type="animal")
    anchors = await _detect(client, headers, base)
    # The line's detector is the template, even with a face detector present.
    assert anchors["detected"] is False
    assert set(anchors["marks"]) == {"head", "left_eye", "right_eye", "mouth_line", "chin"}
    # The head is eight points: its edges, its temples and its jaw corners.
    assert set(anchors["marks"]["head"]) == {
        "left", "right", "top", "bottom", "upper_left", "upper_right", "lower_right", "lower_left",
    }
    assert anchors["validation"]["ok"] is True
    assert anchors["validation"]["one_click"] is False


async def test_an_undetected_animation_gets_the_template_with_pupils(client):
    headers, org_id = await _org(client, "anime")
    base, _ = await _create(client, headers, org_id, face_type="cartoon")
    anchors = await _detect(client, headers, base)
    assert anchors["detected"] is False
    assert {"mouth_line", "chin", "left_pupil", "right_pupil"} <= set(anchors["marks"])
    assert "mouth" not in anchors["marks"]
    assert anchors["validation"]["one_click"] is False


async def test_the_preview_is_the_rig_finish_would_build_and_saves_nothing(client, face):
    headers, org_id = await _org(client, "previewer")
    base, _ = await _create(client, headers, org_id)
    anchors = await _detect(client, headers, base)
    revision = (await _get(client, headers, base))["revision"]

    response = await client.post(
        f"{base}/preview-rig", json={"anchors_id": anchors["id"]}, headers=headers
    )
    assert response.status_code == 200, response.text
    assert response.json()["reasons"] == []
    assert len(response.json()["rig"]["points"]) == 478

    marks = anchors["marks"]
    swapped = {"left_eye": marks["right_eye"], "right_eye": marks["left_eye"]}
    bad = await client.post(
        f"{base}/preview-rig", json={"anchors_id": anchors["id"], "marks": swapped}, headers=headers
    )
    assert bad.status_code == 200
    assert "eyes_out_of_order" in {r["code"] for r in bad.json()["reasons"]}

    outside = {"head": {**marks["head"], "left": {"x": -5, "y": 10}}}
    refused = await client.post(
        f"{base}/preview-rig", json={"anchors_id": anchors["id"], "marks": outside}, headers=headers
    )
    assert refused.status_code == 422 and refused.json()["code"] == "mark_outside_image"
    line = [{"x": 150 + 20 * i, "y": 350} for i in range(5)]
    human_line = await client.post(
        f"{base}/preview-rig",
        json={"anchors_id": anchors["id"], "marks": {"mouth_line": line}},
        headers=headers,
    )
    assert human_line.status_code == 422
    assert human_line.json()["code"] == "mouth_line_not_for_face_type"
    assert (await _get(client, headers, base))["revision"] == revision


# --- jobs: admission, progress and races ------------------------------------------


async def test_one_job_at_a_time_per_creation(client, face, segmenter, gate):
    headers, org_id = await _org(client, "busy")
    base, _ = await _create(client, headers, org_id)
    gate.close()
    first = await client.post(f"{base}/detect", headers=headers)
    assert first.status_code == 202
    body = await _until_running(client, headers, base)
    assert body["job"]["progress"]["fraction"] > 0

    for method, suffix, payload in (
        ("POST", "/detect", None),
        ("POST", "/background", {"mode": "remove"}),
    ):
        response = await client.request(method, base + suffix, json=payload, headers=headers)
        assert response.status_code == 409, suffix
        assert response.json()["code"] == "job_in_progress"
    gate.open()
    await runner.drain()
    assert (await _get(client, headers, base))["job"]["state"] == "done"


async def test_a_busy_org_and_a_full_queue_say_when_to_come_back(client, monkeypatch):
    headers, org_id = await _org(client, "queue")
    monkeypatch.setattr(runner, "max_per_org", 0)
    busy = await _upload(client, headers, org_id)
    assert busy.status_code == 429
    assert busy.json()["code"] == "too_many_jobs"
    assert int(busy.headers["retry-after"]) > 0

    monkeypatch.setattr(runner, "max_per_org", 2)
    monkeypatch.setattr(runner, "max_active", 0)
    full = await _upload(client, headers, org_id)
    assert full.status_code == 503
    assert full.json()["code"] == "job_queue_full"
    assert int(full.headers["retry-after"]) > 0
    # Refused uploads leave nothing behind.
    assert await _get(client, headers, f"/orgs/{org_id}/creations") == []
    assert _files(f"orgs/{org_id}/creations/") == []


async def test_a_cutout_finished_after_the_line_changed_is_discarded(client, face, segmenter, gate):
    headers, org_id = await _org(client, "racer")
    base, _ = await _create(client, headers, org_id)
    gate.close()
    await client.post(f"{base}/background", json={"mode": "remove"}, headers=headers)
    await _until_running(client, headers, base)
    changed = await client.patch(base, json={"face_type": "cartoon"}, headers=headers)
    assert changed.status_code == 200
    gate.open()
    await runner.drain()

    body = await _get(client, headers, base)
    assert _step(body, "cutout") is None and body["current"] == "original"
    assert body["job"]["state"] == "failed"
    assert body["job"]["error"]["code"] == "superseded"
    assert body["revision"] == changed.json()["revision"]
    assert [n.split("-")[0] for n in _files(_creation_prefix(base))] == ["original"]


async def test_marks_found_on_an_image_no_longer_chosen_are_discarded(client, face, gate):
    headers, org_id = await _org(client, "racer2")
    base, _ = await _create(client, headers, org_id)
    await client.patch(base, json=REFRAME, headers=headers)
    gate.close()
    await client.post(f"{base}/detect", headers=headers)
    await _until_running(client, headers, base)
    chose = await client.post(f"{base}/choose", json={"choice": "original"}, headers=headers)
    assert chose.status_code == 200
    gate.open()
    await runner.drain()
    body = await _get(client, headers, base)
    assert body["anchors"] is None
    assert body["job"]["error"]["code"] == "superseded"
    assert body["job"]["retryable"] is True


async def test_deleting_during_a_job_leaves_no_files(client, face, segmenter, gate):
    headers, org_id = await _org(client, "deleter")
    base, _ = await _create(client, headers, org_id)
    gate.close()
    await client.post(f"{base}/background", json={"mode": "remove"}, headers=headers)
    await _until_running(client, headers, base)
    assert (await client.delete(base, headers=headers)).status_code == 204
    gate.open()
    await runner.drain()
    assert (await client.get(base, headers=headers)).status_code == 404
    assert _files(_creation_prefix(base)) == []


async def test_a_delete_whose_files_cannot_go_keeps_the_row_to_try_again(client, face, monkeypatch):
    """Files before the row: a row deleted first would leave the photos
    (the raw upload included) with nothing that leads back to them."""
    storage = get_storage()
    headers, org_id = await _org(client, "stubborn")
    base, _ = await _create(client, headers, org_id)
    real_delete_prefix = type(storage).delete_prefix
    failures = iter([OSError("disk said no")])

    async def flaky(self, prefix):
        failure = next(failures, None)
        if failure:
            raise failure
        return await real_delete_prefix(self, prefix)

    monkeypatch.setattr(type(storage), "delete_prefix", flaky)
    with pytest.raises(OSError):
        await client.delete(base, headers=headers)
    assert (await _get(client, headers, base))["status"] == "draft"
    assert _files(_creation_prefix(base))

    assert (await client.delete(base, headers=headers)).status_code == 204
    assert (await client.get(base, headers=headers)).status_code == 404
    assert _files(_creation_prefix(base)) == []


async def test_delete_removes_the_row_and_the_files_now(client, face):
    headers, org_id = await _org(client, "tidy")
    base, _ = await _create(client, headers, org_id)
    crop = {"x": 0.1, "y": 0.1, "w": 0.8, "h": 0.8}
    await client.patch(base, json={"crop": crop}, headers=headers)
    assert len(_files(_creation_prefix(base))) == 2
    assert (await client.delete(base, headers=headers)).status_code == 204
    assert (await client.get(base, headers=headers)).status_code == 404
    assert _files(_creation_prefix(base)) == []


# --- finish -----------------------------------------------------------------------------


async def depiction(client, headers, base: str, scope: str = "depiction") -> str:
    """The uploader's statement by this user about this creation's face (a
    depiction consent, by default): what the dashboard records before
    finishing a person's avatar."""
    from app.services.consent import TEXT_VERSIONS

    org_id, creation_id = base.split("/")[2], base.split("/")[4]
    response = await client.post(
        f"/orgs/{org_id}/consents",
        json={"scope": scope, "text_version": TEXT_VERSIONS[scope], "creation_id": creation_id},
        headers=headers,
    )
    assert response.status_code == 201, response.text
    return response.json()["id"]


async def _finish(client, headers, base, anchors_id: str, marks=None, name="Ada"):
    payload = {
        "name": name,
        "anchors_id": anchors_id,
        "consent_id": await depiction(client, headers, base),
    }
    if marks is not None:
        payload["marks"] = marks
    return await client.post(f"{base}/finish", json=payload, headers=headers)


async def test_finishing_builds_publishes_and_lets_the_creation_go(client, face):
    headers, org_id = await _org(client, "finisher")
    base, _ = await _create(client, headers, org_id)
    anchors = await _detect(client, headers, base)

    response = await _finish(client, headers, base, anchors["id"])
    assert response.status_code == 202, response.text
    avatar_id = response.json()["avatar_id"]
    assert response.json()["creation"]["status"] == "finishing"
    await runner.drain()

    creation = await _get(client, headers, base)
    assert creation["status"] == "finished"
    assert creation["avatar_id"] == avatar_id
    assert creation["job"]["state"] == "done"

    avatar = await _get(client, headers, f"/orgs/{org_id}/avatars/{avatar_id}")
    assert avatar["status"] == "ready"
    assert avatar["name"] == "Ada" and avatar["face_type"] == "human"
    # Finishing IS the owner's confirmation: the avatar is live.
    assert avatar["published"] is True and avatar["unpublished"] is False
    rig = (await client.get(avatar["rig_url"])).json()
    assert rig["user_anchors"]["source"] == "owner"
    assert "render_profile" not in rig

    prefix = f"orgs/{org_id}/avatars/{avatar_id}/"
    row = await _avatar_row(avatar_id)
    for key in (row.image_key, row.upload_image_key, row.rig_key, row.thumbnail_key):
        assert key.startswith(prefix), key
    assert row.original_image_key is None  # nothing was cut out
    files = _files(prefix)
    assert {"rig.json", "fit-base.json"} <= set(files)
    assert any(f.startswith("published/r0/") for f in files)
    # The wizard's copies are gone; the avatar holds its own.
    assert _files(_creation_prefix(base)) == []
    # The avatar page's marking panel reads the same marks back.
    marks = await client.get(f"/orgs/{org_id}/avatars/{avatar_id}/rig-anchors", headers=headers)
    assert marks.status_code == 200


async def test_a_cutout_finishes_with_its_original_and_no_room_behind_it(client, face, segmenter):
    headers, org_id = await _org(client, "cutfinish")
    base, _ = await _create(client, headers, org_id)
    anchors = await _detect(client, headers, base)
    await _run(client, headers, "POST", f"{base}/background", json={"mode": "remove"})
    finish = {
        "name": "Cut", "anchors_id": anchors["id"],
        "consent_id": await depiction(client, headers, base),
    }
    await _run(client, headers, "POST", f"{base}/finish", json=finish)
    avatar_id = (await _get(client, headers, base))["avatar_id"]

    from app.services.publishing import config_of

    row = await _avatar_row(avatar_id)
    storage = get_storage()
    prefix = f"orgs/{org_id}/avatars/{avatar_id}/"
    assert row.original_image_key.startswith(prefix)
    assert row.upload_image_key.startswith(prefix)
    # The cut-out, as drafted and as published, holds nothing behind it.
    assert_scrubbed(await storage.get_bytes(row.image_key))
    published = config_of(row)
    assert_scrubbed(await storage.get_bytes(published["image_key"]))
    # The photos with the room in them stay private to the owner: kept for
    # "restore background" and for starting over, never published.
    for private in (row.original_image_key, row.upload_image_key):
        assert Image.open(io.BytesIO(await storage.get_bytes(private))).mode == "RGB"
        assert private not in {v for v in published.values() if isinstance(v, str)}
    avatar = await _get(client, headers, f"/orgs/{org_id}/avatars/{avatar_id}")
    assert avatar["original_image_key"] is not None  # the avatar page offers "restore"
    # A human gets its head/body layers, cut from the cut-out's own alpha.
    assert avatar["layer_urls"] and "background" not in avatar["layer_urls"]


async def test_finish_is_idempotent(client, face, gate):
    headers, org_id = await _org(client, "twice")
    base, _ = await _create(client, headers, org_id)
    anchors = await _detect(client, headers, base)
    gate.close()
    first = await _finish(client, headers, base, anchors["id"])
    second = await _finish(client, headers, base, anchors["id"])
    assert first.status_code == second.status_code == 202
    assert first.json()["avatar_id"] == second.json()["avatar_id"]
    deleting = await client.delete(base, headers=headers)
    assert deleting.status_code == 409 and deleting.json()["code"] == "creation_finishing"
    # Nothing may change under the avatar being built.
    for method, suffix, payload in (
        ("PATCH", "", {"face_type": "cartoon"}),
        ("POST", "/choose", {"choice": "original"}),
        ("POST", "/detect", None),
    ):
        refused = await client.request(method, base + suffix, json=payload, headers=headers)
        assert refused.status_code == 409, suffix
        assert refused.json()["code"] == "creation_not_draft"
    gate.open()
    await runner.drain()
    third = await _finish(client, headers, base, anchors["id"])
    assert third.json()["avatar_id"] == first.json()["avatar_id"]
    assert len(await _get(client, headers, f"/orgs/{org_id}/avatars")) == 1


async def test_marks_placed_on_another_image_are_refused(client, face):
    headers, org_id = await _org(client, "stale")
    base, _ = await _create(client, headers, org_id)
    old = await _detect(client, headers, base)
    await client.patch(base, json=REFRAME, headers=headers)
    cleared = await _finish(client, headers, base, old["id"])
    assert cleared.status_code == 409 and cleared.json()["code"] == "anchors_stale"
    new = await _detect(client, headers, base)
    stale = await _finish(client, headers, base, old["id"])
    assert stale.status_code == 409 and stale.json()["code"] == "anchors_stale"
    preview = await client.post(
        f"{base}/preview-rig", json={"anchors_id": old["id"]}, headers=headers
    )
    assert preview.status_code == 409 and preview.json()["code"] == "anchors_stale"
    assert (await _finish(client, headers, base, new["id"])).status_code == 202
    await runner.drain()


async def test_a_fit_that_folds_is_refused_with_its_reasons(client, face):
    headers, org_id = await _org(client, "folder")
    base, _ = await _create(client, headers, org_id)
    anchors = await _detect(client, headers, base)
    marks = anchors["marks"]
    response = await _finish(
        client, headers, base, anchors["id"],
        marks={"left_eye": marks["right_eye"], "right_eye": marks["left_eye"]},
    )
    assert response.status_code == 422
    assert response.json()["code"] == "fit_invalid"
    assert "eyes_out_of_order" in {r["code"] for r in response.json()["reasons"]}
    assert (await _get(client, headers, base))["status"] == "draft"
    assert await _get(client, headers, f"/orgs/{org_id}/avatars") == []


async def test_an_animal_is_never_finished_on_the_template_guess(client):
    headers, org_id = await _org(client, "petowner")
    base, _ = await _create(client, headers, org_id, face_type="animal")
    anchors = await _detect(client, headers, base)
    bare = await _finish(client, headers, base, anchors["id"])
    assert bare.status_code == 422 and bare.json()["code"] == "marks_required"
    head_only = {"head": anchors["marks"]["head"]}
    partial = await _finish(client, headers, base, anchors["id"], marks=head_only)
    assert partial.status_code == 422
    assert set(partial.json()["missing"]) == {"left_eye", "right_eye", "mouth_line", "chin"}

    response = await _finish(
        client, headers, base, anchors["id"], marks=anchors["marks"], name="Rex"
    )
    assert response.status_code == 202, response.text
    await runner.drain()
    avatar_id = response.json()["avatar_id"]
    avatar = await _get(client, headers, f"/orgs/{org_id}/avatars/{avatar_id}")
    assert avatar["face_type"] == "animal" and avatar["published"] is True
    assert avatar["layer_urls"] is None  # no layers for animals yet
    rig = (await client.get(avatar["rig_url"])).json()
    assert rig["render_profile"] == "animal@2"


@pytest.mark.parametrize(
    "face_type, parts",
    [
        ("cartoon", {"head", "left_eye", "right_eye", "mouth_line", "chin", "left_pupil", "right_pupil"}),
        ("human", {"head", "left_eye", "right_eye", "mouth", "left_pupil", "right_pupil"}),
    ],
)
async def test_marks_the_detector_did_not_find_are_never_finished_as_guessed(
    client, face_type, parts
):
    """No face found, so the marks opened on the face template: whatever the
    line, each part is the owner's to place, as an animal's always is."""
    headers, org_id = await _org(client, f"missed-{face_type}")
    base, _ = await _create(client, headers, org_id, face_type=face_type)
    anchors = await _detect(client, headers, base)
    assert anchors["detected"] is False
    bare = await _finish(client, headers, base, anchors["id"])
    assert bare.status_code == 422 and bare.json()["code"] == "marks_required"
    assert set(bare.json()["missing"]) == parts
    some = {part: anchors["marks"][part] for part in ("head", "left_eye")}
    partial = await _finish(client, headers, base, anchors["id"], marks=some)
    assert set(partial.json()["missing"]) == parts - set(some)

    placed = await _finish(client, headers, base, anchors["id"], marks=anchors["marks"])
    assert placed.status_code == 202, placed.text
    await runner.drain()
    assert (await _get(client, headers, base))["status"] == "finished"


async def test_a_failed_finish_goes_back_to_draft_and_can_be_retried(client, face, monkeypatch):
    from app.services import publishing

    headers, org_id = await _org(client, "unlucky")
    base, _ = await _create(client, headers, org_id)
    anchors = await _detect(client, headers, base)
    real_publish = publishing.publish

    async def broken(avatar, storage):
        raise RuntimeError("storage fell over")

    monkeypatch.setattr(publishing, "publish", broken)
    response = await _finish(client, headers, base, anchors["id"])
    failed_avatar = response.json()["avatar_id"]
    await runner.drain()
    body = await _get(client, headers, base)
    assert body["status"] == "draft" and body["avatar_id"] is None
    assert body["job"]["state"] == "failed" and body["job"]["retryable"] is True
    assert await _avatar_row(failed_avatar) is None
    assert _files(f"orgs/{org_id}/avatars/{failed_avatar}/") == []

    monkeypatch.setattr(publishing, "publish", real_publish)
    retried = await _run(client, headers, "POST", f"{base}/retry")
    assert retried.status_code == 202, retried.text
    body = await _get(client, headers, base)
    assert body["status"] == "finished"
    assert (await _get(client, headers, f"/orgs/{org_id}/avatars/{body['avatar_id']}"))["published"]


# --- restart recovery, retry and expiry ---------------------------------------------


async def _restart() -> int:
    """What a deploy does to the jobs: the tasks die, the next process
    starts and recovers."""
    await runner.shutdown()
    async with get_session_factory()() as db:
        return await svc.recover_interrupted(db)


async def test_a_restart_mid_finish_leaves_a_retryable_draft(client, face, gate):
    headers, org_id = await _org(client, "restarted")
    base, _ = await _create(client, headers, org_id)
    anchors = await _detect(client, headers, base)
    gate.close()
    response = await _finish(client, headers, base, anchors["id"])
    lost_avatar = response.json()["avatar_id"]
    await _until_running(client, headers, base)

    assert await _restart() == 1
    body = await _get(client, headers, base)
    assert body["status"] == "draft" and body["avatar_id"] is None
    assert body["job"]["state"] == "interrupted" and body["job"]["retryable"] is True
    assert await _avatar_row(lost_avatar) is None
    assert _files(f"orgs/{org_id}/avatars/{lost_avatar}/") == []

    gate.open()
    retried = await _run(client, headers, "POST", f"{base}/retry")
    assert retried.status_code == 202, retried.text
    body = await _get(client, headers, base)
    assert body["status"] == "finished" and body["avatar_id"] != lost_avatar


class _Unreachable:
    """What a locked database does to the writes of a failing finish."""

    def __init__(self, monkeypatch, undo_failures: int):
        from app.services import publishing

        self.undo_failures = undo_failures
        self.real_undo = svc._undo_finish
        self.real_publish = publishing.publish
        self._monkeypatch = monkeypatch
        from app.services.creations import finish

        monkeypatch.setattr(finish, "UNDO_FINISH_BACKOFF_SECONDS", (0.0, 0.0))
        monkeypatch.setattr(publishing, "publish", self.publish)
        monkeypatch.setattr(finish, "_undo_finish", self.undo)

    async def publish(self, avatar, storage):
        raise RuntimeError("database is locked")

    async def undo(self, *args):
        if self.undo_failures:
            self.undo_failures -= 1
            raise RuntimeError("database is locked")
        await self.real_undo(*args)

    def heal(self) -> None:
        from app.services import publishing

        self._monkeypatch.setattr(publishing, "publish", self.real_publish)


async def _failed_finish(client, headers, base) -> str:
    anchors = await _detect(client, headers, base)
    response = await _finish(client, headers, base, anchors["id"])
    assert response.status_code == 202, response.text
    await runner.drain()
    return response.json()["avatar_id"]


async def test_a_finish_whose_undo_fails_once_is_undone_on_the_next_try(client, face, monkeypatch):
    headers, org_id = await _org(client, "locked-once")
    base, _ = await _create(client, headers, org_id)
    _Unreachable(monkeypatch, undo_failures=1)
    avatar_id = await _failed_finish(client, headers, base)
    body = await _get(client, headers, base)
    assert body["status"] == "draft" and body["avatar_id"] is None
    assert body["job"]["retryable"] is True
    assert await _avatar_row(avatar_id) is None


async def test_a_finish_stranded_by_a_failed_undo_is_recovered_by_the_sweeper(
    client, face, monkeypatch
):
    """Nothing the owner can press moves a creation left finishing with no
    task on it (Finish answers with the avatar, Delete refuses), so the
    sweeper puts it back."""
    from app.services import sweeper

    headers, org_id = await _org(client, "locked")
    base, _ = await _create(client, headers, org_id)
    database = _Unreachable(monkeypatch, undo_failures=99)
    avatar_id = await _failed_finish(client, headers, base)
    body = await _get(client, headers, base)
    assert body["status"] == "finishing"
    assert body["job"]["state"] == "failed" and body["job"]["retryable"] is True

    database.undo_failures = 0
    await sweeper.sweep_once()
    body = await _get(client, headers, base)
    assert body["status"] == "draft" and body["avatar_id"] is None
    assert body["job"]["state"] == "failed" and body["job"]["retryable"] is True
    assert await _avatar_row(avatar_id) is None
    assert _files(f"orgs/{org_id}/avatars/{avatar_id}/") == []

    database.heal()
    retried = await _run(client, headers, "POST", f"{base}/retry")
    assert retried.status_code == 202, retried.text
    assert (await _get(client, headers, base))["status"] == "finished"


async def test_a_restart_recovers_a_finish_stranded_whatever_its_job_says(
    client, face, monkeypatch
):
    headers, org_id = await _org(client, "locked-restart")
    base, _ = await _create(client, headers, org_id)
    database = _Unreachable(monkeypatch, undo_failures=99)
    avatar_id = await _failed_finish(client, headers, base)
    database.undo_failures = 0
    assert await _restart() == 1
    body = await _get(client, headers, base)
    assert body["status"] == "draft" and body["job"]["state"] == "failed"
    assert await _avatar_row(avatar_id) is None


async def test_the_sweeper_leaves_a_finish_that_is_still_running_alone(client, face, gate):
    headers, org_id = await _org(client, "patient")
    base, _ = await _create(client, headers, org_id)
    anchors = await _detect(client, headers, base)
    gate.close()
    await _finish(client, headers, base, anchors["id"])
    await _until_running(client, headers, base)
    assert await svc.recover_stranded() == 0
    assert (await _get(client, headers, base))["status"] == "finishing"
    gate.open()
    await runner.drain()
    assert (await _get(client, headers, base))["status"] == "finished"


async def test_a_job_record_left_running_without_a_task_becomes_interrupted(client, face):
    """The job's own FAILED write can fail too; its record then says
    running forever and the wizard polls forever."""
    headers, org_id = await _org(client, "ghost")
    base, body = await _create(client, headers, org_id)
    creation_id = body["id"]
    async with get_session_factory()() as db:
        await db.execute(
            update(Creation)
            .where(Creation.id == creation_id)
            .values(job={**body["job"], "state": "running", "params": {}})
        )
        await db.commit()
    assert await svc.recover_stranded() == 1
    job = (await _get(client, headers, base))["job"]
    assert job["state"] == "interrupted" and job["retryable"] is True


async def test_an_interrupted_upload_is_retried_from_what_was_received(client, face, gate):
    headers, org_id = await _org(client, "reupload")
    gate.close()
    response = await _upload(client, headers, org_id)
    base = f"/orgs/{org_id}/creations/{response.json()['id']}"
    await _until_running(client, headers, base)
    assert await _restart() == 1
    body = await _get(client, headers, base)
    assert body["job"]["step"] == "ingest" and body["job"]["state"] == "interrupted"

    gate.open()
    assert (await _run(client, headers, "POST", f"{base}/retry")).status_code == 202
    body = await _get(client, headers, base)
    assert body["current"] == "original"
    assert [n.split("-")[0] for n in _files(_creation_prefix(base))] == ["original"]
    nothing = await client.post(f"{base}/retry", headers=headers)
    assert nothing.status_code == 409 and nothing.json()["code"] == "nothing_to_retry"


async def test_an_interrupted_background_removal_is_retryable(client, face, segmenter, gate):
    headers, org_id = await _org(client, "bgretry")
    base, _ = await _create(client, headers, org_id)
    gate.close()
    await client.post(f"{base}/background", json={"mode": "remove"}, headers=headers)
    await _until_running(client, headers, base)
    await _restart()
    assert (await _get(client, headers, base))["job"]["state"] == "interrupted"
    gate.open()
    assert (await _run(client, headers, "POST", f"{base}/retry")).status_code == 202
    assert (await _get(client, headers, base))["current"] == "cutout"


async def _age(creation_id: str, days: float) -> None:
    from datetime import timedelta

    from app.models.base import utcnow

    async with get_session_factory()() as db:
        await db.execute(
            update(Creation)
            .where(Creation.id == creation_id)
            .values(updated_at=utcnow() - timedelta(days=days))
        )
        await db.commit()


async def test_idle_drafts_expire_by_their_rows(client, face):
    headers, org_id = await _org(client, "forgetful")
    idle, _ = await _create(client, headers, org_id)
    fresh, _ = await _create(client, headers, org_id)
    working, _ = await _create(client, headers, org_id)
    idle_id, fresh_id, working_id = (b.rsplit("/", 1)[1] for b in (idle, fresh, working))
    await _age(idle_id, 8)
    await _age(working_id, 8)
    held = runner.reserve(org_id, working_id, "detect", 1)  # a job still running
    try:
        assert await svc.expire_idle() == 1
    finally:
        runner.release(held)

    body = await _get(client, headers, idle)
    assert body["status"] == "expired" and body["steps"] == []
    assert _files(_creation_prefix(idle)) == []
    assert (await _get(client, headers, fresh))["status"] == "draft"
    assert (await _get(client, headers, working))["status"] == "draft"
    assert _files(_creation_prefix(working))
    gone = await client.post(f"{idle}/detect", headers=headers)
    assert gone.status_code == 409 and gone.json()["code"] == "creation_not_draft"

    # Ended rows are purged after their retention; drafts never are.
    await _age(idle_id, 31)
    await svc.expire_idle()
    assert (await client.get(idle, headers=headers)).status_code == 404
    assert (await _get(client, headers, fresh))["status"] == "draft"


async def test_the_sweeper_expires_creations(client, face, monkeypatch):
    from app.services import sweeper

    headers, org_id = await _org(client, "swept")
    idle, _ = await _create(client, headers, org_id)
    await _age(idle.rsplit("/", 1)[1], 8)
    monkeypatch.setattr(config.get_settings(), "candidate_retention_hours", 0, raising=False)
    await sweeper.sweep_once()
    assert (await _get(client, headers, idle))["status"] == "expired"


async def test_finished_rows_do_not_count_as_drafts(client, face, monkeypatch):
    monkeypatch.setattr(svc.rules, "MAX_DRAFTS_PER_ORG", 1)
    headers, org_id = await _org(client, "counted")
    base, _ = await _create(client, headers, org_id)
    anchors = await _detect(client, headers, base)
    finish = {
        "name": "A", "anchors_id": anchors["id"],
        "consent_id": await depiction(client, headers, base),
    }
    await _run(client, headers, "POST", f"{base}/finish", json=finish)
    assert (await _get(client, headers, base))["status"] == CreationStatus.finished.value
    assert (await _upload(client, headers, org_id)).status_code == 202
    await runner.drain()
