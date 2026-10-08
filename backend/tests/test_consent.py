"""Consents and the organization's third-party AI switch.

A consent is evidence: who agreed, to which wording, naming which
provider, from where (as a keyed hash, never the address). These tests pin
what the server accepts as evidence and what it refuses to record.
"""

import hashlib

import pytest
from sqlalchemy import select

from app.db import get_session_factory
from app.models import Consent
from app.services import consent as svc
from tests.conftest import create_org, register_and_login


async def _org(client, who: str) -> tuple[dict, str]:
    headers = await register_and_login(client, who)
    return headers, await create_org(client, headers)


async def _give(client, headers, org_id, scope="third_party_ai", version=None, **extra):
    return await client.post(
        f"/orgs/{org_id}/consents",
        json={"scope": scope, "text_version": version or svc.TEXT_VERSIONS[scope], **extra},
        headers=headers,
    )


async def _creation(org_id: str) -> str:
    """A draft creation in the org, the subject a statement about a face
    names. Only its row: these tests are about the statement."""
    from app.models import Creation, CreationStatus, Membership

    async with get_session_factory()() as db:
        owner = (
            (await db.execute(select(Membership.user_id).where(Membership.org_id == org_id)))
            .scalars()
            .first()
        )
        creation = Creation(
            org_id=org_id,
            created_by_id=owner,
            face_type="human",
            status=CreationStatus.draft,
            revision=0,
        )
        db.add(creation)
        await db.commit()
        return creation.id


async def _statement(client, headers, org_id, scope="depiction", creation_id=None):
    return await _give(
        client,
        headers,
        org_id,
        scope=scope,
        creation_id=creation_id or await _creation(org_id),
    )


async def _row(consent_id: str) -> Consent:
    async with get_session_factory()() as db:
        return (await db.execute(select(Consent).where(Consent.id == consent_id))).scalar_one()


async def test_the_terms_name_google_and_the_versions_in_force(client):
    headers, org_id = await _org(client, "reader")
    response = await client.get(f"/orgs/{org_id}/consents/terms", headers=headers)
    assert response.status_code == 200, response.text
    assert response.json() == {
        "third_party_ai": {
            "text_version": svc.TEXT_VERSIONS["third_party_ai"],
            "providers": ["google"],
        },
        "depiction": {"text_version": svc.TEXT_VERSIONS["depiction"], "providers": []},
        "generated_face": {"text_version": svc.TEXT_VERSIONS["generated_face"], "providers": []},
        "third_party_ai_enabled": True,
    }


async def test_a_third_party_ai_consent_names_google_by_default(client):
    headers, org_id = await _org(client, "agreer")
    response = await _give(client, headers, org_id)
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["scope"] == "third_party_ai" and body["providers"] == ["google"]
    assert body["text_version"] == svc.TEXT_VERSIONS["third_party_ai"]
    row = await _row(body["id"])
    assert row.org_id == org_id and row.providers == ["google"]


async def test_the_address_is_stored_only_as_a_keyed_hash(client):
    headers, org_id = await _org(client, "hashed")
    response = await _statement(client, headers, org_id)
    row = await _row(response.json()["id"])
    # The ASGI test client's address; never stored as itself.
    assert row.ip_hash == svc.ip_hash("127.0.0.1")
    assert "127.0.0.1" not in row.ip_hash
    assert row.ip_hash != hashlib.sha256(b"127.0.0.1").hexdigest(), "not an unkeyed hash"
    assert len(row.ip_hash) == 64
    assert row.providers == [], "a depiction statement names no provider"


def test_the_hash_depends_on_the_server_secret(monkeypatch):
    from app.core.config import get_settings

    first = svc.ip_hash("203.0.113.9")
    monkeypatch.setattr(get_settings(), "jwt_secret", "another-secret")
    assert svc.ip_hash("203.0.113.9") != first
    assert svc.ip_hash(None) is None


@pytest.mark.parametrize(
    "body, code",
    [
        ({"scope": "third_party_ai", "text_version": "1999-01-01"}, "unknown_consent_version"),
        ({"scope": "depiction", "text_version": "1999-01-01"}, "unknown_consent_version"),
        (
            {
                "scope": "third_party_ai",
                "text_version": svc.TEXT_VERSIONS["third_party_ai"],
                "providers": ["openai"],
            },
            "unknown_provider",
        ),
        ({"scope": "marketing", "text_version": "x"}, "validation_error"),
        # An empty list names nobody: never recorded as Google.
        (
            {
                "scope": "third_party_ai",
                "text_version": svc.TEXT_VERSIONS["third_party_ai"],
                "providers": [],
            },
            "unknown_provider",
        ),
        # A statement about a face says which face.
        (
            {"scope": "depiction", "text_version": svc.TEXT_VERSIONS["depiction"]},
            "consent_subject_required",
        ),
        (
            {"scope": "generated_face", "text_version": svc.TEXT_VERSIONS["generated_face"]},
            "consent_subject_required",
        ),
    ],
)
async def test_unknown_wordings_scopes_and_providers_are_refused(client, body, code):
    headers, org_id = await _org(client, "picky")
    response = await client.post(f"/orgs/{org_id}/consents", json=body, headers=headers)
    assert response.status_code == 422, response.text
    assert response.json()["code"] == code
    async with get_session_factory()() as db:
        assert (await db.execute(select(Consent))).scalars().all() == []


async def test_an_outdated_version_tells_the_client_the_current_one(client):
    headers, org_id = await _org(client, "stale")
    response = await _give(client, headers, org_id, version="2000-01-01")
    assert response.json()["current_version"] == svc.TEXT_VERSIONS["third_party_ai"]


async def test_consents_are_per_org_membership(client):
    headers, org_id = await _org(client, "insider")
    stranger = await register_and_login(client, "outsider")
    response = await _give(client, stranger, org_id)
    assert response.status_code == 404


# --- the switch ---------------------------------------------------------------------


async def _member(client, owner, org_id, username, role="member"):
    invite = await client.post(
        f"/orgs/{org_id}/invitations",
        json={"email": f"{username}@example.com", "role": role},
        headers=owner,
    )
    headers = await register_and_login(client, username)
    accepted = await client.post(f"/invitations/{invite.json()['token']}/accept", headers=headers)
    assert accepted.status_code == 200, accepted.text
    return headers


async def test_only_owners_and_admins_switch_third_party_ai(client):
    owner, org_id = await _org(client, "boss")
    member = await _member(client, owner, org_id, "worker")
    admin = await _member(client, owner, org_id, "deputy", role="admin")

    refused = await client.patch(
        f"/orgs/{org_id}", json={"third_party_ai_enabled": False}, headers=member
    )
    assert refused.status_code == 403 and refused.json()["code"] == "insufficient_role"

    off = await client.patch(
        f"/orgs/{org_id}", json={"third_party_ai_enabled": False}, headers=admin
    )
    assert off.status_code == 200, off.text
    assert off.json()["third_party_ai_enabled"] is False
    assert off.json()["name"] == "Acme", "the name is left alone"
    listed = (await client.get("/orgs", headers=member)).json()
    assert listed[0]["third_party_ai_enabled"] is False

    on = await client.patch(f"/orgs/{org_id}", json={"third_party_ai_enabled": True}, headers=owner)
    assert on.json()["third_party_ai_enabled"] is True


async def test_renaming_still_works_and_leaves_the_switch(client):
    headers, org_id = await _org(client, "renamer")
    response = await client.patch(f"/orgs/{org_id}", json={"name": "New"}, headers=headers)
    assert response.json()["name"] == "New"
    assert response.json()["third_party_ai_enabled"] is True


async def test_with_the_switch_off_no_ai_consent_is_recorded(client):
    headers, org_id = await _org(client, "careful")
    await client.patch(f"/orgs/{org_id}", json={"third_party_ai_enabled": False}, headers=headers)
    response = await _give(client, headers, org_id)
    assert response.status_code == 403
    assert response.json()["code"] == "third_party_ai_disabled"
    terms = (await client.get(f"/orgs/{org_id}/consents/terms", headers=headers)).json()
    assert terms["third_party_ai_enabled"] is False
    # The depiction statement is not about AI: still recorded.
    assert (await _statement(client, headers, org_id)).status_code == 201


# --- require ---------------------------------------------------------------------


async def test_require_accepts_only_this_users_current_consent_for_the_scope(client):
    from app.core.errors import Forbidden403
    from app.models import Membership, Organization

    alice, org_id = await _org(client, "alice")
    bob = await _member(client, alice, org_id, "bob")
    ai_id = (await _give(client, alice, org_id)).json()["id"]
    depiction_id = (await _statement(client, alice, org_id)).json()["id"]

    async with get_session_factory()() as db:
        org = await db.get(Organization, org_id)
        members = (
            await db.execute(select(Membership).where(Membership.org_id == org_id))
        ).scalars()
        by_role = {m.role.value: m.user_id for m in members}
        alice_id, bob_id = by_role["owner"], by_role["member"]

        agreed = await svc.require(db, ai_id, org, alice_id, svc.THIRD_PARTY_AI, "google")
        assert agreed.id == ai_id

        for consent_id, user_id, scope, provider in (
            (None, alice_id, svc.THIRD_PARTY_AI, "google"),  # none given
            ("nope", alice_id, svc.THIRD_PARTY_AI, "google"),  # unknown id
            (ai_id, bob_id, svc.THIRD_PARTY_AI, "google"),  # someone else's
            (depiction_id, alice_id, svc.THIRD_PARTY_AI, None),  # another scope
            (ai_id, alice_id, svc.THIRD_PARTY_AI, "openai"),  # another provider
        ):
            with pytest.raises(Forbidden403) as caught:
                await svc.require(db, consent_id, org, user_id, scope, provider)
            assert caught.value.code == "consent_required"
            assert caught.value.extra["scope"] == scope

        # A wording that changed since: asked again.
        row = await db.get(Consent, ai_id)
        row.text_version = "2020-01-01"
        await db.commit()
        with pytest.raises(Forbidden403):
            await svc.require(db, ai_id, org, alice_id, svc.THIRD_PARTY_AI, "google")

        # The org switch overrides any consent.
        org.third_party_ai_enabled = False
        await db.commit()
        with pytest.raises(Forbidden403) as off:
            await svc.require(db, ai_id, org, alice_id, svc.THIRD_PARTY_AI, "google")
        assert off.value.code == "third_party_ai_disabled"
    assert bob  # bob is a member: refused for being someone else, not a stranger


def test_with_consent_appends_once_and_copies():
    ids = ["a"]
    assert svc.with_consent(ids, "b") == ["a", "b"]
    assert svc.with_consent(ids, "a") == ["a"]
    assert ids == ["a"]
    assert svc.with_consent(None, "x") == ["x"]


# --- remembered: asked once per person and wording --------------------------------------


async def _mine(client, headers, org_id, scope="third_party_ai"):
    response = await client.get(
        f"/orgs/{org_id}/consents/mine", params={"scope": scope}, headers=headers
    )
    assert response.status_code == 200, response.text
    return response.json()


async def test_my_latest_consent_is_remembered_per_scope(client):
    headers, org_id = await _org(client, "rememberer")
    nothing = await _mine(client, headers, org_id)
    assert nothing == {
        "scope": "third_party_ai",
        "text_version": svc.TEXT_VERSIONS["third_party_ai"],
        "consent_id": None,
        "created_at": None,
        "stale": False,
    }

    first = (await _give(client, headers, org_id)).json()["id"]
    assert (await _mine(client, headers, org_id))["consent_id"] == first
    second = (await _give(client, headers, org_id)).json()["id"]
    assert (await _mine(client, headers, org_id))["consent_id"] == second
    # A depiction statement is another question, asked per avatar: never
    # remembered, never served up for reuse.
    await _statement(client, headers, org_id)
    refused = await client.get(
        f"/orgs/{org_id}/consents/mine", params={"scope": "depiction"}, headers=headers
    )
    assert refused.status_code == 422
    assert (await _mine(client, headers, org_id))["consent_id"] == second


async def test_a_remembered_consent_is_this_members_in_this_org(client):
    headers, org_id = await _org(client, "mine1")
    mine = (await _give(client, headers, org_id)).json()["id"]
    other_headers, other_org = await _org(client, "mine2")
    assert (await _mine(client, other_headers, other_org))["consent_id"] is None
    # Not someone else's org, even for the same person.
    second_org = await create_org(client, headers)
    assert (await _mine(client, headers, second_org))["consent_id"] is None
    assert (await _mine(client, headers, org_id))["consent_id"] == mine
    # And another org's members cannot read this one.
    denied = await client.get(
        f"/orgs/{org_id}/consents/mine", params={"scope": "third_party_ai"}, headers=other_headers
    )
    assert denied.status_code in (403, 404)


async def test_a_new_wording_forgets_the_old_consent(client, monkeypatch):
    headers, org_id = await _org(client, "reworded")
    await _give(client, headers, org_id)
    monkeypatch.setitem(svc.TEXT_VERSIONS, "third_party_ai", "2099-01-01")
    body = await _mine(client, headers, org_id)
    assert body["consent_id"] is None and body["text_version"] == "2099-01-01"
    # ...and says it was agreed before, so the dashboard can explain why.
    assert body["stale"] is True


async def test_stale_is_false_for_never_agreed_and_for_agreed_now(client, monkeypatch):
    headers, org_id = await _org(client, "stale1")
    assert (await _mine(client, headers, org_id))["stale"] is False
    await _give(client, headers, org_id)
    assert (await _mine(client, headers, org_id))["stale"] is False
    # Agreeing again under the new wording clears it.
    monkeypatch.setitem(svc.TEXT_VERSIONS, "third_party_ai", "2099-01-01")
    assert (await _mine(client, headers, org_id))["stale"] is True
    await _give(client, headers, org_id, version="2099-01-01")
    after = await _mine(client, headers, org_id)
    assert after["stale"] is False and after["consent_id"] is not None


async def test_stale_is_this_members_in_this_org(client, monkeypatch):
    headers, org_id = await _org(client, "stale2")
    await _give(client, headers, org_id)
    monkeypatch.setitem(svc.TEXT_VERSIONS, "third_party_ai", "2099-01-01")
    other_headers, other_org = await _org(client, "stale3")
    assert (await _mine(client, other_headers, other_org))["stale"] is False
    second_org = await create_org(client, headers)
    assert (await _mine(client, headers, second_org))["stale"] is False
    assert (await _mine(client, headers, org_id))["stale"] is True


async def test_a_remembered_consent_is_one_require_accepts(client):
    """What /mine returns passes the gate every AI step applies."""
    from app.models import Organization

    headers, org_id = await _org(client, "gatekept")
    await _give(client, headers, org_id)
    remembered = (await _mine(client, headers, org_id))["consent_id"]
    async with get_session_factory()() as db:
        org = await db.get(Organization, org_id)
        user_id = (await _row(remembered)).user_id
        agreed = await svc.require(db, remembered, org, user_id, svc.THIRD_PARTY_AI, "google")
    assert agreed.id == remembered


async def test_an_unknown_scope_is_refused(client):
    headers, org_id = await _org(client, "scoper")
    response = await client.get(
        f"/orgs/{org_id}/consents/mine", params={"scope": "anything"}, headers=headers
    )
    assert response.status_code == 422


# --- statements about a face ---------------------------------------------------------


async def test_a_statement_about_a_face_counts_for_its_creation_only(client):
    """ "I am this person or have their permission" is about one face: a
    statement made for one creation cannot stand behind another."""
    from app.core.errors import Forbidden403
    from app.models import Organization

    headers, org_id = await _org(client, "once")
    first, second = await _creation(org_id), await _creation(org_id)
    made = await _statement(client, headers, org_id, creation_id=first)
    assert made.status_code == 201, made.text
    assert made.json()["creation_id"] == first
    statement = made.json()["id"]
    assert (await _row(statement)).subject_id == first
    async with get_session_factory()() as db:
        org = await db.get(Organization, org_id)
        user_id = (await _row(statement)).user_id
        agreed = await svc.require(db, statement, org, user_id, svc.DEPICTION, subject_id=first)
        assert agreed.id == statement
        for subject in (second, None):
            with pytest.raises(Forbidden403) as caught:
                await svc.require(db, statement, org, user_id, svc.DEPICTION, subject_id=subject)
            assert caught.value.extra["scope"] == "depiction"
        # Nor as the other statement about a face.
        with pytest.raises(Forbidden403):
            await svc.require(db, statement, org, user_id, svc.GENERATED_FACE, subject_id=first)


async def test_a_statement_names_a_creation_of_this_org(client):
    headers, org_id = await _org(client, "ours")
    other_headers, other_org = await _org(client, "theirs")
    elsewhere = await _creation(other_org)
    response = await _statement(client, headers, org_id, creation_id=elsewhere)
    assert response.status_code == 404
    assert response.json()["code"] == "creation_not_found"
    async with get_session_factory()() as db:
        assert (await db.execute(select(Consent))).scalars().all() == []
    assert other_headers


async def test_a_third_party_ai_consent_is_about_no_creation(client):
    headers, org_id = await _org(client, "anyphoto")
    response = await _give(client, headers, org_id, creation_id=await _creation(org_id))
    assert response.status_code == 201
    assert response.json()["creation_id"] is None
    assert (await _row(response.json()["id"])).subject_id is None
