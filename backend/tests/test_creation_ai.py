"""The creation wizard's AI steps over the API: adjust, AI points, generation,
the consents they need, the budget and metering, and the disclosure an
AI-made avatar carries to visitors.

No provider is ever called. `FakeImages` replaces the two imagegen calls
the wizard makes (edit_image, create_image) and answers from a script: echo
what was sent, return a given picture, refuse on safety grounds, or fail.
`FakeVision` replaces the point finder's request. `Faces` stands in for
MediaPipe: the face template in the middle of every image, and, on the
1024 px face crop a touch-up sends, the same face carried through the crop,
so an echoed crop is found where it really is. A test can change the face
(closed eyes, a turned head...) on images of a given size, with the helpers
of tests.test_photo_analysis, so the photo check sees what it would on a
real photo.
"""

import io
import json

import numpy as np
import pytest
from PIL import Image
from sqlalchemy import select, update

from app.db import get_session_factory
from app.models import Avatar, Creation, UsageEvent
from app.services import face_template, imagegen, landmarks, photo_adjust as pa
from app.services import vision_points as vp
from app.services.consent import TEXT_VERSIONS
from app.services.usage import GENERATED_AVATAR_KIND, IMAGE_KIND, VISION_KIND
from tests.conftest import create_org, register_and_login
from app.services.jobs import runner
from tests.test_creations import (  # noqa: F401  (segmenter and gate are fixtures)
    _create,
    _detect,
    _get,
    _run,
    depiction,
    gate,
    portrait,
    segmenter,
)
from tests.test_photo_analysis import looking, turned, with_eyes, with_mouth
from tests.test_vision_points import answer_for, face_in_pixels

WIDTH, HEIGHT = 400, 500  # tests.test_creations.portrait()
# A portrait whose face the photo check finds nothing wrong with: at 400 px
# wide the template face is 160 px across, which it calls low resolution.
GOOD = (600, 750)

CHANGES = {
    "closed": lambda p: with_eyes(p, 0.02),
    "aside": lambda p: looking(p, 0.6),
    "open": lambda p: with_mouth(p, 0.25),
    "turned": lambda p: turned(p, 0.6),
}


# --- fakes ------------------------------------------------------------------------


def face_box(size) -> tuple[float, float, float, float]:
    width, height = size
    return (0.3 * width, 0.2 * height, 0.7 * width, 0.7 * height)


class Faces:
    """landmarks.detect: a frontal face in the middle of every image, and
    on a touch-up's face crop, the photo's face as the crop shows it."""

    def __init__(self, monkeypatch):
        self.by_size: dict[tuple[int, int], np.ndarray] = {}
        # Applied to the next detection of a photo-sized image only.
        self.next_photo: str | None = None
        # Applied to every detection of an image of that size (CHANGES).
        self.changes: dict[tuple[int, int], str] = {}
        self.none_for: set[tuple[int, int]] = set()
        monkeypatch.setattr(landmarks, "detect", self.detect)
        photo = face_template.place(face_box((WIDTH, HEIGHT)))
        box = pa.face_crop_box(photo)
        self.by_size[(pa.CROP_SIZE, pa.CROP_SIZE)] = (
            photo - np.array(box[:2])
        ) * (pa.CROP_SIZE / box[2])

    def detect(self, image):
        if image.size in self.none_for:
            return None
        points = self.by_size.get(image.size)
        if points is None:
            points = face_template.place(face_box(image.size))
        points = points.copy()
        if image.size == (WIDTH, HEIGHT) and self.next_photo:
            change, self.next_photo = self.next_photo, None
            points = CHANGES[change](points)
        if image.size in self.changes:
            points = CHANGES[self.changes[image.size]](points)
        return landmarks.FaceLandmarks(points=points, z=np.zeros(len(points)))


@pytest.fixture
def faces(monkeypatch):
    return Faces(monkeypatch)


def png_of(image: Image.Image) -> bytes:
    out = io.BytesIO()
    image.save(out, format="PNG")
    return out.getvalue()


class FakeImages:
    """imagegen.edit_image / create_image, answering from `script` in turn
    (the last entry repeats). Entries: "echo" (what was sent comes back),
    bytes (that picture), "refuse" (a safety refusal), "error"."""

    def __init__(self, monkeypatch):
        self.script: list = ["echo"]
        self.calls: list[dict] = []
        monkeypatch.setattr(imagegen, "configured", lambda: True)
        monkeypatch.setattr(imagegen, "edit_image", self.edit)
        monkeypatch.setattr(imagegen, "create_image", self.create)

    def _next(self):
        return self.script[min(len(self.calls) - 1, len(self.script) - 1)]

    async def edit(self, prompt, source, mime):
        self.calls.append({"prompt": prompt, "source": source, "mime": mime})
        return self._answer(source)

    async def create(self, prompt):
        self.calls.append({"prompt": prompt, "source": None, "mime": None})
        return self._answer(None)

    def _answer(self, source):
        step = self._next()
        if step == "refuse":
            raise imagegen.ImageGenRefused("IMAGE_SAFETY")
        if step == "error":
            raise RuntimeError("provider down")
        image = source if step == "echo" else step
        return imagegen.Generated(image, "image/png", imagegen.MODEL)


@pytest.fixture
def images(monkeypatch):
    return FakeImages(monkeypatch)


class FakeVision:
    def __init__(self, monkeypatch):
        self.answer = None
        self.error: vp.VisionError | None = None
        self.calls: list[dict] = []
        monkeypatch.setattr(vp, "configured", lambda: True)
        monkeypatch.setattr(vp, "request_points", self.request)

    async def request(self, payload, mime, face_type):
        self.calls.append({"payload": payload, "mime": mime, "face_type": face_type})
        if self.error is not None:
            raise self.error
        return self.answer


@pytest.fixture
def vision(monkeypatch):
    return FakeVision(monkeypatch)


# --- helpers ------------------------------------------------------------------------


async def _org(client, who: str) -> tuple[dict, str]:
    headers = await register_and_login(client, who)
    return headers, await create_org(client, headers)


async def ai_consent(client, headers, org_id) -> str:
    response = await client.post(
        f"/orgs/{org_id}/consents",
        json={"scope": "third_party_ai", "text_version": TEXT_VERSIONS["third_party_ai"]},
        headers=headers,
    )
    assert response.status_code == 201, response.text
    return response.json()["id"]


async def _adjust(client, headers, base, consent_id, mode="touchup", **extra):
    return await _run(
        client, headers, "POST", f"{base}/adjust",
        json={"mode": mode, "consent_id": consent_id, **extra},
    )


async def _usage(org_id: str, kind: str) -> list[str]:
    async with get_session_factory()() as db:
        rows = await db.execute(
            select(UsageEvent.source).where(UsageEvent.org_id == org_id, UsageEvent.kind == kind)
        )
        return [source for (source,) in rows]


def _step(body: dict, step_id: str) -> dict | None:
    return next((s for s in body["steps"] if s["id"] == step_id), None)


async def _finish_and_wait(client, headers, base, marks=None) -> dict:
    """Detect and finish, with the statement the creation says it needs."""
    anchors = await _detect(client, headers, base)
    statement = (await _get(client, headers, base))["statement"]
    payload = {"name": "Ada", "anchors_id": anchors["id"]}
    if statement is not None:
        payload["consent_id"] = await depiction(client, headers, base, statement)
    if marks is not None:
        payload["marks"] = marks
    response = await _run(client, headers, "POST", f"{base}/finish", json=payload)
    assert response.status_code == 202, response.text
    body = await _get(client, headers, base)
    assert body["status"] == "finished", body["job"]
    return body


# --- consent, switch, line ------------------------------------------------------------


async def test_adjusting_needs_this_users_consent_and_the_org_switch(client, faces, images):
    headers, org_id = await _org(client, "asker")
    base, _ = await _create(client, headers, org_id)

    missing = await _adjust(client, headers, base, "not-a-consent")
    assert missing.status_code == 403
    assert missing.json()["code"] == "consent_required"
    assert missing.json()["scope"] == "third_party_ai"

    # A depiction statement is not agreement to send the photo anywhere.
    wrong_scope = await _adjust(client, headers, base, await depiction(client, headers, base))
    assert wrong_scope.status_code == 403

    consent_id = await ai_consent(client, headers, org_id)
    await client.patch(f"/orgs/{org_id}", json={"third_party_ai_enabled": False}, headers=headers)
    off = await _adjust(client, headers, base, consent_id)
    assert off.status_code == 403 and off.json()["code"] == "third_party_ai_disabled"
    body = await _get(client, headers, base)
    assert body["ai"]["enabled"] is False
    assert images.calls == [], "nothing was sent"
    assert body["ai"]["adjust_rounds_left"] == 2, "nothing was spent"


async def test_modes_are_offered_per_line(client, faces, images):
    headers, org_id = await _org(client, "liner")
    consent_id = await ai_consent(client, headers, org_id)
    base, body = await _create(client, headers, org_id, face_type="animal")
    assert body["ai"]["modes"] == ["regenerate"]
    refused = await _adjust(client, headers, base, consent_id, mode="touchup")
    assert refused.status_code == 422 and refused.json()["code"] == "adjust_not_for_face_type"

    human, body = await _create(client, headers, org_id)
    assert body["ai"]["modes"] == ["touchup", "stylise", "regenerate"]
    no_style = await _adjust(client, headers, human, consent_id, mode="stylise")
    assert no_style.status_code == 422 and no_style.json()["code"] == "style_required"


async def test_without_image_generation_configured_nothing_is_spent(client, faces, monkeypatch):
    monkeypatch.setattr(imagegen, "configured", lambda: False)
    headers, org_id = await _org(client, "unkeyed")
    base, _ = await _create(client, headers, org_id)
    response = await _adjust(client, headers, base, await ai_consent(client, headers, org_id))
    assert response.status_code == 409 and response.json()["code"] == "imagegen_unavailable"
    assert (await _get(client, headers, base))["ai"]["adjust_rounds_left"] == 2


async def test_the_monthly_image_limit_refuses_before_anything_is_sent(
    client, faces, images, monkeypatch
):
    from app.core.config import get_settings

    monkeypatch.setattr(get_settings(), "image_generation_monthly_limit", 0, raising=False)
    headers, org_id = await _org(client, "limited")
    base, _ = await _create(client, headers, org_id)
    response = await _adjust(client, headers, base, await ai_consent(client, headers, org_id))
    assert response.status_code == 429 and response.json()["code"] == "image_limit_reached"
    assert images.calls == []


# --- touch-up -----------------------------------------------------------------------


async def test_a_touchup_round_offers_checked_candidates_and_keeps_the_original(
    client, faces, images
):
    headers, org_id = await _org(client, "toucher")
    base, before = await _create(client, headers, org_id)
    consent_id = await ai_consent(client, headers, org_id)

    response = await _adjust(client, headers, base, consent_id)
    assert response.status_code == 202, response.text
    assert response.json()["job"]["step"] == "adjust"
    body = await _get(client, headers, base)
    assert body["job"]["state"] == "done", body["job"]

    # What was sent: the face crop, square, 1024 px, with the touch-up prompt.
    assert len(images.calls) == 2
    for call in images.calls:
        sent = Image.open(io.BytesIO(call["source"]))
        assert sent.size == (pa.CROP_SIZE, pa.CROP_SIZE) and sent.format == "JPEG"
        assert call["prompt"] == pa.TOUCHUP_PROMPT

    # Offered, never chosen: the original is still current.
    assert body["current"] == "original"
    assert [s["id"] for s in body["steps"]] == ["original", "adjusted:0", "adjusted:1"]
    candidate = _step(body, "adjusted:0")
    assert candidate["from"] == "original"
    assert (candidate["width"], candidate["height"]) == (WIDTH, HEIGHT), "the photo's resolution"
    assert candidate["adjust"]["mode"] == "touchup"
    assert candidate["adjust"]["model"] == imagegen.MODEL
    assert candidate["adjust"]["rejected"] is None
    assert candidate["adjust"]["generated_eyes"] is False
    # The same stored image (presigned URLs differ only in their expiry).
    def stored(step):
        return step["url"].split("?", 1)[0]

    assert stored(_step(body, "original")) == stored(_step(before, "original"))

    last = body["ai"]["last_round"]
    assert last["mode"] == "touchup" and last["source"] == "original"
    assert [c["step"] for c in last["candidates"]] == ["adjusted:0", "adjusted:1"]
    assert all(c["ok"] for c in last["candidates"])
    assert body["ai"]["adjust_rounds_left"] == 1

    # Metered: one image event per provider call, with what it was for.
    assert await _usage(org_id, IMAGE_KIND) == ["adjust_touchup", "adjust_touchup"]
    row = (await _row(base))
    assert row.consent_ids == [consent_id]


async def _row(base: str) -> Creation:
    async with get_session_factory()() as db:
        return (
            await db.execute(select(Creation).where(Creation.id == base.rsplit("/", 1)[1]))
        ).scalar_one()


async def test_choosing_a_touchup_and_finishing_discloses_it_to_visitors(client, faces, images):
    headers, org_id = await _org(client, "discloser")
    base, _ = await _create(client, headers, org_id)
    consent_id = await ai_consent(client, headers, org_id)
    await _adjust(client, headers, base, consent_id, count=1)

    chosen = await client.post(f"{base}/choose", json={"choice": "adjusted:0"}, headers=headers)
    assert chosen.status_code == 200, chosen.text
    assert chosen.json()["current"] == "adjusted:0"
    body = await _finish_and_wait(client, headers, base)

    avatar_id = body["avatar_id"]
    avatar = (await client.get(f"/orgs/{org_id}/avatars/{avatar_id}", headers=headers)).json()
    assert avatar["ai_edited"] == {"mode": "touchup", "model": imagegen.MODEL}
    async with get_session_factory()() as db:
        row = (await db.execute(select(Avatar).where(Avatar.id == avatar_id))).scalar_one()
    config = json.loads(row.published_config)
    assert config["disclosure"] == {
        "ai_edited": {"mode": "touchup", "model": imagegen.MODEL}, "line": "human",
    }
    assert consent_id in row.consent_ids and len(row.consent_ids) == 2

    # The widget and the share page both carry it.
    key = await client.post(
        f"/orgs/{org_id}/api-keys", json={"name": "site", "allowed_domains": []}, headers=headers
    )
    embed = await client.get(
        f"/embed/v1/avatars/{avatar_id}", headers={"X-Api-Key": key.json()["plaintext"]}
    )
    assert embed.status_code == 200, embed.text
    assert embed.json()["disclosure"]["ai_edited"]["mode"] == "touchup"
    shared = await client.post(f"/orgs/{org_id}/avatars/{avatar_id}/share", headers=headers)
    token = shared.json()["share_token"]
    public = await client.get(f"/public/v1/avatars/{token}")
    assert public.json()["disclosure"]["line"] == "human"


async def test_closed_eyes_come_back_labelled_as_generated(client, faces, images):
    headers, org_id = await _org(client, "sleepy")
    base, _ = await _create(client, headers, org_id)
    faces.next_photo = "closed"
    await _adjust(client, headers, base, await ai_consent(client, headers, org_id), count=1)
    body = await _get(client, headers, base)
    assert body["job"]["state"] == "done", body["job"]
    assert _step(body, "adjusted:0")["adjust"]["generated_eyes"] is True
    assert body["ai"]["last_round"]["candidates"][0]["generated_eyes"] is True


async def test_a_turned_head_is_skipped_and_costs_nothing(client, faces, images):
    headers, org_id = await _org(client, "turner")
    base, _ = await _create(client, headers, org_id)
    faces.next_photo = "turned"
    await _adjust(client, headers, base, await ai_consent(client, headers, org_id))
    body = await _get(client, headers, base)
    assert body["job"]["state"] == "failed"
    assert body["job"]["error"]["code"] == "face_turned"
    assert body["job"]["retryable"] is False
    assert images.calls == []
    assert body["ai"]["adjust_rounds_left"] == 2, "no call, no round spent"


async def test_the_budget_is_two_rounds_per_creation(client, faces, images):
    headers, org_id = await _org(client, "spender")
    base, _ = await _create(client, headers, org_id)
    consent_id = await ai_consent(client, headers, org_id)
    for _ in range(2):
        assert (await _adjust(client, headers, base, consent_id, count=1)).status_code == 202
    third = await _adjust(client, headers, base, consent_id, count=1)
    assert third.status_code == 409 and third.json()["code"] == "budget_spent"
    body = await _get(client, headers, base)
    assert [s["id"] for s in body["steps"]] == ["original", "adjusted:0", "adjusted:1"]
    assert body["ai"]["adjust_rounds_left"] == 0
    assert len(images.calls) == 2


async def test_a_safety_refusal_is_reported_and_never_retried(client, faces, images):
    images.script = ["refuse"]
    headers, org_id = await _org(client, "refused")
    base, _ = await _create(client, headers, org_id)
    await _adjust(client, headers, base, await ai_consent(client, headers, org_id), count=2)
    body = await _get(client, headers, base)
    assert len(images.calls) == 1, "asked once, not again"
    assert body["job"]["state"] == "done"
    assert [s["id"] for s in body["steps"]] == ["original"]
    (candidate,) = body["ai"]["last_round"]["candidates"]
    assert candidate == {
        "step": None, "ok": False, "generated_eyes": False,
        "reason": {"code": "safety_refused",
                   "detail": "The AI declined to edit this photo, so it was not asked again"},
    }
    assert body["ai"]["adjust_rounds_left"] == 1, "the provider answered: the round is spent"
    assert await _usage(org_id, IMAGE_KIND) == ["adjust_touchup"]


async def test_a_provider_that_never_answers_gives_the_round_back(client, faces, images):
    images.script = ["error"]
    headers, org_id = await _org(client, "outage")
    base, _ = await _create(client, headers, org_id)
    await _adjust(client, headers, base, await ai_consent(client, headers, org_id))
    body = await _get(client, headers, base)
    assert body["job"]["state"] == "failed"
    assert body["job"]["error"]["code"] == "provider_error"
    assert body["job"]["retryable"] is True
    assert body["ai"]["adjust_rounds_left"] == 2
    assert await _usage(org_id, IMAGE_KIND) == [], "an unanswered call is not metered"

    images.script = ["echo"]
    retried = await _run(client, headers, "POST", f"{base}/retry")
    assert retried.status_code == 202, retried.text
    body = await _get(client, headers, base)
    assert body["job"]["state"] == "done" and _step(body, "adjusted:0") is not None


async def test_a_candidate_that_fails_its_checks_is_shown_but_cannot_be_chosen(
    client, faces, images
):
    headers, org_id = await _org(client, "checker")
    base, _ = await _create(client, headers, org_id)
    # A "regenerated" person with different skin.
    recoloured = Image.fromarray(
        np.clip(
            np.asarray(Image.open(io.BytesIO(portrait())), dtype=np.float64) * [0.5, 0.9, 1.6],
            0, 255,
        ).astype(np.uint8)
    )
    images.script = [png_of(recoloured)]
    await _adjust(client, headers, base, await ai_consent(client, headers, org_id),
                  mode="regenerate", count=1)
    body = await _get(client, headers, base)
    step = _step(body, "adjusted:0")
    assert step["adjust"]["rejected"]["code"] == "skin_tone_changed"
    assert body["ai"]["last_round"]["candidates"][0]["ok"] is False

    refused = await client.post(f"{base}/choose", json={"choice": "adjusted:0"}, headers=headers)
    assert refused.status_code == 422 and refused.json()["code"] == "candidate_rejected"
    assert (await _get(client, headers, base))["current"] == "original"


async def test_a_result_without_a_face_is_rejected(client, faces, images):
    headers, org_id = await _org(client, "faceless")
    base, _ = await _create(client, headers, org_id)
    faces.none_for.add((300, 300))
    images.script = [png_of(Image.new("RGB", (300, 300), (120, 120, 120)))]
    await _adjust(client, headers, base, await ai_consent(client, headers, org_id),
                  mode="regenerate", count=1)
    body = await _get(client, headers, base)
    assert _step(body, "adjusted:0")["adjust"]["rejected"]["code"] == "no_face_in_result"


async def test_choosing_a_stylised_result_makes_the_creation_an_animation(client, faces, images):
    headers, org_id = await _org(client, "stylist")
    base, _ = await _create(client, headers, org_id)
    drawn = png_of(Image.new("RGB", (480, 600), (40, 160, 220)))
    images.script = [drawn]
    await _adjust(client, headers, base, await ai_consent(client, headers, org_id),
                  mode="stylise", style="anime", count=1)
    assert "anime" in images.calls[0]["prompt"]
    body = await _get(client, headers, base)
    assert _step(body, "adjusted:0")["adjust"]["style"] == "anime"
    await _detect(client, headers, base)

    chosen = await client.post(f"{base}/choose", json={"choice": "adjusted:0"}, headers=headers)
    assert chosen.status_code == 200, chosen.text
    after = chosen.json()
    assert after["face_type"] == "cartoon"
    assert after["anchors"] is None
    assert after["current"] == "adjusted:0"


async def test_reframing_drops_the_candidates_made_from_the_old_frame(client, faces, images):
    headers, org_id = await _org(client, "reframer")
    base, _ = await _create(client, headers, org_id)
    await _adjust(client, headers, base, await ai_consent(client, headers, org_id), count=1)
    await client.post(f"{base}/choose", json={"choice": "adjusted:0"}, headers=headers)

    reframed = await client.patch(
        base, json={"crop": {"x": 0.05, "y": 0.05, "w": 0.9, "h": 0.9}}, headers=headers
    )
    assert reframed.status_code == 200, reframed.text
    assert [s["id"] for s in reframed.json()["steps"]] == ["original", "framed"]
    assert reframed.json()["current"] == "framed"
    assert reframed.json()["ai"]["adjust_rounds_left"] == 1, "a spent round stays spent"


# --- the recommendation --------------------------------------------------------------


def _good_portrait() -> bytes:
    return portrait(*GOOD)


@pytest.mark.parametrize(
    ("change", "mode", "reasons"),
    [
        (None, "none", []),
        ("closed", "touchup", ["eyes_closed"]),
        ("aside", "touchup", ["gaze_off_camera"]),
        # Closing an open mouth moves the jaw: a regenerate's job.
        ("open", "regenerate", ["mouth_open"]),
        ("turned", "regenerate", ["head_turned"]),
    ],
)
async def test_the_photo_check_recommends_a_fix_only_when_one_is_needed(
    client, faces, change, mode, reasons
):
    headers, org_id = await _org(client, f"analyst{change}")
    if change:
        faces.changes[GOOD] = change
    _, body = await _create(client, headers, org_id, data=_good_portrait())
    assert body["analysis"]["recommendation"] == {
        "image": "original", "mode": mode, "reasons": reasons,
    }
    # Pre-selected in the wizard; nothing when nothing needs fixing.
    assert body["ai"]["suggested"] == ([] if mode == "none" else [mode])
    codes = {c["code"] for c in body["analysis"]["checks"]}
    assert set(reasons) <= codes


async def test_an_animal_is_recommended_a_regenerate_only_for_its_pose(client, faces):
    headers, org_id = await _org(client, "zoo")
    _, frontal = await _create(client, headers, org_id, face_type="animal")
    assert frontal["analysis"]["recommendation"]["mode"] == "none"
    # The detector finds no face on a dog or a cat: that is what it is, not
    # a problem to fix, and nothing paid is pushed for it. Regenerate stays
    # offered, not selected.
    faces.none_for.add((WIDTH, HEIGHT))
    _, unseen = await _create(client, headers, org_id, face_type="animal")
    assert unseen["analysis"]["recommendation"] == {
        "image": "original", "mode": "none", "reasons": [],
    }
    assert unseen["ai"]["suggested"] == []
    assert unseen["ai"]["modes"] == ["regenerate"]
    faces.none_for.clear()
    faces.changes[(WIDTH, HEIGHT)] = "turned"
    _, aside = await _create(client, headers, org_id, face_type="animal")
    assert aside["analysis"]["recommendation"]["reasons"] == ["head_turned"]
    assert aside["ai"]["suggested"] == ["regenerate"]


async def test_the_recommendation_follows_the_current_image(client, faces, images):
    headers, org_id = await _org(client, "follower")
    faces.changes[GOOD] = "turned"
    base, body = await _create(client, headers, org_id, data=_good_portrait())
    assert body["analysis"]["recommendation"]["mode"] == "regenerate"

    # A regenerated picture, facing the camera, is checked when it is made.
    images.script = [portrait(640, 800)]
    await _adjust(client, headers, base, await ai_consent(client, headers, org_id),
                  mode="regenerate", count=1)
    body = await _get(client, headers, base)
    assert body["analysis"]["recommendation"]["image"] == "original", "not chosen yet"
    chosen = await client.post(f"{base}/choose", json={"choice": "adjusted:0"}, headers=headers)
    assert chosen.status_code == 200, chosen.text
    assert chosen.json()["analysis"]["recommendation"] == {
        "image": "adjusted:0", "mode": "none", "reasons": [],
    }
    assert chosen.json()["ai"]["suggested"] == []

    # Back to the photo: its recommendation again.
    back = await client.post(f"{base}/choose", json={"choice": "original"}, headers=headers)
    assert back.json()["analysis"]["recommendation"]["mode"] == "regenerate"


async def test_framing_rechecks_the_photo(client, faces):
    headers, org_id = await _org(client, "reframed")
    faces.changes[GOOD] = "closed"
    base, body = await _create(client, headers, org_id, data=_good_portrait())
    assert body["analysis"]["recommendation"]["reasons"] == ["eyes_closed"]
    # (The fake finds the closed eyes only on images of the upload's size.)
    framed = await client.patch(
        base, json={"crop": {"x": 0.1, "y": 0.1, "w": 0.8, "h": 0.8}}, headers=headers
    )
    assert framed.json()["analysis"]["recommendation"] == {
        "image": "framed", "mode": "none", "reasons": [],
    }
    # Step 1's pre-fill still describes the upload.
    assert framed.json()["analysis"]["face_state"]["eyes_closed"] is True


# --- AI after the background ----------------------------------------------------------


async def _cut_out(client, headers, base) -> dict:
    response = await _run(client, headers, "POST", f"{base}/background", json={"mode": "remove"})
    assert response.status_code == 202, response.text
    body = await _get(client, headers, base)
    assert body["current"] == "cutout" and body["background"] == "remove"
    return body


async def _image_at(client, url: str) -> Image.Image:
    from tests.test_creations import _bytes_at

    return Image.open(io.BytesIO(await _bytes_at(client, url)))


async def test_a_cutout_is_sent_on_grey_never_with_its_background(
    client, faces, images, segmenter  # noqa: F811
):
    headers, org_id = await _org(client, "cutter")
    base, _ = await _create(client, headers, org_id)
    await _cut_out(client, headers, base)

    await _adjust(client, headers, base, await ai_consent(client, headers, org_id),
                  mode="regenerate", count=1)
    body = await _get(client, headers, base)
    assert body["job"]["state"] == "done", body["job"]
    sent = Image.open(io.BytesIO(images.calls[0]["source"]))
    assert sent.format == "JPEG" and sent.mode == "RGB"
    # The segmenter fake calls the left half background: it is flat grey,
    # neither the photo's own pixels nor the black under alpha 0.
    left = np.asarray(sent, dtype=np.float64)[:, : sent.width // 3]
    assert abs(left.mean() - 128) < 2 and left.std() < 3
    candidate = _step(body, "adjusted:0")
    assert candidate["from"] == "cutout" and candidate["cutout"] is False
    assert body["ai"]["last_round"]["source"] == "cutout"


async def test_choosing_a_regenerated_picture_cuts_it_out_again(
    client, faces, images, segmenter  # noqa: F811
):
    headers, org_id = await _org(client, "recutter")
    base, _ = await _create(client, headers, org_id)
    await _cut_out(client, headers, base)
    await _detect(client, headers, base)
    await _adjust(client, headers, base, await ai_consent(client, headers, org_id),
                  mode="regenerate", count=1)

    chosen = await _run(client, headers, "POST", f"{base}/choose", json={"choice": "adjusted:0"})
    assert chosen.status_code == 202, chosen.text
    assert chosen.json()["job"]["step"] == "background"
    assert chosen.json()["current"] == "adjusted:0"
    assert chosen.json()["anchors"] is None, "new pixels: the points are found again"
    body = await _get(client, headers, base)
    assert body["job"]["state"] == "done", body["job"]
    assert body["current"] == "cutout:0"
    assert [s["id"] for s in body["steps"]] == ["original", "cutout", "adjusted:0", "cutout:0"]
    cut = _step(body, "cutout:0")
    assert cut["from"] == "adjusted:0" and cut["cutout"] is True
    image = await _image_at(client, cut["url"])
    assert image.mode == "RGBA" and np.asarray(image)[:, :10, 3].max() == 0
    assert body["analysis"]["recommendation"]["image"] == "cutout:0"
    job_id = body["job"]["id"]

    # Undo: the picture before AI, then the AI one again, with no new work.
    undo = await client.post(f"{base}/choose", json={"choice": "cutout"}, headers=headers)
    assert undo.status_code == 200 and undo.json()["current"] == "cutout"
    again = await client.post(f"{base}/choose", json={"choice": "adjusted:0"}, headers=headers)
    assert again.status_code == 200, again.text
    assert again.json()["current"] == "cutout:0"
    assert again.json()["job"]["id"] == job_id

    # Points on the new picture, and the avatar says it was regenerated.
    anchors = await _detect(client, headers, base)
    assert anchors["image"] == "adjusted:0"
    finished = await _finish_and_wait(client, headers, base)
    async with get_session_factory()() as db:
        avatar = await db.get(Avatar, finished["avatar_id"])
    assert avatar.ai_edited == {"mode": "regenerate", "model": imagegen.MODEL}
    assert avatar.original_image_key, "the background can be put back: the AI picture's"


async def test_a_choice_whose_cutout_cannot_start_is_not_made(
    client, faces, images, segmenter, gate  # noqa: F811
):
    headers, org_id = await _org(client, "atomic")
    base, _ = await _create(client, headers, org_id)
    await _cut_out(client, headers, base)
    await _adjust(client, headers, base, await ai_consent(client, headers, org_id),
                  mode="regenerate", count=1)
    gate.close()
    busy = await client.post(f"{base}/detect", headers=headers)
    assert busy.status_code == 202
    refused = await client.post(f"{base}/choose", json={"choice": "adjusted:0"}, headers=headers)
    assert refused.status_code == 409 and refused.json()["code"] == "job_in_progress"
    gate.open()
    await runner.drain()
    body = await _get(client, headers, base)
    assert body["current"] == "cutout", "the choice was not made without its cut-out"


async def test_with_the_background_kept_a_regenerated_picture_is_used_as_is(
    client, faces, images, segmenter  # noqa: F811
):
    headers, org_id = await _org(client, "keeper")
    base, _ = await _create(client, headers, org_id)
    kept = await client.post(f"{base}/background", json={"mode": "keep"}, headers=headers)
    assert kept.status_code == 200 and kept.json()["background"] == "keep"
    await _adjust(client, headers, base, await ai_consent(client, headers, org_id),
                  mode="regenerate", count=1)
    chosen = await client.post(f"{base}/choose", json={"choice": "adjusted:0"}, headers=headers)
    assert chosen.status_code == 200, chosen.text
    assert chosen.json()["current"] == "adjusted:0"
    assert _step(chosen.json(), "cutout:0") is None


async def test_a_touchup_of_a_cutout_is_a_cutout(client, faces, images, segmenter):  # noqa: F811
    headers, org_id = await _org(client, "retoucher")
    base, _ = await _create(client, headers, org_id)
    before = await _cut_out(client, headers, base)
    cut = await _image_at(client, _step(before, "cutout")["url"])

    await _adjust(client, headers, base, await ai_consent(client, headers, org_id), count=1)
    body = await _get(client, headers, base)
    assert body["job"]["state"] == "done", body["job"]
    candidate = _step(body, "adjusted:0")
    assert candidate["from"] == "cutout" and candidate["cutout"] is True
    touched = await _image_at(client, candidate["url"])
    assert touched.mode == "RGBA"
    assert np.array_equal(np.asarray(touched.getchannel("A")), np.asarray(cut.getchannel("A")))

    # Already a cut-out: chosen as it is, nothing chained.
    chosen = await client.post(f"{base}/choose", json={"choice": "adjusted:0"}, headers=headers)
    assert chosen.status_code == 200 and chosen.json()["current"] == "adjusted:0"
    # "Remove" again changes nothing; "Keep" goes back to the photo behind it.
    again = await client.post(f"{base}/background", json={"mode": "remove"}, headers=headers)
    assert again.status_code == 200 and again.json()["current"] == "adjusted:0"
    kept = await client.post(f"{base}/background", json={"mode": "keep"}, headers=headers)
    assert kept.json()["current"] == "original" and kept.json()["background"] == "keep"

    await client.post(f"{base}/choose", json={"choice": "adjusted:0"}, headers=headers)
    finished = await _finish_and_wait(client, headers, base)
    async with get_session_factory()() as db:
        avatar = await db.get(Avatar, finished["avatar_id"])
    assert avatar.ai_edited["mode"] == "touchup"
    # The background put back keeps the touched-up eyes: the touch-up over
    # the photo it was cut from, opaque.
    from app.services.storage import get_storage

    behind = Image.open(io.BytesIO(await get_storage().get_bytes(avatar.original_image_key)))
    assert behind.mode == "RGB" and behind.size == (WIDTH, HEIGHT)
    expected = Image.alpha_composite(
        Image.open(io.BytesIO(portrait())).convert("RGBA"), touched.convert("RGBA")
    ).convert("RGB")
    assert np.array_equal(np.asarray(behind), np.asarray(expected))


async def test_a_stylised_result_keeps_its_drawn_backdrop(
    client, faces, images, segmenter  # noqa: F811
):
    headers, org_id = await _org(client, "drawn")
    base, _ = await _create(client, headers, org_id)
    await _cut_out(client, headers, base)
    images.script = [png_of(Image.new("RGB", (480, 600), (40, 160, 220)))]
    await _adjust(client, headers, base, await ai_consent(client, headers, org_id),
                  mode="stylise", style="anime", count=1)
    chosen = await client.post(f"{base}/choose", json={"choice": "adjusted:0"}, headers=headers)
    assert chosen.status_code == 200, chosen.text
    after = chosen.json()
    # An animation has no segmenter: no cut-out is made, and the cut-outs of
    # the photo line are gone with it.
    assert after["face_type"] == "cartoon" and after["background"] == "keep"
    assert after["current"] == "adjusted:0"
    assert [s["id"] for s in after["steps"]] == ["original", "adjusted:0"]
    assert _step(after, "adjusted:0")["from"] == "original", "its lineage still walks"


async def test_reframing_drops_the_ai_pictures_and_their_cutouts(
    client, faces, images, segmenter  # noqa: F811
):
    headers, org_id = await _org(client, "reframer2")
    base, _ = await _create(client, headers, org_id)
    await _cut_out(client, headers, base)
    await _adjust(client, headers, base, await ai_consent(client, headers, org_id),
                  mode="regenerate", count=1)
    await _run(client, headers, "POST", f"{base}/choose", json={"choice": "adjusted:0"})
    assert (await _get(client, headers, base))["current"] == "cutout:0"
    reframed = await client.patch(
        base, json={"crop": {"x": 0.05, "y": 0.05, "w": 0.9, "h": 0.9}}, headers=headers
    )
    assert [s["id"] for s in reframed.json()["steps"]] == ["original", "framed"]
    assert reframed.json()["current"] == "framed"
    from tests.test_creations import _creation_prefix, _files

    names = _files(_creation_prefix(base))
    assert not [n for n in names if n.startswith(("adjusted", "cutout"))], names


async def test_a_draft_made_before_checks_were_kept_has_no_recommendation(client, faces):
    headers, org_id = await _org(client, "legacydraft")
    base, _ = await _create(client, headers, org_id)
    async with get_session_factory()() as db:
        row = (await db.execute(select(Creation).where(Creation.id == base.rsplit("/", 1)[1])))
        creation = row.scalar_one()
        steps = json.loads(json.dumps(creation.steps))
        steps["items"]["original"].pop("check")
        await db.execute(update(Creation).where(Creation.id == creation.id).values(steps=steps))
        await db.commit()
    body = await _get(client, headers, base)
    assert body["analysis"]["recommendation"] is None
    assert body["ai"]["suggested"] == [] and body["background"] is None


async def test_switching_line_asks_the_background_again(client, faces, segmenter):  # noqa: F811
    headers, org_id = await _org(client, "switcher")
    base, _ = await _create(client, headers, org_id)
    await _cut_out(client, headers, base)
    switched = await client.patch(base, json={"face_type": "animal"}, headers=headers)
    assert switched.json()["background"] is None
    assert [s["id"] for s in switched.json()["steps"]] == ["original"]


# --- finishing needs the depiction statement ---------------------------------------------


async def test_a_person_is_finished_only_with_the_uploaders_depiction_statement(client, faces):
    headers, org_id = await _org(client, "depicted")
    base, _ = await _create(client, headers, org_id)
    anchors = await _detect(client, headers, base)
    bare = await client.post(
        f"{base}/finish", json={"name": "A", "anchors_id": anchors["id"]}, headers=headers
    )
    assert bare.status_code == 403
    assert bare.json()["code"] == "consent_required" and bare.json()["scope"] == "depiction"

    # Another member's statement is theirs, not the uploader's.
    invite = await client.post(
        f"/orgs/{org_id}/invitations", json={"email": "colleague@example.com"}, headers=headers
    )
    colleague = await register_and_login(client, "colleague")
    await client.post(f"/invitations/{invite.json()['token']}/accept", headers=colleague)
    theirs = await depiction(client, colleague, base)
    borrowed = await client.post(
        f"{base}/finish",
        json={"name": "A", "anchors_id": anchors["id"], "consent_id": theirs}, headers=headers,
    )
    assert borrowed.status_code == 403
    # An AI consent is not a depiction statement either.
    wrong = await client.post(
        f"{base}/finish",
        json={"name": "A", "anchors_id": anchors["id"],
              "consent_id": await ai_consent(client, headers, org_id)},
        headers=headers,
    )
    assert wrong.status_code == 403
    assert (await _get(client, headers, base))["status"] == "draft"

    mine = await depiction(client, headers, base)
    ok = await _run(
        client, headers, "POST", f"{base}/finish",
        json={"name": "A", "anchors_id": anchors["id"], "consent_id": mine},
    )
    assert ok.status_code == 202
    body = await _get(client, headers, base)
    assert body["status"] == "finished"
    async with get_session_factory()() as db:
        avatar = await db.get(Avatar, body["avatar_id"])
    assert avatar.consent_ids == [mine]
    assert avatar.ai_edited is None, "a photo as given is not AI-edited"


async def test_an_animal_needs_no_depiction_statement(client):
    headers, org_id = await _org(client, "petowner")
    base, _ = await _create(client, headers, org_id, face_type="animal")
    anchors = await _detect(client, headers, base)
    response = await _run(
        client, headers, "POST", f"{base}/finish",
        json={"name": "Rex", "anchors_id": anchors["id"], "marks": anchors["marks"]},
    )
    assert response.status_code == 202, response.text
    assert (await _get(client, headers, base))["status"] == "finished"


# --- AI points ------------------------------------------------------------------------


def _animal_answer(size=(WIDTH, HEIGHT), face_type="animal"):
    face = face_in_pixels(box=(100, 120, 300, 400))
    scaled = {k: (v[0] * size[0] / 600, v[1] * size[1] / 800) for k, v in face.items()}
    return answer_for(scaled, face_type, size)


async def _detect_ai(client, headers, base, consent_id):
    return await _run(
        client, headers, "POST", f"{base}/detect", json={"use_ai": True, "consent_id": consent_id}
    )


async def test_an_animal_opens_on_the_ai_points_as_a_prefill(client, vision):
    headers, org_id = await _org(client, "dogowner")
    base, _ = await _create(client, headers, org_id, face_type="animal")
    consent_id = await ai_consent(client, headers, org_id)
    vision.answer = _animal_answer()

    response = await _detect_ai(client, headers, base, consent_id)
    assert response.status_code == 202, response.text
    body = await _get(client, headers, base)
    anchors = body["anchors"]
    assert anchors["source"] == "ai"
    assert anchors["detected"] is False
    assert anchors["validation"]["ok"] is True and anchors["validation"]["one_click"] is False
    expected = vp.to_marks(vision.answer, (WIDTH, HEIGHT), "animal")
    assert anchors["marks"]["chin"] == expected["chin"]
    assert anchors["marks"]["mouth_line"] == expected["mouth_line"]
    assert vision.calls[0]["face_type"] == "animal" and vision.calls[0]["mime"] == "image/jpeg"
    assert body["ai"]["ai_detections_left"] == 0
    assert await _usage(org_id, VISION_KIND) == ["detect"]
    assert (await _row(base)).consent_ids == [consent_id]

    # A pre-fill, not a confirmation: finishing still wants every part.
    bare = await client.post(
        f"{base}/finish", json={"name": "Rex", "anchors_id": anchors["id"]}, headers=headers
    )
    assert bare.status_code == 422 and bare.json()["code"] == "marks_required"


async def test_the_same_pixels_are_answered_from_the_cache(client, vision):
    headers, org_id = await _org(client, "cached")
    base, _ = await _create(client, headers, org_id, face_type="animal")
    consent_id = await ai_consent(client, headers, org_id)
    vision.answer = _animal_answer()
    await _detect_ai(client, headers, base, consent_id)
    again = await _detect_ai(client, headers, base, consent_id)
    assert again.status_code == 202, again.text
    assert len(vision.calls) == 1
    assert (await _get(client, headers, base))["anchors"]["source"] == "ai"
    assert await _usage(org_id, VISION_KIND) == ["detect"]

    # New pixels, and the one detection is spent.
    await client.patch(base, json={"crop": {"x": 0.05, "y": 0.05, "w": 0.9, "h": 0.9}},
                       headers=headers)
    spent = await _detect_ai(client, headers, base, consent_id)
    assert spent.status_code == 409 and spent.json()["code"] == "budget_spent"
    # By hand still works.
    assert (await _run(client, headers, "POST", f"{base}/detect")).status_code == 202


async def test_a_failed_point_finder_falls_back_to_the_template_and_refunds(client, vision):
    headers, org_id = await _org(client, "fallback")
    base, _ = await _create(client, headers, org_id, face_type="animal")
    vision.error = vp.VisionError("The AI service did not answer")
    await _detect_ai(client, headers, base, await ai_consent(client, headers, org_id))
    body = await _get(client, headers, base)
    assert body["job"]["state"] == "done"
    assert body["anchors"]["source"] == "template"
    assert body["anchors"]["validation"]["warnings"] == [
        {"code": "ai_points_failed", "detail": "The AI service did not answer"}
    ]
    assert body["ai"]["ai_detections_left"] == 1, "nothing answered, nothing spent"
    assert await _usage(org_id, VISION_KIND) == []


async def test_implausible_points_fall_back_but_were_paid_for(client, vision):
    headers, org_id = await _org(client, "implausible")
    base, _ = await _create(client, headers, org_id, face_type="animal")
    answer = _animal_answer()
    vision.answer = {k: [v[1], v[0]] for k, v in answer.items()}  # transposed
    await _detect_ai(client, headers, base, await ai_consent(client, headers, org_id))
    body = await _get(client, headers, base)
    assert body["anchors"]["source"] == "template"
    assert body["anchors"]["validation"]["warnings"][0]["code"] == "ai_points_implausible"
    assert body["ai"]["ai_detections_left"] == 0
    assert await _usage(org_id, VISION_KIND) == ["detect"]


async def test_a_refused_picture_is_reported_and_metered(client, vision):
    headers, org_id = await _org(client, "declined")
    base, _ = await _create(client, headers, org_id, face_type="animal")
    error = vp.VisionRefused("The AI declined this picture (SAFETY)")
    error.answered = True
    vision.error = error
    await _detect_ai(client, headers, base, await ai_consent(client, headers, org_id))
    body = await _get(client, headers, base)
    assert body["anchors"]["validation"]["warnings"][0]["code"] == "safety_refused"
    assert await _usage(org_id, VISION_KIND) == ["detect"]


async def test_ai_points_need_consent_and_are_not_for_people(client, faces, vision):
    headers, org_id = await _org(client, "pointless")
    human, _ = await _create(client, headers, org_id)
    consent_id = await ai_consent(client, headers, org_id)
    refused = await _detect_ai(client, headers, human, consent_id)
    assert refused.status_code == 422 and refused.json()["code"] == "ai_points_not_for_face_type"

    animal, _ = await _create(client, headers, org_id, face_type="animal")
    missing = await _run(client, headers, "POST", f"{animal}/detect", json={"use_ai": True})
    assert missing.status_code == 403 and missing.json()["code"] == "consent_required"
    await client.patch(f"/orgs/{org_id}", json={"third_party_ai_enabled": False}, headers=headers)
    off = await _detect_ai(client, headers, animal, consent_id)
    assert off.status_code == 403 and off.json()["code"] == "third_party_ai_disabled"
    assert vision.calls == []


async def test_an_animation_the_detector_finds_is_not_sent(client, faces, vision):
    headers, org_id = await _org(client, "toonist")
    base, _ = await _create(client, headers, org_id, face_type="cartoon")
    await _detect_ai(client, headers, base, await ai_consent(client, headers, org_id))
    body = await _get(client, headers, base)
    assert body["anchors"]["source"] == "mediapipe"
    assert vision.calls == []
    assert body["ai"]["ai_detections_left"] == 1


async def test_an_animation_the_detector_misses_gets_ai_pupils(client, vision):
    headers, org_id = await _org(client, "toonist2")
    base, _ = await _create(client, headers, org_id, face_type="cartoon")
    vision.answer = _animal_answer(face_type="cartoon")
    await _detect_ai(client, headers, base, await ai_consent(client, headers, org_id))
    anchors = (await _get(client, headers, base))["anchors"]
    assert anchors["source"] == "ai"
    assert {"left_pupil", "right_pupil"} <= set(anchors["marks"])


# --- generation ------------------------------------------------------------------------


async def _generate(client, headers, org_id, **body):
    payload = {"face_type": "human", "style": "illustrated", "prompt": "a friendly baker", **body}
    return await _run(client, headers, "POST", f"/orgs/{org_id}/creations/generate", json=payload)


async def test_a_generated_picture_becomes_the_creations_original(client, faces, images):
    images.script = [png_of(Image.open(io.BytesIO(portrait())))]
    headers, org_id = await _org(client, "maker")
    response = await _generate(client, headers, org_id)
    assert response.status_code == 202, response.text
    assert response.json()["job"]["step"] == "generate"
    base = f"/orgs/{org_id}/creations/{response.json()['id']}"
    body = await _get(client, headers, base)
    assert body["job"]["state"] == "done", body["job"]
    assert body["face_type"] == "human"
    original = _step(body, "original")
    assert original["generated"] == {
        "model": imagegen.MODEL, "style": "illustrated", "provider": "gemini",
        "source_avatar_id": None,
    }
    assert body["analysis"]["detected"] is True
    # A face made from words is nobody: "I am this person" cannot be true
    # of it, so finishing asks for the statement that it is no real person.
    assert body["statement"] == "generated_face"
    assert images.calls[0]["source"] is None
    assert "a friendly baker" in images.calls[0]["prompt"]
    assert await _usage(org_id, IMAGE_KIND) == ["generate"]

    # The wizard carries on as for an upload, and the result is disclosed.
    finished = await _finish_and_wait(client, headers, base)
    async with get_session_factory()() as db:
        avatar = await db.get(Avatar, finished["avatar_id"])
    assert avatar.ai_edited == {"mode": "generate", "model": imagegen.MODEL}
    assert await _usage(org_id, GENERATED_AVATAR_KIND) == ["dashboard"]


async def test_generation_is_off_with_the_switch_and_a_source_needs_consent(
    client, faces, images
):
    from tests.conftest import create_ready_avatar

    headers, org_id = await _org(client, "gated")
    avatar_id = await create_ready_avatar(client, headers, org_id)
    no_consent = await _generate(client, headers, org_id, source_avatar_id=avatar_id)
    assert no_consent.status_code == 403 and no_consent.json()["code"] == "consent_required"

    consent_id = await ai_consent(client, headers, org_id)
    unknown = await _generate(client, headers, org_id, source_avatar_id="nope", consent_id=consent_id)
    assert unknown.status_code == 404

    images.script = [png_of(Image.open(io.BytesIO(portrait())))]
    ok = await _generate(client, headers, org_id, source_avatar_id=avatar_id,
                         consent_id=consent_id)
    assert ok.status_code == 202, ok.text
    assert images.calls[0]["source"] is not None and images.calls[0]["mime"] == "image/jpeg"

    await client.patch(f"/orgs/{org_id}", json={"third_party_ai_enabled": False}, headers=headers)
    off = await _generate(client, headers, org_id)
    assert off.status_code == 403 and off.json()["code"] == "third_party_ai_disabled"
    assert len(images.calls) == 1


async def test_a_refused_generation_fails_for_good(client, faces, images):
    images.script = ["refuse"]
    headers, org_id = await _org(client, "refusedgen")
    response = await _generate(client, headers, org_id)
    base = f"/orgs/{org_id}/creations/{response.json()['id']}"
    body = await _get(client, headers, base)
    assert body["job"]["state"] == "failed"
    assert body["job"]["error"]["code"] == "safety_refused"
    assert body["job"]["retryable"] is False
    assert (await _run(client, headers, "POST", f"{base}/retry")).status_code == 409
    assert len(images.calls) == 1


async def test_a_failed_generation_can_be_retried(client, faces, images):
    images.script = ["error"]
    headers, org_id = await _org(client, "retrygen")
    response = await _generate(client, headers, org_id, face_type="animal")
    base = f"/orgs/{org_id}/creations/{response.json()['id']}"
    body = await _get(client, headers, base)
    assert body["job"]["retryable"] is True
    images.script = ["error", png_of(Image.new("RGB", (300, 300), (150, 110, 70)))]
    retried = await _run(client, headers, "POST", f"{base}/retry")
    assert retried.status_code == 202, retried.text
    body = await _get(client, headers, base)
    assert body["job"]["state"] == "done" and body["face_type"] == "animal"
    assert "animal" in images.calls[-1]["prompt"]


# --- disclosure and retired routes ---------------------------------------------------------


async def test_a_snapshot_published_before_disclosure_is_served_without_one(client):
    from tests.conftest import create_ready_avatar

    headers, org_id = await _org(client, "legacy")
    avatar_id = await create_ready_avatar(client, headers, org_id)
    key = (
        await client.post(
            f"/orgs/{org_id}/api-keys", json={"name": "site", "allowed_domains": []},
            headers=headers,
        )
    ).json()["plaintext"]

    fresh = await client.get(f"/embed/v1/avatars/{avatar_id}", headers={"X-Api-Key": key})
    assert fresh.json()["disclosure"] == {"ai_edited": None, "line": "human"}

    async with get_session_factory()() as db:
        avatar = await db.get(Avatar, avatar_id)
        config = json.loads(avatar.published_config)
        config.pop("disclosure")
        await db.execute(
            update(Avatar).where(Avatar.id == avatar_id).values(published_config=json.dumps(config))
        )
        await db.commit()
    old = await client.get(f"/embed/v1/avatars/{avatar_id}", headers={"X-Api-Key": key})
    assert old.status_code == 200
    assert "disclosure" not in old.json()


async def test_the_old_generation_and_staging_routes_are_gone(client):
    headers, org_id = await _org(client, "retired")
    for method, path in (
        ("POST", f"/orgs/{org_id}/avatars/generate"),
        ("POST", f"/orgs/{org_id}/avatars/from-candidate"),
        ("POST", f"/orgs/{org_id}/staging"),
        ("POST", f"/orgs/{org_id}/staging/generate"),
    ):
        response = await client.request(method, path, json={}, headers=headers)
        assert response.status_code in (404, 405), (path, response.status_code)



# --- the statement follows the pixels, not the line ---------------------------------------


async def _finish_without_statement(client, headers, base):
    anchors = await _detect(client, headers, base)
    return await client.post(
        f"{base}/finish", json={"name": "A", "anchors_id": anchors["id"]}, headers=headers
    )


async def test_a_stylised_person_still_needs_the_depiction_statement(client, faces, images):
    """A stylised version moves the creation to the animation line, but the
    drawing is still of that person: finishing asks for the statement."""
    headers, org_id = await _org(client, "styler")
    base, _ = await _create(client, headers, org_id)
    images.script = [png_of(Image.new("RGB", (480, 600), (40, 160, 220)))]
    await _adjust(client, headers, base, await ai_consent(client, headers, org_id),
                  mode="stylise", style="anime", count=1)
    chosen = await client.post(f"{base}/choose", json={"choice": "adjusted:0"}, headers=headers)
    assert chosen.json()["face_type"] == "cartoon"
    assert chosen.json()["statement"] == "depiction"
    refused = await _finish_without_statement(client, headers, base)
    assert refused.status_code == 403
    assert refused.json()["code"] == "consent_required"
    assert refused.json()["scope"] == "depiction"


async def test_switching_a_persons_photo_to_another_line_keeps_the_statement(client, faces):
    headers, org_id = await _org(client, "switcher")
    base, _ = await _create(client, headers, org_id)
    for line in ("cartoon", "animal"):
        switched = await client.patch(base, json={"face_type": line}, headers=headers)
        assert switched.json()["statement"] == "depiction", line
    refused = await _finish_without_statement(client, headers, base)
    assert refused.status_code == 403 and refused.json()["scope"] == "depiction"


async def test_an_animal_the_detector_does_not_see_needs_no_statement(client, faces):
    headers, org_id = await _org(client, "kennel")
    faces.none_for.add((WIDTH, HEIGHT))
    base, body = await _create(client, headers, org_id, face_type="animal")
    assert body["statement"] is None


async def test_a_statement_made_for_another_creation_does_not_count(client, faces):
    headers, org_id = await _org(client, "reuser")
    first, _ = await _create(client, headers, org_id)
    second, _ = await _create(client, headers, org_id)
    old = await depiction(client, headers, first)
    anchors = await _detect(client, headers, second)
    reused = await client.post(
        f"{second}/finish",
        json={"name": "A", "anchors_id": anchors["id"], "consent_id": old},
        headers=headers,
    )
    assert reused.status_code == 403 and reused.json()["scope"] == "depiction"


async def test_a_face_made_from_words_takes_its_own_statement(client, faces, images):
    """"I am this person" cannot be true of a generated face; the statement
    for it is that it is no real person, and the other one does not do."""
    images.script = [png_of(Image.open(io.BytesIO(portrait())))]
    headers, org_id = await _org(client, "wordsmith")
    response = await _generate(client, headers, org_id)
    base = f"/orgs/{org_id}/creations/{response.json()['id']}"
    assert (await _get(client, headers, base))["statement"] == "generated_face"
    anchors = await _detect(client, headers, base)
    wrong = await client.post(
        f"{base}/finish",
        json={"name": "A", "anchors_id": anchors["id"],
              "consent_id": await depiction(client, headers, base)},
        headers=headers,
    )
    assert wrong.status_code == 403 and wrong.json()["scope"] == "generated_face"
    right = await _run(
        client, headers, "POST", f"{base}/finish",
        json={"name": "A", "anchors_id": anchors["id"],
              "consent_id": await depiction(client, headers, base, "generated_face")},
    )
    assert right.status_code == 202, right.text
    assert (await _get(client, headers, base))["status"] == "finished"


# --- going back from a stylised version ---------------------------------------------------


async def test_keeping_the_photo_after_a_stylise_puts_the_person_back(
    client, faces, images, segmenter  # noqa: F811
):
    """Upload, remove the background, stylise, take it, then "Keep my photo":
    the photo is a person's again (the human line, the background removed,
    cut out again), and the round's before is still there to choose."""
    headers, org_id = await _org(client, "regretter")
    base, _ = await _create(client, headers, org_id)
    await _cut_out(client, headers, base)
    images.script = [png_of(Image.new("RGB", (480, 600), (40, 160, 220)))]
    await _adjust(client, headers, base, await ai_consent(client, headers, org_id),
                  mode="stylise", style="anime", count=2)
    taken = await client.post(f"{base}/choose", json={"choice": "adjusted:0"}, headers=headers)
    assert taken.json()["face_type"] == "cartoon"
    # The cut-out the round was made from is gone with the photo line; the
    # before is now the photo it was cut from, and still offered.
    last = taken.json()["ai"]["last_round"]
    assert last["source"] == "original"
    assert [c["step"] for c in last["candidates"]] == ["adjusted:0", "adjusted:1"]

    kept = await _run(client, headers, "POST", f"{base}/choose", json={"choice": "original"})
    assert kept.status_code == 202, kept.text  # the cut-out is made again
    body = await _get(client, headers, base)
    assert body["face_type"] == "human"
    assert body["background"] == "remove"
    assert body["current"] == "cutout" and body["job"]["state"] == "done"
    assert body["statement"] == "depiction"
    # And the stylised versions stay choosable, which moves it back again.
    again = await client.post(f"{base}/choose", json={"choice": "adjusted:1"}, headers=headers)
    assert again.json()["face_type"] == "cartoon"


async def test_keeping_the_photo_restores_a_kept_background_at_once(client, faces, images):
    headers, org_id = await _org(client, "keeper")
    base, _ = await _create(client, headers, org_id)
    await client.post(f"{base}/background", json={"mode": "keep"}, headers=headers)
    images.script = [png_of(Image.new("RGB", (480, 600), (40, 160, 220)))]
    await _adjust(client, headers, base, await ai_consent(client, headers, org_id),
                  mode="stylise", style="anime", count=1)
    await client.post(f"{base}/choose", json={"choice": "adjusted:0"}, headers=headers)
    kept = await client.post(f"{base}/choose", json={"choice": "original"}, headers=headers)
    assert kept.status_code == 200
    assert kept.json()["face_type"] == "human" and kept.json()["background"] == "keep"
    assert kept.json()["current"] == "original"


async def test_choosing_a_line_forgets_the_line_before_the_stylise(client, faces, images):
    headers, org_id = await _org(client, "decider")
    base, _ = await _create(client, headers, org_id)
    images.script = [png_of(Image.new("RGB", (480, 600), (40, 160, 220)))]
    await _adjust(client, headers, base, await ai_consent(client, headers, org_id),
                  mode="stylise", style="anime", count=1)
    await client.post(f"{base}/choose", json={"choice": "adjusted:0"}, headers=headers)
    await client.patch(base, json={"face_type": "animal"}, headers=headers)
    await client.patch(base, json={"face_type": "cartoon"}, headers=headers)
    kept = await client.post(f"{base}/choose", json={"choice": "original"}, headers=headers)
    assert kept.json()["face_type"] == "cartoon", "the owner's own choice of line stands"


# --- what is sent, and what is metered ---------------------------------------------------------


async def test_a_cutout_avatar_is_sent_on_grey_as_a_generation_source(
    client, faces, images, segmenter  # noqa: F811
):
    """The source avatar is a cut-out: the removed room must not reach
    Google, as the consent just given says (a removed background is sent as
    plain grey)."""
    headers, org_id = await _org(client, "resourcer")
    base, _ = await _create(client, headers, org_id)
    await _cut_out(client, headers, base)
    finished = await _finish_and_wait(client, headers, base)
    async with get_session_factory()() as db:
        avatar = await db.get(Avatar, finished["avatar_id"])
    assert avatar.original_image_key, "the opaque photo is kept for putting the background back"

    images.script = [png_of(Image.open(io.BytesIO(portrait())))]
    made = await _generate(client, headers, org_id, source_avatar_id=avatar.id,
                           consent_id=await ai_consent(client, headers, org_id))
    assert made.status_code == 202, made.text
    sent = Image.open(io.BytesIO(images.calls[0]["source"]))
    assert sent.format == "JPEG" and sent.mode == "RGB"
    # The segmenter fake calls the left half background.
    left = np.asarray(sent, dtype=np.float64)[:, : sent.width // 3]
    assert abs(left.mean() - 128) < 2 and left.std() < 3


class _Imageless:
    """A 200 answer with no image in it, the way FakeImages scripts one."""

    def __init__(self, images):
        self.images = images
        self.real = images._answer

    def __call__(self, source):
        if self.images._next() == "no_image":
            raise imagegen.ImageGenNoImage("NO_IMAGE")
        return self.real(source)


async def test_an_answer_without_an_image_is_metered_and_spends_the_round(
    client, faces, images, monkeypatch
):
    monkeypatch.setattr(images, "_answer", _Imageless(images))
    images.script = ["no_image"]
    headers, org_id = await _org(client, "declined")
    base, _ = await _create(client, headers, org_id)
    await _adjust(client, headers, base, await ai_consent(client, headers, org_id), count=2)
    body = await _get(client, headers, base)
    assert len(images.calls) == 1, "not asked again in the same round"
    assert body["job"]["state"] == "done"
    (candidate,) = body["ai"]["last_round"]["candidates"]
    assert candidate["ok"] is False and candidate["reason"]["code"] == "no_image"
    # Answered, so billed: counted, and the round stays spent.
    assert await _usage(org_id, IMAGE_KIND) == ["adjust_touchup"]
    assert body["ai"]["adjust_rounds_left"] == 1
    assert (await _run(client, headers, "POST", f"{base}/retry")).status_code == 409


async def test_a_generation_answered_without_an_image_is_metered(
    client, faces, images, monkeypatch
):
    monkeypatch.setattr(images, "_answer", _Imageless(images))
    images.script = ["no_image"]
    headers, org_id = await _org(client, "emptygen")
    response = await _generate(client, headers, org_id)
    base = f"/orgs/{org_id}/creations/{response.json()['id']}"
    body = await _get(client, headers, base)
    assert body["job"]["state"] == "failed"
    assert body["job"]["error"]["code"] == "no_image"
    assert await _usage(org_id, IMAGE_KIND) == ["generate"]


# --- the switch and the consent hold for work already queued -------------------------------


async def _switch_off(org_id: str) -> None:
    from app.models import Organization

    async with get_session_factory()() as db:
        await db.execute(
            update(Organization).where(Organization.id == org_id)
            .values(third_party_ai_enabled=False)
        )
        await db.commit()


async def test_a_queued_adjust_sends_nothing_once_ai_is_switched_off(
    client, faces, images, gate  # noqa: F811
):
    headers, org_id = await _org(client, "queued")
    base, _ = await _create(client, headers, org_id)
    consent_id = await ai_consent(client, headers, org_id)
    gate.close()
    response = await client.post(
        f"{base}/adjust", json={"mode": "touchup", "consent_id": consent_id}, headers=headers
    )
    assert response.status_code == 202
    await _switch_off(org_id)
    gate.open()
    await runner.drain()
    body = await _get(client, headers, base)
    assert images.calls == []
    assert body["job"]["state"] == "failed"
    assert body["job"]["error"]["code"] == "third_party_ai_disabled"
    assert body["job"]["retryable"] is False
    assert body["ai"]["adjust_rounds_left"] == 2, "nothing was sent: the round is given back"


async def test_switching_ai_off_mid_round_stops_the_second_call(
    client, faces, images, monkeypatch
):
    headers, org_id = await _org(client, "midround")
    base, _ = await _create(client, headers, org_id)
    real = images.edit

    async def then_off(prompt, source, mime):
        answer = await real(prompt, source, mime)
        await _switch_off(org_id)
        return answer

    monkeypatch.setattr(imagegen, "edit_image", then_off)
    await _adjust(client, headers, base, await ai_consent(client, headers, org_id), count=2)
    body = await _get(client, headers, base)
    assert len(images.calls) == 1
    assert body["job"]["state"] == "done", "the answer already paid for is kept"
    assert [c["step"] for c in body["ai"]["last_round"]["candidates"]] == ["adjusted:0"]


async def test_ai_points_are_not_asked_for_once_ai_is_switched_off(
    client, vision, gate  # noqa: F811
):
    headers, org_id = await _org(client, "pointsoff")
    base, _ = await _create(client, headers, org_id, face_type="animal")
    consent_id = await ai_consent(client, headers, org_id)
    gate.close()
    response = await client.post(
        f"{base}/detect", json={"use_ai": True, "consent_id": consent_id}, headers=headers
    )
    assert response.status_code == 202, response.text
    await _switch_off(org_id)
    gate.open()
    await runner.drain()
    body = await _get(client, headers, base)
    assert vision.calls == []
    assert body["anchors"]["source"] == "template"
    codes = [w["code"] for w in body["anchors"]["validation"]["warnings"]]
    assert "third_party_ai_disabled" in codes
    assert body["ai"]["ai_detections_left"] == 1, "nothing was sent: the detection is given back"


async def test_a_retried_generation_from_a_photo_needs_the_retrying_members_consent(
    client, faces, images
):
    from tests.conftest import create_ready_avatar
    from tests.test_consent import _member

    owner, org_id = await _org(client, "genowner")
    avatar_id = await create_ready_avatar(client, owner, org_id)
    images.script = ["error"]
    response = await _generate(client, owner, org_id, source_avatar_id=avatar_id,
                               consent_id=await ai_consent(client, owner, org_id))
    base = f"/orgs/{org_id}/creations/{response.json()['id']}"
    body = await _get(client, owner, base)
    assert body["job"]["retryable"] is True and len(images.calls) == 1

    colleague = await _member(client, owner, org_id, "genhelper")
    refused = await _run(client, colleague, "POST", f"{base}/retry")
    assert refused.status_code == 403
    assert refused.json()["code"] == "consent_required"
    assert refused.json()["scope"] == "third_party_ai"
    assert len(images.calls) == 1, "nothing sent on someone else's consent"

    images.script = [png_of(Image.open(io.BytesIO(portrait())))]
    own = await ai_consent(client, colleague, org_id)
    retried = await _run(client, colleague, "POST", f"{base}/retry", json={"consent_id": own})
    assert retried.status_code == 202, retried.text
    assert len(images.calls) == 2
    assert own in (await _row(base)).consent_ids


async def test_a_declined_whole_photo_edit_is_asked_once_more_on_the_head_crop(
    client, faces, images
):
    """Gemini blocked every prompt on one full-frame portrait and accepted the
    same face cropped to head and shoulders (measured 2026-09-25). A declined
    regenerate is therefore sent once more as that crop, and the answer is an
    ordinary candidate."""
    images.script = ["refuse", "echo"]
    # A face a quarter of the frame wide, so its head crop is a real crop.
    faces.by_size[(WIDTH, HEIGHT)] = face_template.place((150, 150, 250, 270))
    headers, org_id = await _org(client, "crop-retry")
    base, _ = await _create(client, headers, org_id)
    await _adjust(client, headers, base, await ai_consent(client, headers, org_id),
                  mode="regenerate", count=1)
    body = await _get(client, headers, base)
    assert len(images.calls) == 2
    full, crop = (Image.open(io.BytesIO(c["source"])) for c in images.calls)
    assert crop.width * crop.height < full.width * full.height, "the second ask is the crop"
    assert _step(body, "adjusted:0")["id"] == "adjusted:0"
    assert body["ai"]["last_round"]["candidates"][0]["reason"] is None
    assert await _usage(org_id, IMAGE_KIND) == ["adjust_regen", "adjust_regen"], "both asks metered"


async def test_a_head_crop_that_is_declined_too_is_not_asked_a_third_time(
    client, faces, images
):
    images.script = ["refuse"]
    faces.by_size[(WIDTH, HEIGHT)] = face_template.place((150, 150, 250, 270))
    headers, org_id = await _org(client, "crop-refused")
    base, _ = await _create(client, headers, org_id)
    await _adjust(client, headers, base, await ai_consent(client, headers, org_id),
                  mode="regenerate", count=2)
    body = await _get(client, headers, base)
    assert len(images.calls) == 2, "the photo, then its head crop; never a third time"
    (candidate,) = body["ai"]["last_round"]["candidates"]
    assert candidate["reason"]["code"] == "safety_refused"


async def test_a_photo_that_is_already_head_and_shoulders_is_not_asked_again(
    client, faces, images
):
    """When the face fills the frame the head crop is the same picture, so a
    refusal stands: asking again would be the same request."""
    images.script = ["refuse"]
    # A face so large its head crop reaches every edge of the photo.
    faces.by_size[(WIDTH, HEIGHT)] = face_template.place((20, 20, 380, 480))
    headers, org_id = await _org(client, "crop-same")
    base, _ = await _create(client, headers, org_id)
    await _adjust(client, headers, base, await ai_consent(client, headers, org_id),
                  mode="regenerate", count=1)
    assert len(images.calls) == 1
