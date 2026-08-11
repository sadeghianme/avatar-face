from sqlalchemy import select

from app.core.credentials import credentials, decrypt_value
from app.db import get_session_factory
from app.models import ProviderCredential
from tests.conftest import create_org, register_and_login


async def test_get_integrations_initial_state(client):
    headers = await register_and_login(client, "alice")
    org_id = await create_org(client, headers)
    response = await client.get(f"/orgs/{org_id}/integrations", headers=headers)
    assert response.status_code == 200
    providers = {p["provider"] for p in response.json()}
    assert providers == {"azure", "elevenlabs", "google", "openai", "gemini"}
    for provider in response.json():
        assert provider["configured"] is False
        for field in provider["fields"]:
            assert field["source"] == "unset"


async def test_providers_declare_what_they_are_for(client):
    """The dashboard groups by kind, and `test` dispatches on it — asking the
    speech registry to test an image provider fails in a way that reads as a
    broken key rather than a wrong question."""
    headers = await register_and_login(client, "kinds")
    org_id = await create_org(client, headers)
    response = await client.get(f"/orgs/{org_id}/integrations", headers=headers)
    kinds = {p["provider"]: p["kind"] for p in response.json()}
    assert kinds["gemini"] == "image"
    assert kinds["elevenlabs"] == "voice"
    assert set(kinds.values()) <= {"voice", "image"}


async def test_testing_an_image_provider_without_a_key_says_so(client):
    """And does not fall through to the speech registry."""
    headers = await register_and_login(client, "imgtest")
    org_id = await create_org(client, headers)
    response = await client.post(f"/orgs/{org_id}/integrations/gemini/test", headers=headers)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["ok"] is False
    assert "key" in body["error"].lower()


async def test_put_credential_masked_and_effective(client):
    headers = await register_and_login(client, "alice")
    org_id = await create_org(client, headers)
    response = await client.put(
        f"/orgs/{org_id}/integrations",
        json={"values": {"elevenlabs_api_key": "sk-secret-value-9876"}},
        headers=headers,
    )
    assert response.status_code == 200
    eleven = next(p for p in response.json() if p["provider"] == "elevenlabs")
    field = eleven["fields"][0]
    # Write-only: never echoed back, only masked.
    assert field["masked"] == "••••9876"
    assert "sk-secret" not in str(response.json())
    assert field["source"] == "db"
    assert eleven["configured"] is True
    # Takes effect with no restart: provider list now includes elevenlabs.
    providers = (await client.get("/tts/providers")).json()
    assert "elevenlabs" in [p["name"] for p in providers]


async def test_credentials_encrypted_at_rest(client):
    headers = await register_and_login(client, "alice")
    org_id = await create_org(client, headers)
    secret = "sk-super-secret-1234"
    await client.put(
        f"/orgs/{org_id}/integrations",
        json={"values": {"openai_api_key": secret}},
        headers=headers,
    )
    async with get_session_factory()() as db:
        row = (
            await db.execute(
                select(ProviderCredential).where(ProviderCredential.name == "openai_api_key")
            )
        ).scalar_one()
    # The raw row must NOT contain the plaintext...
    assert secret.encode() not in row.encrypted_value
    # ...but must decrypt back to it.
    assert decrypt_value(row.encrypted_value) == secret


async def test_clearing_credential(client):
    headers = await register_and_login(client, "alice")
    org_id = await create_org(client, headers)
    await client.put(
        f"/orgs/{org_id}/integrations",
        json={"values": {"openai_api_key": "sk-x-1234"}},
        headers=headers,
    )
    response = await client.put(
        f"/orgs/{org_id}/integrations",
        json={"values": {"openai_api_key": ""}},
        headers=headers,
    )
    openai = next(p for p in response.json() if p["provider"] == "openai")
    assert openai["fields"][0]["source"] == "unset"
    assert credentials.get("openai_api_key") is None


async def test_unknown_field_rejected(client):
    headers = await register_and_login(client, "alice")
    org_id = await create_org(client, headers)
    response = await client.put(
        f"/orgs/{org_id}/integrations",
        json={"values": {"evil_field": "x"}},
        headers=headers,
    )
    assert response.status_code == 422


async def test_integrations_owner_only(client):
    alice = await register_and_login(client, "alice")
    org_id = await create_org(client, alice)
    invite = await client.post(
        f"/orgs/{org_id}/invitations",
        json={"email": "bob@example.com", "role": "admin"},
        headers=alice,
    )
    bob = await register_and_login(client, "bob")
    await client.post(f"/invitations/{invite.json()['token']}/accept", headers=bob)
    response = await client.get(f"/orgs/{org_id}/integrations", headers=bob)
    assert response.status_code == 403


async def test_test_endpoint_offline_provider(client):
    headers = await register_and_login(client, "alice")
    org_id = await create_org(client, headers)
    response = await client.post(
        f"/orgs/{org_id}/integrations/offline/test", headers=headers
    )
    assert response.status_code == 200
    assert response.json()["ok"] is True
