"""Voice as a published property: change -> Publish bar -> visitors hear it."""

import pytest

from tests.conftest import create_org, create_ready_avatar, register_and_login


VOICE = {"provider": "piper", "voice": "fa_amir", "locale": "fa-IR"}


@pytest.fixture
async def org(client):
    headers = await register_and_login(client, "voicepub")
    org_id = await create_org(client, headers)
    avatar_id = await create_ready_avatar(client, headers, org_id)
    return headers, org_id, avatar_id


async def test_changing_the_voice_shows_the_publish_bar(client, org):
    headers, org_id, avatar_id = org
    before = (await client.get(f"/orgs/{org_id}/avatars/{avatar_id}", headers=headers)).json()
    assert before["unpublished"] is False  # fresh avatars auto-publish

    updated = (
        await client.patch(
            f"/orgs/{org_id}/avatars/{avatar_id}", json={"voice": VOICE}, headers=headers
        )
    ).json()
    assert updated["voice"] == VOICE
    assert updated["unpublished"] is True  # this is the Publish bar


async def test_visitors_hear_the_old_voice_until_publish(client, org):
    """The entire point of the draft split: picking a voice must not change
    a customer's live site until Publish is pressed."""
    headers, org_id, avatar_id = org
    key = (
        await client.post(
            f"/orgs/{org_id}/api-keys", json={"name": "site"}, headers=headers
        )
    ).json()["plaintext"]

    await client.patch(
        f"/orgs/{org_id}/avatars/{avatar_id}", json={"voice": VOICE}, headers=headers
    )
    served = (
        await client.get(f"/embed/v1/avatars/{avatar_id}", headers={"X-Api-Key": key})
    ).json()
    assert served.get("voice") != VOICE  # draft not leaked

    await client.post(f"/orgs/{org_id}/avatars/{avatar_id}/publish", headers=headers)
    served = (
        await client.get(f"/embed/v1/avatars/{avatar_id}", headers={"X-Api-Key": key})
    ).json()
    assert served["voice"] == VOICE  # now it is what visitors get


async def test_share_pages_get_the_published_voice_too(client, org):
    headers, org_id, avatar_id = org
    token = (
        await client.post(f"/orgs/{org_id}/avatars/{avatar_id}/share", headers=headers)
    ).json()["share_token"]

    await client.patch(
        f"/orgs/{org_id}/avatars/{avatar_id}", json={"voice": VOICE}, headers=headers
    )
    await client.post(f"/orgs/{org_id}/avatars/{avatar_id}/publish", headers=headers)
    public = (await client.get(f"/public/v1/avatars/{token}")).json()
    assert public["voice"] == VOICE


async def test_discarding_the_draft_reverts_the_dirty_flag(client, org):
    headers, org_id, avatar_id = org
    await client.patch(
        f"/orgs/{org_id}/avatars/{avatar_id}", json={"voice": VOICE}, headers=headers
    )
    discarded = (
        await client.post(f"/orgs/{org_id}/avatars/{avatar_id}/discard-draft", headers=headers)
    ).json()
    assert discarded["unpublished"] is False
