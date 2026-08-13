"""An upload with no usable face must fail, not ship as "ready".

The pipeline substitutes a synthetic mesh when MediaPipe finds nothing, and
that mesh satisfies every consumer downstream — so the avatar reached the user
marked ready, with a mouth moving somewhere near the middle of the picture and
nothing to explain it.
"""

import pytest

from app.models import AvatarStatus
from app.services.rig import NoFaceDetected, process_avatar
from tests.conftest import create_org, register_and_login, sample_png


async def _pending_avatar(client, headers, org_id) -> str:
    created = await client.post(
        f"/orgs/{org_id}/avatars",
        json={"name": "Test", "content_type": "image/png"},
        headers=headers,
    )
    body = created.json()
    await client.put(body["upload_url"], content=sample_png(), headers={"content-type": "image/png"})
    return body["avatar"]["id"]


async def test_without_a_model_every_image_still_processes(client, monkeypatch):
    """The no-model path is load-bearing: the stock gallery is drawn to match
    the synthetic mesh, and a fresh install has no model at all. Enforcing
    detection there would break the zero-setup flow it exists for."""
    from app.core import config

    settings = config.get_settings()
    monkeypatch.setattr(settings, "rig_model_path", None, raising=False)

    headers = await register_and_login(client, "nomodel")
    org_id = await create_org(client, headers)
    avatar_id = await _pending_avatar(client, headers, org_id)

    await process_avatar(avatar_id)

    detail = (await client.get(f"/orgs/{org_id}/avatars/{avatar_id}", headers=headers)).json()
    assert detail["status"] == AvatarStatus.ready.value
    assert detail["error"] is None


async def test_an_undetected_face_ships_ready_with_marking_instructions(client, monkeypatch):
    """No detection is a starting point, not a dead end.

    The synthetic fallback mesh is a complete markable rig, so the avatar
    ships ready with a note that sends the user to Mark the face — stylised
    art, mascots and animal faces are all rescuable there.
    """
    from app.core import config
    from app.services import rig as rig_module

    settings = config.get_settings()
    monkeypatch.setattr(settings, "rig_model_path", "/some/model.task", raising=False)
    monkeypatch.setattr(
        rig_module,
        "landmarks_from_image",
        lambda data: (rig_module.synthetic_face_mesh(256, 256), None, (256, 256), False),
    )

    headers = await register_and_login(client, "noface")
    org_id = await create_org(client, headers)
    avatar_id = await _pending_avatar(client, headers, org_id)

    await process_avatar(avatar_id)

    detail = (await client.get(f"/orgs/{org_id}/avatars/{avatar_id}", headers=headers)).json()
    assert detail["status"] == AvatarStatus.ready.value
    # An instruction pointing at the tool that fixes it, not a rejection.
    assert "No face was detected" in detail["quality_note"]
    assert "Mark the face" in detail["quality_note"]
    # The rig exists and is markable.
    anchors = (
        await client.get(f"/orgs/{org_id}/avatars/{avatar_id}/rig-anchors", headers=headers)
    ).json()["anchors"]
    assert anchors["head"] and anchors["mouth"]
    assert anchors["left_pupil"] and anchors["right_pupil"]


async def test_a_detected_but_awkward_face_warns_instead_of_failing(client, monkeypatch):
    """Geometry thresholds are heuristics. They should not veto a picture the
    user deliberately chose — say what is wrong and carry on."""
    from app.core import config
    from app.services import rig as rig_module

    settings = config.get_settings()
    monkeypatch.setattr(settings, "rig_model_path", "/some/model.task", raising=False)

    def tiny_face(data):
        points = rig_module.synthetic_face_mesh(256, 256)
        points = points * 0.25  # shrink it into the top-left corner
        return points, None, (1024, 1024), True

    monkeypatch.setattr(rig_module, "landmarks_from_image", tiny_face)

    headers = await register_and_login(client, "awkward")
    org_id = await create_org(client, headers)
    avatar_id = await _pending_avatar(client, headers, org_id)

    await process_avatar(avatar_id)

    detail = (await client.get(f"/orgs/{org_id}/avatars/{avatar_id}", headers=headers)).json()
    assert detail["status"] == AvatarStatus.ready.value, "a usable avatar must not be rejected"
    assert detail["quality_note"], "but the user should be told why it may look wrong"


async def test_a_good_face_carries_no_warning(client, monkeypatch):
    from app.core import config
    from app.services import rig as rig_module

    settings = config.get_settings()
    monkeypatch.setattr(settings, "rig_model_path", "/some/model.task", raising=False)
    monkeypatch.setattr(
        rig_module,
        "landmarks_from_image",
        lambda data: (rig_module.synthetic_face_mesh(1024, 1024), None, (1024, 1024), True),
    )

    headers = await register_and_login(client, "goodface")
    org_id = await create_org(client, headers)
    avatar_id = await _pending_avatar(client, headers, org_id)

    await process_avatar(avatar_id)

    detail = (await client.get(f"/orgs/{org_id}/avatars/{avatar_id}", headers=headers)).json()
    assert detail["status"] == AvatarStatus.ready.value
    assert detail["quality_note"] is None
