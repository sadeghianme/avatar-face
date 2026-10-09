"""Dashboard sessions: rotated refresh tokens in an httpOnly cookie, and
every way a session ends (services.sessions, api.auth)."""

from __future__ import annotations

import asyncio
import os
import sqlite3
import subprocess
import sys
import warnings
from contextlib import closing
from datetime import timedelta
from pathlib import Path

import jwt
import pytest
from httpx import AsyncClient
from jwt.warnings import InsecureKeyLengthWarning
from sqlalchemy import select, update

from app.core.config import Settings, get_settings
from app.core.security import _access_key, create_access_token
from app.db import get_session_factory
from app.models import RefreshToken, utcnow
from app.services import email, sessions
from app.services.sessions import hash_token

PASSWORD = "password123"
BACKEND = Path(__file__).resolve().parents[1]


@pytest.fixture(autouse=True)
def _settings(monkeypatch):
    """No grace for a reused token unless a test asks for it, so reuse is
    detected at once; and the cookie's path is where this client calls the
    API (at its root, not behind /api as the dashboard does)."""
    settings = get_settings()
    monkeypatch.setattr(settings, "refresh_reuse_grace_seconds", 0)
    monkeypatch.setattr(settings, "session_cookie_path", "/auth")
    return settings


def set_cookies(response) -> dict[str, dict[str, str | bool]]:
    """The cookies a response sets, each with its attributes (lower-cased)."""
    found: dict[str, dict[str, str | bool]] = {}
    for header in response.headers.get_list("set-cookie"):
        name_value, *attributes = (part.strip() for part in header.split(";"))
        name, _, value = name_value.partition("=")
        cookie: dict[str, str | bool] = {"value": value}
        for attribute in attributes:
            key, sep, val = attribute.partition("=")
            cookie[key.lower()] = val if sep else True
        found[name] = cookie
    return found


def refresh_token_of(response) -> str:
    value = set_cookies(response)["lf_refresh"]["value"]
    assert isinstance(value, str) and value.startswith("lfs_"), value
    return value


async def login(client: AsyncClient, username: str = "alice", **headers) -> tuple[str, str]:
    """(access token, refresh token) of a new session of `username`."""
    client.cookies.clear()
    response = await client.post(
        "/auth/login", json={"username_or_email": username, "password": PASSWORD}, headers=headers
    )
    assert response.status_code == 200, response.text
    client.cookies.clear()
    return response.json()["access_token"], refresh_token_of(response)


async def register(client: AsyncClient, username: str = "alice") -> None:
    response = await client.post(
        "/auth/register",
        json={"email": f"{username}@example.com", "username": username, "password": PASSWORD},
    )
    assert response.status_code == 201, response.text


async def signed_up(client: AsyncClient, username: str = "alice") -> tuple[str, str]:
    await register(client, username)
    return await login(client, username)


async def refresh(client: AsyncClient, token: str | None, **headers):
    client.cookies.clear()
    if token is not None:
        headers["Cookie"] = f"lf_refresh={token}"
    response = await client.post("/auth/refresh", headers=headers)
    client.cookies.clear()
    return response


async def me(client: AsyncClient, access: str):
    return await client.get("/auth/me", headers={"Authorization": f"Bearer {access}"})


async def rows() -> list[RefreshToken]:
    async with get_session_factory()() as db:
        return list((await db.execute(select(RefreshToken))).scalars())


# --- signing in --------------------------------------------------------------


async def test_login_answers_an_access_token_and_sets_the_refresh_cookie(client):
    await register(client, "alice")
    client.cookies.clear()
    response = await client.post(
        "/auth/login", json={"username_or_email": "alice", "password": PASSWORD}
    )
    assert response.status_code == 200
    body = response.json()
    # The refresh token is never in a body a script can read.
    assert set(body) == {"access_token", "token_type", "expires_in"}
    assert body["token_type"] == "bearer"
    assert body["expires_in"] == 15 * 60
    assert (await me(client, body["access_token"])).json()["username"] == "alice"

    cookies = set_cookies(response)
    refresh_cookie = cookies["lf_refresh"]
    assert refresh_cookie["httponly"] is True
    assert str(refresh_cookie["samesite"]).lower() == "strict"
    assert refresh_cookie["max-age"] == str(30 * 24 * 3600)
    hint = cookies["lf_session"]
    assert hint["value"] == "1"
    assert "httponly" not in hint, "the hint is for the dashboard's script to read"
    assert hint["path"] == "/"
    assert str(hint["samesite"]).lower() == "strict"


async def test_the_cookies_by_default(client, monkeypatch, _settings):
    """Path-scoped to the auth routes as the dashboard reaches them, and
    Secure exactly when the dashboard is served over https."""
    default_path = Settings.model_fields["session_cookie_path"].default
    assert default_path == "/api/auth"
    monkeypatch.setattr(_settings, "session_cookie_path", default_path)
    await register(client, "alice")

    client.cookies.clear()
    plain = await client.post(
        "/auth/login", json={"username_or_email": "alice", "password": PASSWORD}
    )
    assert set_cookies(plain)["lf_refresh"]["path"] == "/api/auth"
    assert "secure" not in set_cookies(plain)["lf_refresh"], "http dashboard (Vite on :5174)"

    monkeypatch.setattr(_settings, "app_base_url", "https://avatar.example")
    client.cookies.clear()
    https = await client.post(
        "/auth/login", json={"username_or_email": "alice", "password": PASSWORD}
    )
    assert set_cookies(https)["lf_refresh"]["secure"] is True
    assert set_cookies(https)["lf_session"]["secure"] is True

    monkeypatch.setattr(_settings, "session_cookie_secure", False)
    client.cookies.clear()
    forced = await client.post(
        "/auth/login", json={"username_or_email": "alice", "password": PASSWORD}
    )
    assert "secure" not in set_cookies(forced)["lf_refresh"]


async def test_only_a_hash_of_the_refresh_token_is_stored(client):
    _, token = await signed_up(client, "alice")
    [row] = await rows()
    assert row.token_hash == hash_token(token)
    assert token not in {row.token_hash, row.family_id, row.id}
    assert row.user_agent.startswith("python-httpx")
    assert row.ip_hash and len(row.ip_hash) == 64
    assert row.last_used_at is None and row.revoked_at is None


async def test_a_browser_keeps_its_session_through_the_cookie_alone(client):
    """The cookie jar does what a browser's does: no token is handed around."""
    await register(client, "alice")
    client.cookies.clear()
    await client.post("/auth/login", json={"username_or_email": "alice", "password": PASSWORD})
    first = await client.post("/auth/refresh")
    assert first.status_code == 200, first.text
    second = await client.post("/auth/refresh")
    assert second.status_code == 200, second.text
    assert (await me(client, second.json()["access_token"])).status_code == 200
    out = await client.post("/auth/logout")
    assert out.status_code == 204
    assert (await client.post("/auth/refresh")).json()["code"] == "no_session"


# --- refreshing --------------------------------------------------------------


async def test_a_refresh_exchanges_the_token_for_the_next_of_its_session(client):
    access, first = await signed_up(client, "alice")
    response = await refresh(client, first)
    assert response.status_code == 200, response.text
    second = refresh_token_of(response)
    assert second != first
    new_access = response.json()["access_token"]
    assert (await me(client, new_access)).status_code == 200
    # The session is the same: the older access token lives out its minutes.
    assert (await me(client, access)).status_code == 200
    assert set_cookies(response)["lf_session"]["value"] == "1"

    tokens = {row.token_hash: row for row in await rows()}
    assert tokens[hash_token(first)].last_used_at is not None
    assert tokens[hash_token(second)].last_used_at is None
    assert tokens[hash_token(first)].family_id == tokens[hash_token(second)].family_id


async def test_a_refresh_without_a_cookie_is_refused_and_clears_the_cookies(client):
    response = await refresh(client, None)
    assert response.status_code == 401
    assert response.json()["code"] == "no_session"
    cookies = set_cookies(response)
    assert cookies["lf_refresh"]["max-age"] == "0"
    assert cookies["lf_session"]["max-age"] == "0"


def _legacy_refresh_token() -> str:
    """A refresh token from before sessions: a stateless JWT, signed with
    the bare secret as python-jose signed them."""
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", InsecureKeyLengthWarning)  # "test-secret" is short
        return jwt.encode({"sub": "u", "type": "refresh"}, "test-secret", algorithm="HS256")


@pytest.mark.parametrize("token", ["garbage", "lfs_not-one-we-issued", "legacy"])
async def test_a_token_this_server_did_not_issue_is_refused(client, token):
    if token == "legacy":
        token = _legacy_refresh_token()
    response = await refresh(client, token)
    assert response.status_code == 401
    assert response.json()["code"] == "invalid_refresh_token"


async def test_an_access_token_is_no_refresh_token(client):
    access, _ = await signed_up(client, "alice")
    response = await refresh(client, access)
    assert response.json()["code"] == "invalid_refresh_token"


async def test_an_expired_refresh_token_is_refused(client):
    _, token = await signed_up(client, "alice")
    async with get_session_factory()() as db:
        await db.execute(update(RefreshToken).values(expires_at=utcnow() - timedelta(seconds=1)))
        await db.commit()
    response = await refresh(client, token)
    assert response.status_code == 401
    assert response.json()["code"] == "session_expired"


async def test_a_reused_refresh_token_revokes_its_whole_session(client):
    """A token exchanged once and presented again: two parties hold the
    session. Both are signed out, and the thief's newer token is worthless."""
    access, stolen = await signed_up(client, "alice")
    other_access, other_refresh = await login(client, "alice")  # another device

    legit = await refresh(client, stolen)  # the owner refreshes first
    current = refresh_token_of(legit)

    replay = await refresh(client, stolen)  # the copy is presented later
    assert replay.status_code == 401
    assert replay.json()["code"] == "refresh_token_reused"

    # Every token of that session is dead, the newest included...
    assert (await refresh(client, current)).json()["code"] == "session_revoked"
    assert (await me(client, access)).json()["code"] == "session_revoked"
    assert (await me(client, legit.json()["access_token"])).json()["code"] == "session_revoked"
    assert {row.revoked_reason for row in await rows() if row.revoked_at} == {"reuse"}
    # ...and the account's other session is untouched.
    assert (await me(client, other_access)).status_code == 200
    assert (await refresh(client, other_refresh)).status_code == 200


async def test_a_repeat_within_the_grace_gets_the_same_next_token(client, monkeypatch, _settings):
    """The answer to a refresh never arrived (a reload mid-request, a dropped
    connection), or two tabs sent the same cookie: within the grace the
    browser asking again gets the token it missed, not a refusal. Nothing
    forks: one live token per session, so a later reuse is still caught."""
    monkeypatch.setattr(_settings, "refresh_reuse_grace_seconds", 10)
    _, first = await signed_up(client, "alice")
    lost = await refresh(client, first)  # answered, but never stored
    again = await refresh(client, first)
    assert again.status_code == 200, again.text
    assert refresh_token_of(again) == refresh_token_of(lost)
    assert (await me(client, again.json()["access_token"])).status_code == 200
    assert len(await rows()) == 2, "the same next token, not a second one"

    # Once that next token is exchanged too, the old one is only a refusal,
    # and the cookie its sibling set stays.
    third = await refresh(client, refresh_token_of(again))
    assert third.status_code == 200
    late = await refresh(client, first)
    assert late.status_code == 401
    assert late.json()["code"] == "refresh_superseded"
    assert "lf_refresh" not in set_cookies(late)
    assert (await refresh(client, refresh_token_of(third))).status_code == 200


async def test_the_next_token_is_never_stored_either(client, monkeypatch, _settings):
    monkeypatch.setattr(_settings, "refresh_reuse_grace_seconds", 10)
    _, first = await signed_up(client, "alice")
    second = refresh_token_of(await refresh(client, first))
    stored = {row.token_hash for row in await rows()}
    assert stored == {hash_token(first), hash_token(second)}
    assert not {first, second} & stored


async def test_concurrent_refreshes_exchange_a_token_exactly_once(client, monkeypatch, _settings):
    monkeypatch.setattr(_settings, "refresh_reuse_grace_seconds", 10)
    _, first = await signed_up(client, "alice")
    answers = await asyncio.gather(*(refresh(client, first) for _ in range(4)))
    assert [answer.status_code for answer in answers] == [200] * 4, [a.text for a in answers]
    assert len({refresh_token_of(answer) for answer in answers}) == 1
    assert len(await rows()) == 2
    assert not any(row.revoked_at for row in await rows())


# --- signing out -------------------------------------------------------------


async def test_logout_ends_this_session_and_no_other(client):
    access, token = await signed_up(client, "alice")
    other_access, other_refresh = await login(client, "alice")

    response = await client.post(
        "/auth/logout",
        headers={"Cookie": f"lf_refresh={token}", "Authorization": f"Bearer {access}"},
    )
    assert response.status_code == 204
    cookies = set_cookies(response)
    assert cookies["lf_refresh"]["max-age"] == "0" and cookies["lf_session"]["max-age"] == "0"

    assert (await me(client, access)).json()["code"] == "session_revoked"
    assert (await refresh(client, token)).json()["code"] == "session_revoked"
    assert (await me(client, other_access)).status_code == 200
    assert (await refresh(client, other_refresh)).status_code == 200


async def test_logout_with_only_the_bearer_token_ends_its_session(client):
    access, token = await signed_up(client, "alice")
    client.cookies.clear()
    response = await client.post("/auth/logout", headers={"Authorization": f"Bearer {access}"})
    assert response.status_code == 204
    assert (await refresh(client, token)).json()["code"] == "session_revoked"


async def test_logout_signed_out_is_harmless(client):
    client.cookies.clear()
    assert (await client.post("/auth/logout")).status_code == 204
    response = await client.post(
        "/auth/logout", headers={"Cookie": "lf_refresh=nonsense", "Authorization": "Bearer x"}
    )
    assert response.status_code == 204


async def test_logout_everywhere_ends_every_session_of_the_account(client):
    first_access, first_refresh = await signed_up(client, "alice")
    second_access, second_refresh = await login(client, "alice")
    bob_access, bob_refresh = await signed_up(client, "bob")

    response = await client.post(
        "/auth/logout-all", headers={"Authorization": f"Bearer {first_access}"}
    )
    assert response.status_code == 204
    assert set_cookies(response)["lf_refresh"]["max-age"] == "0"

    for access, token in ((first_access, first_refresh), (second_access, second_refresh)):
        assert (await me(client, access)).json()["code"] == "session_revoked"
        assert (await refresh(client, token)).json()["code"] == "session_revoked"
    assert (await me(client, bob_access)).status_code == 200
    assert (await refresh(client, bob_refresh)).status_code == 200
    reasons = {row.revoked_reason for row in await rows() if row.revoked_at}
    assert reasons == {"logout_all"}


async def test_logout_everywhere_needs_the_bearer_token_not_the_cookie(client):
    """The cookie is sent by the browser on its own: it must not be enough."""
    _, token = await signed_up(client, "alice")
    client.cookies.clear()
    response = await client.post("/auth/logout-all", headers={"Cookie": f"lf_refresh={token}"})
    assert response.status_code == 401
    assert (await refresh(client, token)).status_code == 200


async def test_a_new_password_ends_every_session(client, monkeypatch):
    sent: list[dict] = []

    async def fake_send(to, subject, html, text):
        sent.append({"text": text})
        return True

    monkeypatch.setattr("app.services.accounts.send_email", fake_send)
    phone_access, phone_refresh = await signed_up(client, "alice")
    laptop_access, laptop_refresh = await login(client, "alice")

    await client.post("/auth/forgot-password", json={"email": "alice@example.com"})
    await email.drain()
    token = next(w for w in sent[0]["text"].split() if "token=" in w).split("token=")[1]
    client.cookies.clear()
    done = await client.post(
        "/auth/reset-password", json={"token": token, "password": "a-new-password"}
    )
    assert done.status_code == 200, done.text

    for access, refresh_token in ((phone_access, phone_refresh), (laptop_access, laptop_refresh)):
        assert (await me(client, access)).json()["code"] == "session_revoked"
        assert (await refresh(client, refresh_token)).json()["code"] == "session_revoked"
    # The browser that reset it is signed in to a new session.
    assert (await me(client, done.json()["access_token"])).status_code == 200
    assert (await refresh(client, refresh_token_of(done))).status_code == 200
    reasons = {row.revoked_reason for row in await rows() if row.revoked_at}
    assert reasons == {"password_reset"}


# --- access tokens -----------------------------------------------------------


async def test_an_access_token_without_a_session_is_refused(client):
    """Tokens from before sessions carry no `sid`: everyone signs in once."""
    access, _ = await signed_up(client, "alice")
    user_id = (await me(client, access)).json()["id"]
    now = utcnow()
    legacy = jwt.encode(
        {"sub": user_id, "type": "access", "iat": now, "exp": now + timedelta(minutes=5)},
        _access_key("test-secret"),
        algorithm="HS256",
    )
    assert (await me(client, legacy)).json()["code"] == "invalid_token"


async def test_an_access_token_for_a_session_that_does_not_exist_is_refused(client):
    access, _ = await signed_up(client, "alice")
    user_id = (await me(client, access)).json()["id"]
    forged_sid = create_access_token(user_id, "0" * 32)
    assert (await me(client, forged_sid)).json()["code"] == "session_revoked"


async def test_an_access_token_signed_with_the_bare_secret_is_refused(client):
    access, _ = await signed_up(client, "alice")
    claims = jwt.decode(access, _access_key("test-secret"), algorithms=["HS256"])
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", InsecureKeyLengthWarning)
        resigned = jwt.encode(claims, "test-secret", algorithm="HS256")
    assert (await me(client, resigned)).json()["code"] == "invalid_token"


async def test_an_access_token_for_another_users_session_is_refused(client):
    alice_access, _ = await signed_up(client, "alice")
    bob_access, _ = await signed_up(client, "bob")
    bob_sid = jwt.decode(bob_access, _access_key("test-secret"), algorithms=["HS256"])["sid"]
    alice_id = (await me(client, alice_access)).json()["id"]
    assert (await me(client, create_access_token(alice_id, bob_sid))).status_code == 401


# --- cross-site requests -----------------------------------------------------


CROSS_SITE = [
    {"Sec-Fetch-Site": "cross-site"},
    # A sibling subdomain is "same site", and SameSite lets the cookie go.
    {"Sec-Fetch-Site": "same-site"},
    {"Sec-Fetch-Site": "none"},
    # An older browser without Fetch Metadata: its Origin says who asked.
    {"Origin": "https://evil.example"},
    {"Origin": "null"},
]


@pytest.mark.parametrize("headers", CROSS_SITE)
async def test_the_cookie_routes_refuse_another_sites_page(client, headers):
    access, token = await signed_up(client, "alice")
    client.cookies.clear()
    cookie = {"Cookie": f"lf_refresh={token}"}
    refreshed = await client.post("/auth/refresh", headers={**cookie, **headers})
    assert refreshed.status_code == 403
    assert refreshed.json()["code"] == "cross_site_request"
    out = await client.post("/auth/logout", headers={**cookie, **headers})
    assert out.status_code == 403
    # Login CSRF (signing a victim into the attacker's account) too.
    signed = await client.post(
        "/auth/login", json={"username_or_email": "alice", "password": PASSWORD}, headers=headers
    )
    assert signed.status_code == 403
    reset = await client.post(
        "/auth/reset-password", json={"token": "lfr_x.y", "password": "whatever-1"}, headers=headers
    )
    assert reset.status_code == 403
    # Nothing was exchanged or ended.
    assert (await refresh(client, token)).status_code == 200
    assert (await me(client, access)).status_code == 200


@pytest.mark.parametrize(
    "headers",
    [
        {"Sec-Fetch-Site": "same-origin"},
        {"Sec-Fetch-Site": "same-origin", "Origin": "http://localhost:5174"},
        {"Origin": "http://localhost:5174"},  # the dashboard (CORS_ORIGINS)
        {},  # no browser at all: curl, a script, the smoke test
    ],
)
async def test_the_dashboards_own_requests_pass(client, headers):
    _, token = await signed_up(client, "alice")
    response = await refresh(client, token, **headers)
    assert response.status_code == 200, response.text


async def test_the_dashboard_origin_from_app_base_url_passes(client, monkeypatch, _settings):
    monkeypatch.setattr(_settings, "app_base_url", "https://avatar.example/")
    _, token = await signed_up(client, "alice")
    assert (await refresh(client, token, Origin="https://avatar.example")).status_code == 200


# --- housekeeping ------------------------------------------------------------


async def test_expired_tokens_are_purged_and_live_ones_kept(client):
    _, expired = await signed_up(client, "alice")
    _, live = await login(client, "alice")
    async with get_session_factory()() as db:
        await db.execute(
            update(RefreshToken)
            .where(RefreshToken.token_hash == hash_token(expired))
            .values(expires_at=utcnow() - timedelta(days=1))
        )
        await db.commit()
    assert await sessions.purge_expired() == 1
    assert [row.token_hash for row in await rows()] == [hash_token(live)]


# --- migration 029 -----------------------------------------------------------

_ALEMBIC = """
from alembic import command
from alembic.config import Config
command.{action}(Config("alembic.ini"), "{target}")
"""


def _alembic(database: Path, action: str, target: str) -> None:
    env = {**os.environ, "DATABASE_URL": f"sqlite+aiosqlite:///{database}"}
    result = subprocess.run(
        [sys.executable, "-c", _ALEMBIC.format(action=action, target=target)],
        cwd=BACKEND,
        env=env,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr[-3000:]


def _tables(database: Path) -> set[str]:
    with closing(sqlite3.connect(database)) as db:
        return {r[0] for r in db.execute("select name from sqlite_master where type='table'")}


def test_029_creates_the_table_and_a_rerun_after_a_rollback_trusts_nothing(tmp_path):
    database = tmp_path / "sessions.sqlite3"
    _alembic(database, "upgrade", "028_speech_clips")
    assert "refresh_tokens" not in _tables(database)
    _alembic(database, "upgrade", "head")
    assert "refresh_tokens" in _tables(database)
    with closing(sqlite3.connect(database)) as db:
        db.execute(
            "insert into users (id, created_at, updated_at, email, username, password_hash, "
            "display_name) values ('u1', '2026-10-09', '2026-10-09', 'a@example.com', 'a', "
            "'$2b$12$x', '')"
        )
        db.execute(
            "insert into refresh_tokens (id, created_at, updated_at, user_id, family_id, "
            "token_hash, expires_at, user_agent) values ('t1', '2026-10-09', '2026-10-09', "
            "'u1', 'f1', 'h1', '2026-11-08', '')"
        )
        db.commit()

    # A rollback stamps 028 (docs/process.md, "Rollback"); the release before
    # revokes nothing here, so the next deploy keeps no session from before.
    _alembic(database, "stamp", "028_speech_clips")
    _alembic(database, "upgrade", "head")
    with closing(sqlite3.connect(database)) as db:
        assert db.execute("select count(*) from refresh_tokens").fetchone() == (0,)

    _alembic(database, "downgrade", "028_speech_clips")
    assert "refresh_tokens" not in _tables(database)
    _alembic(database, "upgrade", "head")
    assert "refresh_tokens" in _tables(database)
