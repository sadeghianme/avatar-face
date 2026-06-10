from tests.conftest import create_org, register_and_login


async def test_create_and_list_orgs(client):
    headers = await register_and_login(client, "alice")
    org_id = await create_org(client, headers, "Acme")
    response = await client.get("/orgs", headers=headers)
    assert response.status_code == 200
    orgs = response.json()
    assert len(orgs) == 1
    assert orgs[0]["id"] == org_id
    assert orgs[0]["role"] == "owner"


async def test_non_member_gets_404(client):
    alice = await register_and_login(client, "alice")
    bob = await register_and_login(client, "bob")
    org_id = await create_org(client, alice)
    response = await client.get(f"/orgs/{org_id}", headers=bob)
    assert response.status_code == 404  # existence not leaked


async def test_rename_requires_admin(client):
    alice = await register_and_login(client, "alice")
    org_id = await create_org(client, alice)
    response = await client.patch(
        f"/orgs/{org_id}", json={"name": "Renamed"}, headers=alice
    )
    assert response.status_code == 200
    assert response.json()["name"] == "Renamed"


async def _invite_and_accept(client, org_id, inviter_headers, username, role="member"):
    invite = await client.post(
        f"/orgs/{org_id}/invitations",
        json={"email": f"{username}@example.com", "role": role},
        headers=inviter_headers,
    )
    assert invite.status_code == 201, invite.text
    token = invite.json()["token"]
    user_headers = await register_and_login(client, username)
    accept = await client.post(f"/invitations/{token}/accept", headers=user_headers)
    assert accept.status_code == 200, accept.text
    return user_headers


async def test_invitation_accept_flow(client):
    alice = await register_and_login(client, "alice")
    org_id = await create_org(client, alice)
    bob = await _invite_and_accept(client, org_id, alice, "bob")

    response = await client.get(f"/orgs/{org_id}", headers=bob)
    assert response.status_code == 200
    assert response.json()["role"] == "member"

    members = await client.get(f"/orgs/{org_id}/members", headers=bob)
    assert len(members.json()) == 2


async def test_invitation_public_lookup(client):
    alice = await register_and_login(client, "alice")
    org_id = await create_org(client, alice, "Acme")
    invite = await client.post(
        f"/orgs/{org_id}/invitations",
        json={"email": "bob@example.com"},
        headers=alice,
    )
    token = invite.json()["token"]
    response = await client.get(f"/invitations/{token}")
    assert response.status_code == 200
    assert response.json()["org_name"] == "Acme"


async def test_invitation_email_mismatch(client):
    alice = await register_and_login(client, "alice")
    org_id = await create_org(client, alice)
    invite = await client.post(
        f"/orgs/{org_id}/invitations",
        json={"email": "bob@example.com"},
        headers=alice,
    )
    token = invite.json()["token"]
    carol = await register_and_login(client, "carol")
    response = await client.post(f"/invitations/{token}/accept", headers=carol)
    assert response.status_code == 422
    assert response.json()["code"] == "email_mismatch"


async def test_revoked_invitation_cannot_be_accepted(client):
    alice = await register_and_login(client, "alice")
    org_id = await create_org(client, alice)
    invite = await client.post(
        f"/orgs/{org_id}/invitations",
        json={"email": "bob@example.com"},
        headers=alice,
    )
    invitation_id, token = invite.json()["id"], invite.json()["token"]
    revoke = await client.delete(
        f"/orgs/{org_id}/invitations/{invitation_id}", headers=alice
    )
    assert revoke.status_code == 204
    bob = await register_and_login(client, "bob")
    response = await client.post(f"/invitations/{token}/accept", headers=bob)
    assert response.status_code == 404


async def test_member_cannot_invite(client):
    alice = await register_and_login(client, "alice")
    org_id = await create_org(client, alice)
    bob = await _invite_and_accept(client, org_id, alice, "bob")
    response = await client.post(
        f"/orgs/{org_id}/invitations",
        json={"email": "carol@example.com"},
        headers=bob,
    )
    assert response.status_code == 403
    assert response.json()["code"] == "insufficient_role"


async def test_admin_cannot_grant_owner(client):
    alice = await register_and_login(client, "alice")
    org_id = await create_org(client, alice)
    bob = await _invite_and_accept(client, org_id, alice, "bob", role="admin")
    response = await client.post(
        f"/orgs/{org_id}/invitations",
        json={"email": "carol@example.com", "role": "owner"},
        headers=bob,
    )
    assert response.status_code == 422
    assert response.json()["code"] == "owner_required"


async def test_role_change(client):
    alice = await register_and_login(client, "alice")
    org_id = await create_org(client, alice)
    await _invite_and_accept(client, org_id, alice, "bob")
    members = (await client.get(f"/orgs/{org_id}/members", headers=alice)).json()
    bob_membership = next(m for m in members if m["username"] == "bob")
    response = await client.patch(
        f"/orgs/{org_id}/members/{bob_membership['membership_id']}",
        json={"role": "admin"},
        headers=alice,
    )
    assert response.status_code == 200
    assert response.json()["role"] == "admin"


async def test_last_owner_cannot_be_demoted(client):
    alice = await register_and_login(client, "alice")
    org_id = await create_org(client, alice)
    members = (await client.get(f"/orgs/{org_id}/members", headers=alice)).json()
    response = await client.patch(
        f"/orgs/{org_id}/members/{members[0]['membership_id']}",
        json={"role": "member"},
        headers=alice,
    )
    assert response.status_code == 409
    assert response.json()["code"] == "last_owner"


async def test_last_owner_cannot_be_removed(client):
    alice = await register_and_login(client, "alice")
    org_id = await create_org(client, alice)
    members = (await client.get(f"/orgs/{org_id}/members", headers=alice)).json()
    response = await client.delete(
        f"/orgs/{org_id}/members/{members[0]['membership_id']}", headers=alice
    )
    assert response.status_code == 409


async def test_remove_member(client):
    alice = await register_and_login(client, "alice")
    org_id = await create_org(client, alice)
    bob = await _invite_and_accept(client, org_id, alice, "bob")
    members = (await client.get(f"/orgs/{org_id}/members", headers=alice)).json()
    bob_membership = next(m for m in members if m["username"] == "bob")
    response = await client.delete(
        f"/orgs/{org_id}/members/{bob_membership['membership_id']}", headers=alice
    )
    assert response.status_code == 204
    assert (await client.get(f"/orgs/{org_id}", headers=bob)).status_code == 404


async def test_duplicate_member_invite_conflicts(client):
    alice = await register_and_login(client, "alice")
    org_id = await create_org(client, alice)
    await _invite_and_accept(client, org_id, alice, "bob")
    response = await client.post(
        f"/orgs/{org_id}/invitations",
        json={"email": "bob@example.com"},
        headers=alice,
    )
    assert response.status_code == 409
    assert response.json()["code"] == "already_member"
