"""Simulator tokens: short-lived, origin-bound, signed rather than stored."""

import time

import pytest

from app.services.simulator_token import (
    InvalidSimulatorToken,
    looks_like_one,
    mint,
    verify,
)
from tests.conftest import create_org, create_ready_avatar, register_and_login

SECRET = "test-secret"


def test_a_minted_token_verifies_for_its_own_origin():
    token, expires_at = mint(SECRET, "org123", "dash.example.com")
    assert looks_like_one(token)
    assert expires_at > time.time()
    assert verify(SECRET, token, "dash.example.com") == "org123"


def test_case_in_the_origin_does_not_matter():
    token, _ = mint(SECRET, "org123", "dash.example.com")
    assert verify(SECRET, token, "DASH.Example.COM") == "org123"


def test_a_token_is_useless_from_another_origin():
    """Origin binding is the main control — an escaped token should be inert."""
    token, _ = mint(SECRET, "org123", "dash.example.com")
    with pytest.raises(InvalidSimulatorToken):
        verify(SECRET, token, "attacker.example.net")


def test_a_token_signed_with_another_secret_is_rejected():
    token, _ = mint("someone-elses-secret", "org123", "dash.example.com")
    with pytest.raises(InvalidSimulatorToken):
        verify(SECRET, token, "dash.example.com")


def test_the_payload_cannot_be_edited_to_reach_another_org():
    """The org id travels in the token, so it has to be covered by the signature."""
    import base64

    token, _ = mint(SECRET, "org123", "dash.example.com")
    encoded, signature = token.removeprefix("lfsim_").split(".", 1)
    padding = "=" * (-len(encoded) % 4)
    payload = base64.urlsafe_b64decode(encoded + padding).decode()
    tampered = payload.replace("org123", "org999")
    forged = (
        "lfsim_"
        + base64.urlsafe_b64encode(tampered.encode()).decode().rstrip("=")
        + "."
        + signature
    )
    with pytest.raises(InvalidSimulatorToken):
        verify(SECRET, forged, "dash.example.com")


def test_an_expired_token_is_rejected():
    token, _ = mint(SECRET, "org123", "dash.example.com", ttl_seconds=-1)
    with pytest.raises(InvalidSimulatorToken):
        verify(SECRET, token, "dash.example.com")


def test_garbage_is_rejected_rather_than_crashing():
    for bad in ("", "lfsim_", "lfsim_notbase64.sig", "lf_realkeylookalike", "lfsim_YWJj"):
        with pytest.raises(InvalidSimulatorToken):
            verify(SECRET, bad, "dash.example.com")


# --- through the API -------------------------------------------------------


async def test_the_token_authenticates_the_embed_api(client):
    """The whole point: it works exactly where a real key would."""
    headers = await register_and_login(client, "simuser")
    org_id = await create_org(client, headers)
    avatar_id = await create_ready_avatar(client, headers, org_id)

    origin = {"origin": "http://testserver"}
    minted = await client.post(
        f"/orgs/{org_id}/api-keys/simulator-token", headers={**headers, **origin}
    )
    assert minted.status_code == 200, minted.text
    token = minted.json()["token"]

    response = await client.get(
        f"/embed/v1/avatars/{avatar_id}", headers={"X-Api-Key": token, **origin}
    )
    assert response.status_code == 200, response.text
    assert response.json()["id"] == avatar_id


async def test_the_token_does_not_reach_another_orgs_avatar(client):
    headers = await register_and_login(client, "simuser2")
    mine = await create_org(client, headers)
    theirs = await create_org(client, headers, name="Other")
    their_avatar = await create_ready_avatar(client, headers, theirs)

    origin = {"origin": "http://testserver"}
    token = (
        await client.post(f"/orgs/{mine}/api-keys/simulator-token", headers={**headers, **origin})
    ).json()["token"]

    response = await client.get(
        f"/embed/v1/avatars/{their_avatar}", headers={"X-Api-Key": token, **origin}
    )
    assert response.status_code == 404


async def test_the_token_is_rejected_from_a_different_origin_over_http(client):
    headers = await register_and_login(client, "simuser3")
    org_id = await create_org(client, headers)
    avatar_id = await create_ready_avatar(client, headers, org_id)

    token = (
        await client.post(
            f"/orgs/{org_id}/api-keys/simulator-token",
            headers={**headers, "origin": "http://testserver"},
        )
    ).json()["token"]

    response = await client.get(
        f"/embed/v1/avatars/{avatar_id}",
        headers={"X-Api-Key": token, "origin": "https://evil.example.net"},
    )
    assert response.status_code == 401


async def test_minting_needs_a_browser_origin(client):
    """An unbound token would just be a key with a timer."""
    headers = await register_and_login(client, "simuser4")
    org_id = await create_org(client, headers)
    response = await client.post(f"/orgs/{org_id}/api-keys/simulator-token", headers=headers)
    assert response.status_code == 422


async def test_the_token_never_appears_as_an_api_key(client):
    """Nothing to clean up, nothing to leak from the database."""
    headers = await register_and_login(client, "simuser5")
    org_id = await create_org(client, headers)
    await client.post(
        f"/orgs/{org_id}/api-keys/simulator-token",
        headers={**headers, "origin": "http://testserver"},
    )
    listed = await client.get(f"/orgs/{org_id}/api-keys", headers=headers)
    assert listed.json() == []
