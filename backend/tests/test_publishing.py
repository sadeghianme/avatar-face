"""Draft vs published: nothing an owner does reaches a visitor until Publish."""

import json

import pytest

from app.models import AvatarStatus
from tests.conftest import create_org, create_ready_avatar, register_and_login, sample_png


@pytest.fixture
async def setup(client):
    headers = await register_and_login(client, "publisher")
    org_id = await create_org(client, headers)
    avatar_id = await create_ready_avatar(client, headers, org_id)
    key = await client.post(
        f"/orgs/{org_id}/api-keys", json={"name": "w", "allowed_domains": []}, headers=headers
    )
    return headers, org_id, avatar_id, {"X-Api-Key": key.json()["plaintext"]}


async def _first_build(client, monkeypatch, name, *, face_type="human", detected=True, shrink=1.0):
    """A fresh avatar built with a stubbed detector, never published by hand."""
    from app.core import config
    from app.services import rig as rig_module

    monkeypatch.setattr(config.get_settings(), "rig_model_path", "/some/model.task", raising=False)
    monkeypatch.setattr(
        rig_module,
        "landmarks_from_image",
        lambda data: (
            rig_module.synthetic_face_mesh(1024, 1024) * shrink,
            None,
            (1024, 1024),
            detected,
        ),
    )
    headers = await register_and_login(client, name)
    org_id = await create_org(client, headers)
    created = await client.post(
        f"/orgs/{org_id}/avatars",
        json={"name": "First", "content_type": "image/png", "face_type": face_type},
        headers=headers,
    )
    body = created.json()
    await client.put(
        body["upload_url"], content=sample_png(), headers={"content-type": "image/png"}
    )
    avatar_id = body["avatar"]["id"]
    await client.post(f"/orgs/{org_id}/avatars/{avatar_id}/uploaded", headers=headers)
    key = await client.post(
        f"/orgs/{org_id}/api-keys", json={"name": "w", "allowed_domains": []}, headers=headers
    )
    return headers, org_id, avatar_id, {"X-Api-Key": key.json()["plaintext"]}


async def test_a_confidently_detected_human_publishes_itself(client, monkeypatch):
    """Creating an avatar and pasting the snippet has to work immediately
    when nothing about the face is in doubt."""
    headers, org_id, avatar_id, key = await _first_build(client, monkeypatch, "confident")
    detail = (await client.get(f"/orgs/{org_id}/avatars/{avatar_id}", headers=headers)).json()
    assert detail["unpublished"] is False
    assert detail["published"] is True
    assert detail["published_at"] is not None
    assert detail["quality_note"] is None
    assert (await client.get(f"/embed/v1/avatars/{avatar_id}", headers=key)).status_code == 200


@pytest.mark.parametrize(
    "face_type, detected, shrink",
    [
        ("human", False, 1.0),  # no face found: the mesh is a placeholder
        ("human", True, 0.25),  # found, but too small to pass the checks
        ("animal", True, 1.0),  # no detector knows a muzzle
        ("cartoon", True, 1.0),  # stylised eyes and mouths land wrong
    ],
)
async def test_an_unconfirmed_first_build_waits_for_its_owner(
    client, monkeypatch, face_type, detected, shrink
):
    """Nothing goes live on a guess: the avatar is ready to edit, says it is
    not live, and embed and share keep answering 404 until Publish."""
    headers, org_id, avatar_id, key = await _first_build(
        client,
        monkeypatch,
        f"held-{face_type}-{detected}-{shrink}",
        face_type=face_type,
        detected=detected,
        shrink=shrink,
    )
    base = f"/orgs/{org_id}/avatars/{avatar_id}"
    detail = (await client.get(base, headers=headers)).json()
    assert detail["status"] == "ready"
    assert detail["published"] is False
    assert detail["published_at"] is None
    # "Not live yet" is the Publish bar's to say, translated; the note keeps
    # only the reason, if there is one.
    assert "Publish" not in (detail["quality_note"] or "")

    embed = await client.get(f"/embed/v1/avatars/{avatar_id}", headers=key)
    assert embed.status_code == 404 and embed.json()["code"] == "avatar_not_published"
    token = (await client.post(f"{base}/share", headers=headers)).json()["share_token"]
    assert (await client.get(f"/public/v1/avatars/{token}")).status_code == 404
    speak = await client.post(f"/public/v1/avatars/{token}/speak", json={"text": "hi"})
    assert speak.status_code == 404, "an unpublished link must not spend the owner's quota"

    published = (await client.post(f"{base}/publish", headers=headers)).json()
    assert published["published"] is True
    assert published["published_at"] is not None
    # The reason stays; the instruction to publish goes.
    assert "Publish" not in (published["quality_note"] or "")
    assert (await client.get(f"/embed/v1/avatars/{avatar_id}", headers=key)).status_code == 200
    assert (await client.get(f"/public/v1/avatars/{token}")).status_code == 200


async def test_a_snapshot_backfilled_by_migration_020_is_live(client):
    """Migration 020 gave every avatar live at the time a snapshot with no
    publish date. Those avatars are on customers' sites; the dashboard must
    not call them "not live" because nobody has pressed Publish since."""
    from sqlalchemy import select

    from app.db import get_session_factory
    from app.models import Avatar

    headers = await register_and_login(client, "backfilled")
    org_id = await create_org(client, headers)
    avatar_id = await create_ready_avatar(client, headers, org_id, publish=False)
    async with get_session_factory()() as db:
        avatar = (await db.execute(select(Avatar).where(Avatar.id == avatar_id))).scalar_one()
        # As the migration wrote it: the draft's own keys, revision 0.
        avatar.published_config = json.dumps(
            {
                "revision": 0,
                "framing": avatar.framing,
                "face_type": avatar.face_type,
                "image_key": avatar.image_key,
                "rig_key": avatar.rig_key,
                "thumbnail_key": avatar.thumbnail_key,
                "layer_keys": None,
                "published_at": None,
            }
        )
        await db.commit()

    detail = (await client.get(f"/orgs/{org_id}/avatars/{avatar_id}", headers=headers)).json()
    assert detail["published"] is True and detail["published_at"] is None
    listed = (await client.get(f"/orgs/{org_id}/avatars", headers=headers)).json()
    assert [a["published"] for a in listed if a["id"] == avatar_id] == [True]


async def test_a_3d_model_publishes_itself(client):
    """A GLB carries its own rig: there are no points to confirm."""
    from tests.test_model3d import RPM_LIKE_GLTF, make_glb

    headers = await register_and_login(client, "glb")
    org_id = await create_org(client, headers)
    created = await client.post(
        f"/orgs/{org_id}/avatars",
        json={"name": "Model", "content_type": "model/gltf-binary"},
        headers=headers,
    )
    body = created.json()
    await client.put(
        body["upload_url"],
        content=make_glb(RPM_LIKE_GLTF),
        headers={"content-type": "model/gltf-binary"},
    )
    avatar_id = body["avatar"]["id"]
    await client.post(f"/orgs/{org_id}/avatars/{avatar_id}/uploaded", headers=headers)
    detail = (await client.get(f"/orgs/{org_id}/avatars/{avatar_id}", headers=headers)).json()
    assert detail["status"] == "ready"
    assert detail["published_at"] is not None


async def test_rebuilding_the_draft_keeps_the_published_avatar_live(client, setup, monkeypatch):
    """A re-detect puts the DRAFT through processing; customer sites must
    keep the published version the whole time, not 404."""
    headers, org_id, avatar_id, key = setup
    base = f"/orgs/{org_id}/avatars/{avatar_id}"
    token = (await client.post(f"{base}/share", headers=headers)).json()["share_token"]
    before = (await client.get(f"/embed/v1/avatars/{avatar_id}", headers=key)).json()

    async def stalled(_avatar_id):  # the job never gets to finish
        return None

    import app.api.avatars.core as avatars_api

    monkeypatch.setattr(avatars_api, "process_avatar", stalled)
    reset = await client.post(f"{base}/rig-reset", headers=headers)
    assert reset.json()["status"] == "processing"

    embed = await client.get(f"/embed/v1/avatars/{avatar_id}", headers=key)
    assert embed.status_code == 200, embed.text
    assert embed.json()["rig_url"].split("?")[0] == before["rig_url"].split("?")[0]
    assert (await client.get(f"/public/v1/avatars/{token}")).status_code == 200

    await _set_status(avatar_id, AvatarStatus.failed)
    assert (await client.get(f"/embed/v1/avatars/{avatar_id}", headers=key)).status_code == 200
    assert (await client.get(f"/public/v1/avatars/{token}")).status_code == 200


async def test_a_never_published_avatar_is_still_judged_by_its_status(client, monkeypatch):
    headers, org_id, avatar_id, key = await _first_build(
        client, monkeypatch, "neverpub", detected=False
    )
    await _set_status(avatar_id, AvatarStatus.processing)
    embed = await client.get(f"/embed/v1/avatars/{avatar_id}", headers=key)
    assert embed.status_code == 404 and embed.json()["code"] == "avatar_not_ready"


async def _set_status(avatar_id: str, status) -> None:
    from sqlalchemy import update

    from app.db import get_session_factory
    from app.models import Avatar

    async with get_session_factory()() as db:
        await db.execute(update(Avatar).where(Avatar.id == avatar_id).values(status=status))
        await db.commit()


async def test_jobs_cut_short_by_a_restart_become_retryable(client, setup):
    """Startup recovery: a job whose process died never finishes, so the
    avatar is failed with a message that says to retry — and retrying
    works. The published version stays live throughout."""
    from app.db import get_session_factory
    from app.services.avatars.build import INTERRUPTED_ERROR, fail_interrupted

    headers, org_id, avatar_id, key = setup
    base = f"/orgs/{org_id}/avatars/{avatar_id}"
    await _set_status(avatar_id, AvatarStatus.processing)

    async with get_session_factory()() as db:
        assert await fail_interrupted(db) == 1
    detail = (await client.get(base, headers=headers)).json()
    assert detail["status"] == "failed"
    assert detail["error"] == INTERRUPTED_ERROR
    assert (await client.get(f"/embed/v1/avatars/{avatar_id}", headers=key)).status_code == 200

    retried = await client.post(f"{base}/retry", headers=headers)
    assert retried.status_code == 200, retried.text
    assert (await client.get(base, headers=headers)).json()["status"] == "ready"


async def test_recovery_leaves_settled_avatars_alone(client, setup):
    from app.db import get_session_factory
    from app.services.avatars.build import fail_interrupted

    headers, org_id, avatar_id, key = setup
    async with get_session_factory()() as db:
        assert await fail_interrupted(db) == 0
    assert (await client.get(f"/orgs/{org_id}/avatars/{avatar_id}", headers=headers)).json()[
        "status"
    ] == "ready"


async def test_published_assets_are_copies_not_pointers(client, setup):
    """The load-bearing decision. Layer files are written to a fixed path and
    overwritten in place, so a snapshot that merely recorded live keys would
    silently change under published clients on the next rebuild."""
    headers, org_id, avatar_id, key = setup
    from sqlalchemy import select

    from app.db import get_session_factory
    from app.models import Avatar

    async with get_session_factory()() as db:
        avatar = (await db.execute(select(Avatar).where(Avatar.id == avatar_id))).scalar_one()
        config = json.loads(avatar.published_config)
        assert "/published/" in config["image_key"]
        assert config["image_key"] != avatar.image_key


async def test_the_draft_is_what_the_dashboard_shows(client, setup):
    headers, org_id, avatar_id, key = setup
    await client.patch(
        f"/orgs/{org_id}/avatars/{avatar_id}", json={"framing": "full"}, headers=headers
    )
    detail = (await client.get(f"/orgs/{org_id}/avatars/{avatar_id}", headers=headers)).json()
    assert detail["framing"] == "full"
    assert detail["unpublished"] is True


async def test_publishing_twice_with_no_edits_is_harmless(client, setup):
    headers, org_id, avatar_id, key = setup
    first = await client.post(f"/orgs/{org_id}/avatars/{avatar_id}/publish", headers=headers)
    second = await client.post(f"/orgs/{org_id}/avatars/{avatar_id}/publish", headers=headers)
    assert first.status_code == 200 and second.status_code == 200
    assert second.json()["unpublished"] is False


async def test_discard_puts_the_draft_back(client, setup):
    """The escape hatch: an edit you regret should not need an undo stack
    walk, just 'go back to what my sites are already serving'."""
    headers, org_id, avatar_id, key = setup
    await client.patch(
        f"/orgs/{org_id}/avatars/{avatar_id}", json={"framing": "full"}, headers=headers
    )
    discarded = await client.post(
        f"/orgs/{org_id}/avatars/{avatar_id}/discard-draft", headers=headers
    )
    assert discarded.status_code == 200, discarded.text
    body = discarded.json()
    assert body["framing"] == "face"
    assert body["unpublished"] is False


async def test_share_pages_serve_published_too(client, setup):
    """A share link is a page other people open; a half-finished edit must
    not appear there either."""
    headers, org_id, avatar_id, key = setup
    token = (
        await client.post(f"/orgs/{org_id}/avatars/{avatar_id}/share", headers=headers)
    ).json()["share_token"]

    await client.patch(
        f"/orgs/{org_id}/avatars/{avatar_id}", json={"framing": "full"}, headers=headers
    )
    public = (await client.get(f"/public/v1/avatars/{token}")).json()
    assert public["framing"] == "face"

    await client.post(f"/orgs/{org_id}/avatars/{avatar_id}/publish", headers=headers)
    assert (await client.get(f"/public/v1/avatars/{token}")).json()["framing"] == "full"


async def _served_face_types(client, avatar_id, key, token) -> tuple[str, str]:
    embed = await client.get(f"/embed/v1/avatars/{avatar_id}", headers=key)
    public = await client.get(f"/public/v1/avatars/{token}")
    assert embed.status_code == 200 and public.status_code == 200
    return embed.json()["face_type"], public.json()["face_type"]


@pytest.mark.parametrize("face_type", ["animal", "cartoon"])
async def test_visitors_are_told_the_published_face_type(client, setup, face_type):
    """The embed and the share page carry what the avatar is: the engine
    turns a person's head in depth and moves an animal's or a cartoon's as
    a layer, which the rig cannot tell it (one fitted before render
    profiles names none, whatever the face). The dashboard shows the
    draft's; visitors get the published one, changed on Publish."""
    headers, org_id, avatar_id, key = setup
    base = f"/orgs/{org_id}/avatars/{avatar_id}"
    token = (await client.post(f"{base}/share", headers=headers)).json()["share_token"]
    assert await _served_face_types(client, avatar_id, key, token) == ("human", "human")

    patched = (await client.patch(base, json={"face_type": face_type}, headers=headers)).json()
    assert patched["face_type"] == face_type and patched["unpublished"] is True
    assert (await client.get(base, headers=headers)).json()["face_type"] == face_type
    assert await _served_face_types(client, avatar_id, key, token) == ("human", "human")

    await client.post(f"{base}/publish", headers=headers)
    assert await _served_face_types(client, avatar_id, key, token) == (face_type, face_type)


async def test_a_snapshot_without_a_face_type_is_served_as_a_person(client, setup):
    """Every snapshot has carried its face type since publishing began
    (migration 020's backfill too); one that somehow does not is served as
    the line every avatar had before there were others."""
    from sqlalchemy import select

    from app.db import get_session_factory
    from app.models import Avatar

    headers, org_id, avatar_id, key = setup
    base = f"/orgs/{org_id}/avatars/{avatar_id}"
    token = (await client.post(f"{base}/share", headers=headers)).json()["share_token"]
    async with get_session_factory()() as db:
        avatar = (await db.execute(select(Avatar).where(Avatar.id == avatar_id))).scalar_one()
        avatar.face_type = "animal"
        config = json.loads(avatar.published_config)
        config.pop("face_type")
        avatar.published_config = json.dumps(config)
        await db.commit()

    assert await _served_face_types(client, avatar_id, key, token) == ("human", "human")


async def test_renaming_is_not_an_unpublished_change(client, setup):
    """Only things a VISITOR could notice mark the draft dirty. A rename is
    dashboard bookkeeping; flagging it would train people to ignore the bar."""
    headers, org_id, avatar_id, key = setup
    await client.patch(
        f"/orgs/{org_id}/avatars/{avatar_id}", json={"name": "New name"}, headers=headers
    )
    detail = (await client.get(f"/orgs/{org_id}/avatars/{avatar_id}", headers=headers)).json()
    assert detail["name"] == "New name"
    assert detail["unpublished"] is False


async def test_sharing_is_not_an_unpublished_change(client, setup):
    headers, org_id, avatar_id, key = setup
    await client.post(f"/orgs/{org_id}/avatars/{avatar_id}/share", headers=headers)
    detail = (await client.get(f"/orgs/{org_id}/avatars/{avatar_id}", headers=headers)).json()
    assert detail["unpublished"] is False


async def test_every_visible_edit_marks_the_draft(client, setup):
    """If a mutation forgets to mark the draft, it ships to visitors silently
    on the next unrelated publish — the exact failure this split prevents."""
    headers, org_id, avatar_id, key = setup
    base = f"/orgs/{org_id}/avatars/{avatar_id}"

    async def unpublished() -> bool:
        return (await client.get(base, headers=headers)).json()["unpublished"]

    marks = {
        "mouth": {
            "left": {"x": 120, "y": 250},
            "right": {"x": 200, "y": 250},
            "top": {"x": 160, "y": 240},
            "bottom": {"x": 160, "y": 262},
        },
        "persist": True,
    }
    for label, call in [
        ("framing", lambda: client.patch(base, json={"framing": "full"}, headers=headers)),
        ("face_type", lambda: client.patch(base, json={"face_type": "animal"}, headers=headers)),
        ("rig-fit", lambda: client.post(f"{base}/rig-fit", json=marks, headers=headers)),
    ]:
        await client.post(f"{base}/publish", headers=headers)
        assert await unpublished() is False, label
        await call()
        assert await unpublished() is True, f"{label} did not mark the draft dirty"


async def test_another_org_cannot_publish_your_avatar(client, setup):
    headers, org_id, avatar_id, key = setup
    other = await register_and_login(client, "intruder")
    other_org = await create_org(client, other, name="Other")
    response = await client.post(f"/orgs/{other_org}/avatars/{avatar_id}/publish", headers=other)
    assert response.status_code == 404


async def test_startup_runs_the_recovery(client, setup, monkeypatch):
    """The recovery only helps if the app runs it on boot."""
    from app import main
    from app.core.config import get_settings
    from app.services.tts import lab_timing

    async def nothing() -> None:
        return None

    async def no_schema(_engine) -> None:
        return None

    # Only the recovery is under test: no migrations, sweeper or model warm-up.
    monkeypatch.setattr(main, "ensure_schema", no_schema)
    monkeypatch.setattr(lab_timing, "warm_native", nothing)
    monkeypatch.setattr(get_settings(), "candidate_retention_hours", 0, raising=False)

    headers, org_id, avatar_id, _ = setup
    await _set_status(avatar_id, AvatarStatus.processing)
    async with main.lifespan(main.app):
        pass
    detail = (await client.get(f"/orgs/{org_id}/avatars/{avatar_id}", headers=headers)).json()
    assert detail["status"] == "failed"
