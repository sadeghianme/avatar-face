"""Draft vs published: nothing an owner does reaches a visitor until Publish."""

import json

import pytest

from tests.conftest import create_org, create_ready_avatar, register_and_login


@pytest.fixture
async def setup(client):
    headers = await register_and_login(client, "publisher")
    org_id = await create_org(client, headers)
    avatar_id = await create_ready_avatar(client, headers, org_id)
    key = await client.post(
        f"/orgs/{org_id}/api-keys", json={"name": "w", "allowed_domains": []}, headers=headers
    )
    return headers, org_id, avatar_id, {"X-Api-Key": key.json()["plaintext"]}


async def test_a_new_avatar_publishes_itself(client, setup):
    """Creating an avatar and pasting the snippet has to work immediately.
    Only the FIRST build auto-publishes; later edits wait for Publish."""
    headers, org_id, avatar_id, key = setup
    detail = (await client.get(f"/orgs/{org_id}/avatars/{avatar_id}", headers=headers)).json()
    assert detail["unpublished"] is False
    assert (await client.get(f"/embed/v1/avatars/{avatar_id}", headers=key)).status_code == 200


async def test_published_assets_are_copies_not_pointers(client, setup):
    """The load-bearing decision. Layer files are written to a fixed path and
    overwritten in place, so a snapshot that merely recorded live keys would
    silently change under published clients on the next rebuild."""
    headers, org_id, avatar_id, key = setup
    from app.db import get_session_factory
    from app.models import Avatar
    from sqlalchemy import select

    async with get_session_factory()() as db:
        avatar = (
            await db.execute(select(Avatar).where(Avatar.id == avatar_id))
        ).scalar_one()
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

    for label, call in [
        ("framing", lambda: client.patch(base, json={"framing": "full"}, headers=headers)),
        ("face_type", lambda: client.patch(base, json={"face_type": "animal"}, headers=headers)),
    ]:
        await client.post(f"{base}/publish", headers=headers)
        assert await unpublished() is False, label
        await call()
        assert await unpublished() is True, f"{label} did not mark the draft dirty"


async def test_another_org_cannot_publish_your_avatar(client, setup):
    headers, org_id, avatar_id, key = setup
    other = await register_and_login(client, "intruder")
    other_org = await create_org(client, other, name="Other")
    response = await client.post(
        f"/orgs/{other_org}/avatars/{avatar_id}/publish", headers=other
    )
    assert response.status_code == 404
