"""The wizard and the mouth: a touch-up started for a person whose teeth
show, and a warning when the picture finished still has them.

A photo with parted lips puts its own teeth on the lips of the avatar: the
photographic mouth opens and closes those lips, and the teeth painted on
them go wherever they go. The check sees it (teeth_showing), a touch-up
closes the lips, and the wizard may start that touch-up by itself
(`ai.auto_adjust`, then `auto: true`), once per photo; the owner still
chooses. Finishing a picture that still shows them warns, never refuses.
"""

from __future__ import annotations

import pytest

from tests.test_creation_ai import (
    CHANGES,
    GOOD,
    Faces,
    FakeImages,
    _adjust,
    _good_portrait,
    _org,
    ai_consent,
)
from tests.test_creations import _create, _detect, _get, _run, depiction
from tests.test_photo_analysis import with_mouth


@pytest.fixture
def faces(monkeypatch):
    return Faces(monkeypatch)


@pytest.fixture
def images(monkeypatch):
    return FakeImages(monkeypatch)


@pytest.fixture
def teeth(monkeypatch, faces):
    """Every photo-sized detection has the lips parted over the teeth
    (between the check's teeth and open-mouth gaps)."""
    monkeypatch.setitem(CHANGES, "teeth", lambda p: with_mouth(p, 0.07))
    faces.changes[GOOD] = "teeth"
    return faces


async def _person(client, who):
    headers, org_id = await _org(client, who)
    base, body = await _create(client, headers, org_id, data=_good_portrait())
    return headers, org_id, base, body


async def test_teeth_showing_offers_a_touchup_the_wizard_may_start(client, teeth, images):
    headers, org_id, base, body = await _person(client, "gappy")
    assert body["analysis"]["recommendation"]["reasons"] == ["teeth_showing"]
    assert body["ai"]["auto_adjust"] == {
        "mode": "touchup", "image": "original", "reasons": ["teeth_showing"],
    }

    consent_id = await ai_consent(client, headers, org_id)
    started = await _adjust(client, headers, base, consent_id, auto=True, count=1)
    assert started.status_code == 202, started.text
    body = await _get(client, headers, base)
    assert body["job"]["state"] == "done", body["job"]
    assert len(images.calls) == 1
    # Offered, never chosen, and not offered again for this photo.
    assert body["current"] == "original"
    assert body["ai"]["auto_adjust"] is None
    again = await _adjust(client, headers, base, consent_id, auto=True, count=1)
    assert again.status_code == 409 and again.json()["code"] == "auto_adjust_not_applicable"
    assert len(images.calls) == 1


async def test_the_offer_is_spent_even_when_the_provider_does_not_answer(
    client, teeth, images
):
    headers, org_id, base, _ = await _person(client, "unanswered")
    images.script = ["error"]
    await _adjust(client, headers, base, await ai_consent(client, headers, org_id),
                  auto=True, count=1)
    body = await _get(client, headers, base)
    assert body["job"]["state"] == "failed"
    assert body["ai"]["adjust_rounds_left"] == 2, "the round is given back"
    assert body["ai"]["auto_adjust"] is None, "but the wizard does not loop on it"


async def test_a_manual_round_on_the_photo_ends_the_offer(client, teeth, images):
    headers, org_id, base, _ = await _person(client, "manual")
    await _adjust(client, headers, base, await ai_consent(client, headers, org_id), count=1)
    body = await _get(client, headers, base)
    assert body["ai"]["auto_adjust"] is None


async def test_the_offer_needs_consent_like_any_adjust(client, teeth, images):
    headers, org_id, base, _ = await _person(client, "unconsented")
    refused = await _adjust(client, headers, base, "not-mine", auto=True)
    assert refused.status_code == 403 and refused.json()["code"] == "consent_required"
    assert images.calls == []
    assert (await _get(client, headers, base))["ai"]["auto_adjust"] is not None


@pytest.mark.parametrize("change", [None, "closed", "open"])
async def test_nothing_else_is_started_automatically(client, faces, images, change):
    """Closed eyes are a touch-up too, but the owner's to decide (the fix
    invents eyes); an open mouth is a regenerate; a good photo needs nothing."""
    headers, org_id = await _org(client, f"nothing{change}")
    if change:
        faces.changes[GOOD] = change
    base, body = await _create(client, headers, org_id, data=_good_portrait())
    assert body["ai"]["auto_adjust"] is None
    response = await _adjust(client, headers, base, await ai_consent(client, headers, org_id),
                             auto=True)
    assert response.status_code == 409 and response.json()["code"] == "auto_adjust_not_applicable"
    assert images.calls == []


async def test_no_offer_when_ai_is_off_or_unavailable(client, teeth, monkeypatch):
    from app.services import imagegen

    headers, org_id, base, body = await _person(client, "offline")
    monkeypatch.setattr(imagegen, "configured", lambda: False)
    assert (await _get(client, headers, base))["ai"]["auto_adjust"] is None
    monkeypatch.setattr(imagegen, "configured", lambda: True)
    assert (await _get(client, headers, base))["ai"]["auto_adjust"] is not None
    await client.patch(f"/orgs/{org_id}", json={"third_party_ai_enabled": False}, headers=headers)
    assert (await _get(client, headers, base))["ai"]["auto_adjust"] is None


async def test_no_offer_for_an_animal(client, teeth, images):
    headers, org_id = await _org(client, "dogowner")
    _, body = await _create(client, headers, org_id, data=_good_portrait(), face_type="animal")
    assert body["ai"]["auto_adjust"] is None


# --- finish -----------------------------------------------------------------------------


async def _finish(client, headers, base):
    anchors = await _detect(client, headers, base)
    return await _run(client, headers, "POST", f"{base}/finish", json={
        "name": "Ada", "anchors_id": anchors["id"],
        "consent_id": await depiction(client, headers, base),
    })


async def test_finishing_a_picture_with_teeth_showing_warns(client, teeth):
    headers, _, base, _ = await _person(client, "warned")
    response = await _finish(client, headers, base)
    assert response.status_code == 202, response.text
    assert [w["code"] for w in response.json()["warnings"]] == ["teeth_showing"]
    assert (await _get(client, headers, base))["status"] == "finished", "not a refusal"
    # The same answer to a repeated press.
    again = await client.post(f"{base}/finish", json={"name": "Ada", "anchors_id": "x"},
                              headers=headers)
    assert [w["code"] for w in again.json()["warnings"]] == ["teeth_showing"]


async def test_finishing_an_open_mouth_warns(client, faces):
    faces.changes[GOOD] = "open"
    headers, _, base, _ = await _person(client, "openwide")
    response = await _finish(client, headers, base)
    assert [w["code"] for w in response.json()["warnings"]] == ["mouth_open"]


async def test_a_closed_mouth_finishes_without_warnings(client, faces):
    headers, _, base, _ = await _person(client, "closed")
    response = await _finish(client, headers, base)
    assert response.status_code == 202
    assert response.json()["warnings"] == []


# --- once per photo, and only for the lips -----------------------------------------------


async def test_parted_lips_with_eyes_to_fix_too_are_touched_up_by_themselves(
    client, faces, images, monkeypatch
):
    """The check found the teeth showing between parted lips, which the
    photographic mouth cannot live with, and the eyes looking away. The
    touch-up it recommends does both, and starts by itself on the member's
    remembered consent like any required fix; the reasons say what it
    fixes, and the owner still chooses the result."""
    from tests.test_photo_analysis import looking

    monkeypatch.setitem(CHANGES, "lips_and_gaze", lambda p: with_mouth(looking(p, 0.6), 0.07))
    faces.changes[GOOD] = "lips_and_gaze"
    headers, org_id, base, body = await _person(client, "eyesandlips")
    recommendation = body["analysis"]["recommendation"]
    assert recommendation["mode"] == "touchup"
    assert recommendation["reasons"] == ["gaze_off_camera", "teeth_showing"]
    assert body["ai"]["auto_adjust"] == {
        "mode": "touchup", "image": "original", "reasons": ["gaze_off_camera", "teeth_showing"],
    }
    started = await _adjust(client, headers, base, await ai_consent(client, headers, org_id),
                            auto=True, count=1)
    assert started.status_code == 202, started.text
    body = await _get(client, headers, base)
    assert body["job"]["state"] == "done" and len(images.calls) == 1
    assert body["current"] == "original", "offered, never chosen"
    assert body["ai"]["auto_adjust"] is None


async def test_the_offer_is_once_per_photo_however_it_is_cropped(client, teeth, images):
    """Each crop of a photo is a new pixel frame; it is still the same
    photo, and the wizard does not start a second paid round on it. (The
    first failed without an answer: its round was given back, and only the
    spent offer remembers it.)"""
    headers, org_id, base, _ = await _person(client, "recropped")
    images.script = ["error"]
    await _adjust(client, headers, base, await ai_consent(client, headers, org_id),
                  auto=True, count=1)
    body = await _get(client, headers, base)
    assert body["ai"]["auto_adjust"] is None and body["ai"]["adjust_rounds_left"] == 2
    # The framed picture still shows the teeth.
    framed = (round(GOOD[0] * 0.9), round(GOOD[1] * 0.9))
    teeth.changes[framed] = "teeth"
    reframed = await client.patch(
        base, json={"crop": {"x": 0.05, "y": 0.05, "w": 0.9, "h": 0.9}}, headers=headers)
    assert reframed.status_code == 200, reframed.text
    body = reframed.json()
    assert body["current"] == "framed"
    assert body["analysis"]["recommendation"]["reasons"] == ["teeth_showing"]
    assert body["ai"]["auto_adjust"] is None, "not offered again for the same photo"
    assert body["ai"]["suggested"] == ["touchup"], "still recommended, for the owner to start"


def test_an_offer_spent_before_sources_were_recorded_stays_spent():
    """Offers spent by an older server were recorded by pixel frame."""
    from types import SimpleNamespace

    from app.services import creations as svc

    check = {"detector": "mediapipe", "detected": True, "checks": [{"code": "teeth_showing"}],
             "face_state": {}, "recommendations": {
                 "human": {"mode": "touchup", "reasons": ["teeth_showing"]}}}
    steps = {"current": "framed", "items": {
        "original": {"key": "orgs/o/creations/c/original-1.png", "from": None, "check": check},
        "framed": {"key": "orgs/o/creations/c/framed-2.png", "from": "original", "check": check},
    }}

    def creation(auto_adjusted):
        return SimpleNamespace(face_type="human", steps=steps,
                               ai_usage={"adjust_rounds": 0, "auto_adjusted": auto_adjusted})

    assert svc.auto_adjust_of(creation([])) is not None
    assert svc.auto_adjust_of(creation(["orgs/o/creations/c/framed-2.png"])) is None
    assert svc.auto_adjust_of(creation(["orgs/o/creations/c/original-1.png"])) is None
    assert svc.source_photo_key(steps, "framed") == "orgs/o/creations/c/original-1.png"
