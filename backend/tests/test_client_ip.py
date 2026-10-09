"""core.client_ip: the client's address, never a header a stranger picked.

Production is Cloudflare -> Caddy (docker network) -> the API. Every
per-client rate limit and the consent record's address hash are keyed on
what this module returns, so a header is believed only from a hop that is
trusted to have written it.
"""

import ipaddress
import re

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select

from app.api import auth, embed, share
from app.core import client_ip
from app.core.client_ip import ProxyPolicy, parse_address, resolve
from app.core.cloudflare_ranges import CLOUDFLARE_RANGES
from app.core.config import get_settings
from app.db import get_session_factory
from app.models import Consent
from app.services.consent import TEXT_VERSIONS, THIRD_PARTY_AI, ip_hash
from app.services.rate_limit import Limit
from scripts.refresh_cloudflare_ranges import MODULE, render
from tests.conftest import create_org, create_ready_avatar, register_and_login

CADDY = "172.18.0.3"  # the proxy's container on the docker network
EDGE = "162.158.10.20"  # a Cloudflare edge (162.158.0.0/15)
VISITOR = "203.0.113.9"
OTHER_VISITOR = "198.51.100.44"
ATTACKER = "192.0.2.66"  # reaches the origin directly, without Cloudflare

PRODUCTION = ProxyPolicy(
    proxies=(
        ipaddress.ip_network("172.16.0.0/12"),
        ipaddress.ip_network("10.0.0.0/8"),
        ipaddress.ip_network("192.168.0.0/16"),
    ),
    hops=1,
    cloudflare=tuple(ipaddress.ip_network(cidr) for cidr in CLOUDFLARE_RANGES),
)


# --- resolve(): the walk -----------------------------------------------------


def test_through_cloudflare_and_caddy_the_visitor_is_cf_connecting_ip():
    assert resolve(CADDY, EDGE, VISITOR, PRODUCTION) == VISITOR


def test_straight_from_cloudflare_the_visitor_is_cf_connecting_ip():
    assert resolve(EDGE, None, VISITOR, PRODUCTION) == VISITOR


def test_a_forged_cf_header_through_caddy_but_not_cloudflare_is_ignored():
    """Someone who finds the origin and talks to Caddy directly: Caddy writes
    their real address, which is not Cloudflare's, so their header is junk."""
    assert resolve(CADDY, ATTACKER, VISITOR, PRODUCTION) == ATTACKER


def test_headers_from_a_peer_that_is_no_proxy_are_never_read():
    assert resolve(ATTACKER, f"{VISITOR}, {EDGE}", VISITOR, PRODUCTION) == ATTACKER


def test_entries_a_client_put_left_of_the_proxys_own_are_not_believed():
    # Caddy (one hop) vouches for the rightmost entry only.
    assert resolve(CADDY, f"{VISITOR}, {ATTACKER}", None, PRODUCTION) == ATTACKER
    assert resolve(CADDY, f"{EDGE}, {ATTACKER}", OTHER_VISITOR, PRODUCTION) == ATTACKER


def test_a_client_cannot_climb_the_chain_by_naming_a_proxy_address():
    """An attacker writing a docker address into the header, hoping each
    'proxy' vouches for the next entry: the hop budget is one."""
    assert resolve(CADDY, f"{VISITOR}, 172.18.0.9, {ATTACKER}", None, PRODUCTION) == ATTACKER


def test_more_hops_walk_further_through_trusted_proxies_only():
    two = ProxyPolicy(proxies=PRODUCTION.proxies, hops=2)
    assert resolve(CADDY, f"{VISITOR}, 10.0.0.5", None, two) == VISITOR
    # The second-to-last entry is believed only because 10.0.0.5 is a proxy.
    assert resolve(CADDY, f"{VISITOR}, {ATTACKER}", None, two) == ATTACKER


def test_without_cloudflare_trust_the_edge_is_the_client():
    caddy_only = ProxyPolicy(proxies=PRODUCTION.proxies, hops=1)
    assert resolve(CADDY, EDGE, VISITOR, caddy_only) == EDGE


def test_with_nothing_configured_the_peer_is_the_client():
    assert resolve(VISITOR, ATTACKER, ATTACKER, ProxyPolicy()) == VISITOR


def test_malformed_headers_never_produce_an_address():
    assert resolve(EDGE, None, "not-an-address", PRODUCTION) == EDGE
    assert resolve(CADDY, "garbage", VISITOR, PRODUCTION) == CADDY
    assert resolve(CADDY, "", VISITOR, PRODUCTION) == CADDY


def test_peers_that_are_not_addresses_pass_through():
    assert resolve("testclient", EDGE, VISITOR, PRODUCTION) == "testclient"
    assert resolve(None, EDGE, VISITOR, PRODUCTION) == "unknown"


@pytest.mark.parametrize(
    ("raw", "parsed"),
    [
        ("203.0.113.9", "203.0.113.9"),
        (" 203.0.113.9 ", "203.0.113.9"),
        ("203.0.113.9:4711", "203.0.113.9"),
        ("2001:db8::1", "2001:db8::1"),
        ("[2001:db8::1]", "2001:db8::1"),
        ("[2001:db8::1]:443", "2001:db8::1"),
        ("::ffff:203.0.113.9", "203.0.113.9"),
        ("unknown", None),
        ("", None),
        ("[2001:db8::1", None),
    ],
)
def test_addresses_are_normalised(raw, parsed):
    address = parse_address(raw)
    assert (str(address) if address else None) == parsed


def test_ipv6_cloudflare_edges_are_trusted_too():
    assert resolve(CADDY, "2606:4700::1", "2001:db8::7", PRODUCTION) == "2001:db8::7"


def test_the_pinned_cloudflare_list_is_well_formed():
    networks = [ipaddress.ip_network(cidr, strict=True) for cidr in CLOUDFLARE_RANGES]
    assert any(n.version == 4 for n in networks) and any(n.version == 6 for n in networks)
    assert ipaddress.ip_address(EDGE) in ipaddress.ip_network("162.158.0.0/15")
    # Nothing private: a docker address must never pass for Cloudflare.
    assert not any(n.is_private for n in networks)


def test_the_pinned_module_is_what_the_refresh_script_writes():
    """Generated, never hand-edited: a range added by hand would bypass the
    validation the script does."""
    text = MODULE.read_text(encoding="utf-8")
    fetched = re.search(r"fetched (\d{4}-\d{2}-\d{2})", text)
    assert fetched is not None
    assert render(list(CLOUDFLARE_RANGES), fetched.group(1)) == text


# --- Wired into the app: settings, and the limits that use it ----------------


@pytest.fixture
def production_proxies(monkeypatch):
    """The settings production uses (deploy/docker-compose.prod.yml)."""
    monkeypatch.setenv("TRUSTED_PROXIES", "172.16.0.0/12,10.0.0.0/8,192.168.0.0/16")
    monkeypatch.setenv("TRUSTED_PROXY_HOPS", "1")
    monkeypatch.setenv("TRUST_CLOUDFLARE", "true")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def test_the_settings_build_the_production_policy(production_proxies):
    policy = client_ip.current_policy()
    assert policy.hops == 1
    assert policy.proxies == PRODUCTION.proxies
    assert policy.cloudflare == PRODUCTION.cloudflare


def test_a_bad_trusted_proxy_fails_at_startup(monkeypatch):
    monkeypatch.setenv("TRUSTED_PROXIES", "172.16.0.0/12,not-a-network")
    get_settings.cache_clear()
    try:
        with pytest.raises(ValueError, match="not-a-network"):
            get_settings()
    finally:
        monkeypatch.delenv("TRUSTED_PROXIES")
        get_settings.cache_clear()


def _behind(app, peer: str) -> AsyncClient:
    return AsyncClient(
        transport=ASGITransport(app=app, client=(peer, 40000)), base_url="http://testserver"
    )


def _via_cloudflare(visitor: str) -> dict[str, str]:
    return {"X-Forwarded-For": EDGE, "CF-Connecting-IP": visitor}


async def test_login_limit_is_per_visitor_behind_cloudflare(app, production_proxies, monkeypatch):
    """Before, every visitor behind one edge shared one bucket: one script
    locked everyone out. Now the script spends its own."""
    monkeypatch.setattr(auth, "LOGIN_PER_CLIENT", Limit("login-client-ip-test", 2, 60))
    body = {"username_or_email": "nobody", "password": "password123"}
    async with _behind(app, CADDY) as client:
        for _ in range(2):
            answer = await client.post("/auth/login", json=body, headers=_via_cloudflare(VISITOR))
            assert answer.status_code == 401
        refused = await client.post("/auth/login", json=body, headers=_via_cloudflare(VISITOR))
        assert refused.status_code == 429
        # Another visitor through the same edge still gets in.
        other = await client.post("/auth/login", json=body, headers=_via_cloudflare(OTHER_VISITOR))
        assert other.status_code == 401


async def test_forged_headers_cannot_dodge_the_limit(app, production_proxies, monkeypatch):
    """A client talking to the origin directly, sending a fresh
    CF-Connecting-IP and X-Forwarded-For each time: one bucket regardless."""
    monkeypatch.setattr(auth, "REGISTER_PER_CLIENT", Limit("register-client-ip-test", 2, 3600))
    async with _behind(app, ATTACKER) as client:
        statuses = []
        for i in range(3):
            forged = {"CF-Connecting-IP": f"203.0.113.{i}", "X-Forwarded-For": f"198.51.100.{i}"}
            answer = await client.post(
                "/auth/register",
                json={
                    "email": f"x{i}@example.com",
                    "username": f"forger{i}",
                    "password": "password123",
                },
                headers=forged,
            )
            statuses.append(answer.status_code)
    assert statuses == [201, 201, 429]


async def test_forged_cf_header_through_caddy_without_cloudflare(
    app, production_proxies, monkeypatch
):
    monkeypatch.setattr(embed, "CUES_PER_CLIENT", Limit("cues-client-ip-test", 2, 60))
    async with _behind(app, CADDY) as client:
        statuses = [
            (
                await client.post(
                    "/embed/v1/cues",
                    json={"text": "hello"},
                    headers={"X-Forwarded-For": ATTACKER, "CF-Connecting-IP": f"203.0.113.{i}"},
                )
            ).status_code
            for i in range(3)
        ]
    assert statuses == [200, 200, 429]


async def test_share_limit_is_per_visitor_behind_cloudflare(
    app, client, production_proxies, monkeypatch
):
    monkeypatch.setattr(share, "SHARE_PER_CLIENT", Limit("share-client-ip-test", 1, 60))
    headers = await register_and_login(client, "sharer")
    org_id = await create_org(client, headers)
    avatar_id = await create_ready_avatar(client, headers, org_id)
    shared = await client.post(f"/orgs/{org_id}/avatars/{avatar_id}/share", headers=headers)
    assert shared.status_code == 200, shared.text
    token = shared.json()["share_token"]
    speak = {"text": "Hi", "provider": "offline", "voice": "offline-warm"}
    async with _behind(app, CADDY) as visitor:
        url = f"/public/v1/avatars/{token}/speak"
        assert (
            await visitor.post(url, json=speak, headers=_via_cloudflare(VISITOR))
        ).status_code == 200
        assert (
            await visitor.post(url, json=speak, headers=_via_cloudflare(VISITOR))
        ).status_code == 429
        other = await visitor.post(url, json=speak, headers=_via_cloudflare(OTHER_VISITOR))
        assert other.status_code == 200


async def test_the_consent_record_hashes_the_visitors_address(app, production_proxies):
    async with _behind(app, CADDY) as client:
        headers = await register_and_login(client, "consenter")
        org_id = await create_org(client, headers)
        given = await client.post(
            f"/orgs/{org_id}/consents",
            json={"scope": THIRD_PARTY_AI, "text_version": TEXT_VERSIONS[THIRD_PARTY_AI]},
            headers={**headers, **_via_cloudflare(VISITOR)},
        )
        assert given.status_code == 201, given.text
    async with get_session_factory()() as db:
        stored = (await db.execute(select(Consent))).scalar_one()
    assert stored.ip_hash == ip_hash(VISITOR)
