"""Public share pages: what a stranger with the link can and cannot do."""

import pytest

from tests.conftest import create_org, create_ready_avatar, register_and_login


@pytest.fixture
async def shared(client):
    headers = await register_and_login(client, "sharer")
    org_id = await create_org(client, headers)
    avatar_id = await create_ready_avatar(client, headers, org_id)
    response = await client.post(f"/orgs/{org_id}/avatars/{avatar_id}/share", headers=headers)
    assert response.status_code == 200, response.text
    return {
        "headers": headers,
        "org_id": org_id,
        "avatar_id": avatar_id,
        "token": response.json()["share_token"],
    }


async def test_sharing_is_off_until_asked_for(client):
    headers = await register_and_login(client, "notshared")
    org_id = await create_org(client, headers)
    avatar_id = await create_ready_avatar(client, headers, org_id)
    detail = (await client.get(f"/orgs/{org_id}/avatars/{avatar_id}", headers=headers)).json()
    assert detail["share_token"] is None


async def test_the_link_works_without_any_credentials(client, shared):
    response = await client.get(f"/public/v1/avatars/{shared['token']}")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["rig_url"] and body["image_url"]
    # Nothing addressable: a visitor must not learn ids they could reuse
    # against authenticated routes.
    assert "org_id" not in body
    assert "id" not in body


async def test_enabling_twice_keeps_the_same_link(client, shared):
    again = await client.post(
        f"/orgs/{shared['org_id']}/avatars/{shared['avatar_id']}/share",
        headers=shared["headers"],
    )
    assert again.json()["share_token"] == shared["token"]


async def test_revoking_kills_the_link(client, shared):
    await client.delete(
        f"/orgs/{shared['org_id']}/avatars/{shared['avatar_id']}/share",
        headers=shared["headers"],
    )
    assert (await client.get(f"/public/v1/avatars/{shared['token']}")).status_code == 404


async def test_an_unknown_token_is_a_404(client):
    assert (await client.get("/public/v1/avatars/" + "0" * 32)).status_code == 404


async def test_speak_text_is_capped(client, shared):
    """Every character is billed to the owner, so the cap is the bill's ceiling."""
    response = await client.post(
        f"/public/v1/avatars/{shared['token']}/speak", json={"text": "x" * 5000}
    )
    assert response.status_code == 422


async def test_speaking_through_a_dead_link_is_refused(client, shared):
    await client.delete(
        f"/orgs/{shared['org_id']}/avatars/{shared['avatar_id']}/share",
        headers=shared["headers"],
    )
    response = await client.post(
        f"/public/v1/avatars/{shared['token']}/speak", json={"text": "hello"}
    )
    assert response.status_code == 404


async def test_another_org_cannot_revoke_your_link(client, shared):
    """The share endpoints are org-scoped like every other avatar route."""
    other = await register_and_login(client, "stranger")
    other_org = await create_org(client, other, name="Other")
    response = await client.delete(
        f"/orgs/{other_org}/avatars/{shared['avatar_id']}/share", headers=other
    )
    assert response.status_code == 404
    assert (await client.get(f"/public/v1/avatars/{shared['token']}")).status_code == 200
