from tests.conftest import create_org, create_ready_avatar, register_and_login


async def _setup(client, allowed_domains=None):
    headers = await register_and_login(client, "alice")
    org_id = await create_org(client, headers)
    avatar_id = await create_ready_avatar(client, headers, org_id)
    created = await client.post(
        f"/orgs/{org_id}/api-keys",
        json={"name": "widget", "allowed_domains": allowed_domains or []},
        headers=headers,
    )
    assert created.status_code == 201, created.text
    return headers, org_id, avatar_id, created.json()


async def test_api_key_plaintext_shown_once(client):
    headers, org_id, _, created = await _setup(client)
    plaintext = created["plaintext"]
    assert plaintext.startswith("lf_")
    assert created["api_key"]["prefix"] == plaintext[:12]
    listing = (await client.get(f"/orgs/{org_id}/api-keys", headers=headers)).json()
    assert "plaintext" not in listing[0]
    assert "key_hash" not in listing[0]


async def test_embed_avatar_with_key(client):
    _, _, avatar_id, created = await _setup(client)
    response = await client.get(
        f"/embed/v1/avatars/{avatar_id}",
        headers={"X-Api-Key": created["plaintext"]},
    )
    assert response.status_code == 200
    body = response.json()
    # Absolute URLs so third-party pages can load them.
    assert body["rig_url"].startswith("http://testserver/")
    assert body["thumbnail_url"].startswith("http://testserver/")


async def test_embed_requires_key(client):
    _, _, avatar_id, _ = await _setup(client)
    response = await client.get(f"/embed/v1/avatars/{avatar_id}")
    assert response.status_code == 401


async def test_embed_invalid_key(client):
    _, _, avatar_id, _ = await _setup(client)
    response = await client.get(
        f"/embed/v1/avatars/{avatar_id}", headers={"X-Api-Key": "lf_wrong"}
    )
    assert response.status_code == 401


async def test_revoked_key_rejected(client):
    headers, org_id, avatar_id, created = await _setup(client)
    await client.delete(
        f"/orgs/{org_id}/api-keys/{created['api_key']['id']}", headers=headers
    )
    response = await client.get(
        f"/embed/v1/avatars/{avatar_id}", headers={"X-Api-Key": created["plaintext"]}
    )
    assert response.status_code == 401


async def test_origin_check_blocks_unlisted_domain(client):
    _, _, avatar_id, created = await _setup(client, allowed_domains=["example.com"])
    response = await client.get(
        f"/embed/v1/avatars/{avatar_id}",
        headers={"X-Api-Key": created["plaintext"], "Origin": "https://evil.com"},
    )
    assert response.status_code == 403
    assert response.json()["code"] == "origin_not_allowed"


async def test_origin_check_allows_listed_domain(client):
    _, _, avatar_id, created = await _setup(client, allowed_domains=["example.com"])
    response = await client.get(
        f"/embed/v1/avatars/{avatar_id}",
        headers={"X-Api-Key": created["plaintext"], "Origin": "https://example.com"},
    )
    assert response.status_code == 200


async def test_origin_check_wildcard_subdomains(client):
    _, _, avatar_id, created = await _setup(client, allowed_domains=["*.example.com"])
    ok = await client.get(
        f"/embed/v1/avatars/{avatar_id}",
        headers={"X-Api-Key": created["plaintext"], "Origin": "https://app.example.com"},
    )
    assert ok.status_code == 200
    bad = await client.get(
        f"/embed/v1/avatars/{avatar_id}",
        headers={"X-Api-Key": created["plaintext"], "Origin": "https://example.org"},
    )
    assert bad.status_code == 403


async def test_embed_synthesize(client):
    _, _, _, created = await _setup(client)
    response = await client.post(
        "/embed/v1/synthesize",
        json={"text": "Hi there", "provider": "offline", "voice": "offline-warm"},
        headers={"X-Api-Key": created["plaintext"]},
    )
    assert response.status_code == 200
    assert response.json()["cues"]


async def test_embed_rate_limit(client):
    # conftest sets the embed limit to 5/minute.
    _, _, avatar_id, created = await _setup(client)
    key_headers = {"X-Api-Key": created["plaintext"]}
    statuses = []
    for _ in range(7):
        response = await client.get(f"/embed/v1/avatars/{avatar_id}", headers=key_headers)
        statuses.append(response.status_code)
    assert statuses.count(429) >= 2
    assert response.json()["code"] == "rate_limited"


async def test_embed_cors_reflects_origin(client):
    _, _, avatar_id, created = await _setup(client)
    response = await client.get(
        f"/embed/v1/avatars/{avatar_id}",
        headers={"X-Api-Key": created["plaintext"], "Origin": "https://anyhost.example"},
    )
    assert response.headers["access-control-allow-origin"] == "https://anyhost.example"


async def test_embed_preflight_options(client):
    response = await client.options(
        "/embed/v1/synthesize",
        headers={
            "Origin": "https://host.example",
            "Access-Control-Request-Method": "POST",
        },
    )
    assert response.status_code == 204
    assert response.headers["access-control-allow-origin"] == "https://host.example"
    assert "X-Api-Key" in response.headers["access-control-allow-headers"]


async def test_member_cannot_manage_api_keys(client):
    alice = await register_and_login(client, "alice")
    org_id = await create_org(client, alice)
    invite = await client.post(
        f"/orgs/{org_id}/invitations",
        json={"email": "bob@example.com"},
        headers=alice,
    )
    bob = await register_and_login(client, "bob")
    await client.post(f"/invitations/{invite.json()['token']}/accept", headers=bob)
    response = await client.post(
        f"/orgs/{org_id}/api-keys", json={"name": "nope"}, headers=bob
    )
    assert response.status_code == 403


async def test_cues_endpoint_is_public_and_timed(client) -> None:
    """The browser voice fetches this without a key — it synthesises nothing."""
    response = await client.post("/embed/v1/cues", json={"text": "Hello world."})
    assert response.status_code == 200
    body = response.json()

    assert body["duration_ms"] > 0
    assert body["cues"][-1]["viseme"] == "sil"
    assert all(b["t"] > a["t"] for a, b in zip(body["cues"], body["cues"][1:]))
    assert [m["char"] for m in body["word_marks"]] == [0, 6]


async def test_cues_endpoint_rejects_empty_text(client) -> None:
    assert (await client.post("/embed/v1/cues", json={"text": ""})).status_code == 422
