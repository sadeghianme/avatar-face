from tests.conftest import create_org, register_and_login


async def _synthesize(client, headers, org_id, text):
    return await client.post(
        f"/tts/orgs/{org_id}/synthesize",
        json={"text": text, "provider": "offline", "voice": "offline-warm"},
        headers=headers,
    )


async def test_usage_summary_counts_chars(client):
    headers = await register_and_login(client, "alice")
    org_id = await create_org(client, headers)
    await _synthesize(client, headers, org_id, "12345")
    await _synthesize(client, headers, org_id, "abc")
    summary = (await client.get(f"/orgs/{org_id}/usage", headers=headers)).json()
    assert summary["chars_used"] == 8
    assert summary["char_limit"] == 1000  # conftest override
    providers = {p["provider"]: p for p in summary["by_provider"]}
    assert providers["offline"]["syntheses"] == 2


async def test_cached_synthesis_still_metered(client):
    headers = await register_and_login(client, "alice")
    org_id = await create_org(client, headers)
    await _synthesize(client, headers, org_id, "same text")
    await _synthesize(client, headers, org_id, "same text")
    summary = (await client.get(f"/orgs/{org_id}/usage", headers=headers)).json()
    assert summary["chars_used"] == 18


async def test_usage_limit_blocks_with_429(client):
    headers = await register_and_login(client, "alice")
    org_id = await create_org(client, headers)
    # Limit is 1000 chars (conftest); burn most of it, then exceed.
    await _synthesize(client, headers, org_id, "x" * 990)
    response = await _synthesize(client, headers, org_id, "y" * 20)
    assert response.status_code == 429
    assert response.json()["code"] == "usage_limit_reached"


async def test_usage_limit_is_per_org(client):
    headers = await register_and_login(client, "alice")
    org_a = await create_org(client, headers, "A")
    org_b = await create_org(client, headers, "B")
    await _synthesize(client, headers, org_a, "x" * 990)
    response = await _synthesize(client, headers, org_b, "hello")
    assert response.status_code == 200


async def test_embed_usage_shares_org_limit(client):
    headers = await register_and_login(client, "alice")
    org_id = await create_org(client, headers)
    created = await client.post(
        f"/orgs/{org_id}/api-keys", json={"name": "k"}, headers=headers
    )
    await _synthesize(client, headers, org_id, "x" * 990)
    response = await client.post(
        "/embed/v1/synthesize",
        json={"text": "y" * 20, "provider": "offline", "voice": "offline-warm"},
        headers={"X-Api-Key": created.json()["plaintext"]},
    )
    assert response.status_code == 429
    assert response.json()["code"] == "usage_limit_reached"
