"""Sign-in hardening: password hashing off the loop, no username timing
oracle, and rate limits on every route that hashes a password or sends mail."""

import threading

import pytest

from app.api import auth
from app.core import security
from app.services.rate_limit import Limit
from tests.conftest import register_and_login


@pytest.fixture
def hashing_threads(monkeypatch):
    """Which threads ran bcrypt, and against which hashes."""
    seen: list[tuple[str, str | None]] = []
    real_hash, real_verify = security.hash_password, security.verify_password

    def spy_hash(plain):
        seen.append((threading.current_thread().name, None))
        return real_hash(plain)

    def spy_verify(plain, hashed):
        seen.append((threading.current_thread().name, hashed))
        return real_verify(plain, hashed)

    monkeypatch.setattr(security, "hash_password", spy_hash)
    monkeypatch.setattr(security, "verify_password", spy_verify)
    return seen


async def test_bcrypt_never_runs_on_the_event_loop(client, hashing_threads):
    await register_and_login(client, "offloop")
    assert len(hashing_threads) == 2  # register hashes, login verifies
    loop_thread = threading.main_thread().name
    assert all(name != loop_thread for name, _ in hashing_threads), hashing_threads
    assert all(name.startswith("liveface-bcrypt") for name, _ in hashing_threads)


async def test_an_unknown_user_costs_a_password_check_too(client, hashing_threads):
    """Skipping bcrypt for a name that does not exist answers ~0.25 s faster,
    which tells a prober which usernames are real."""
    response = await client.post(
        "/auth/login", json={"username_or_email": "nobody-here", "password": "whatever1"}
    )
    assert response.status_code == 401
    assert response.json()["code"] == "invalid_credentials"
    assert [hashed for _, hashed in hashing_threads] == [security.DUMMY_HASH]


async def test_the_dummy_hash_never_signs_anyone_in():
    assert await security.verify_password_async("anything", None) is False


async def test_the_dummy_hash_costs_what_a_real_one_does():
    real = security.hash_password("password123")
    assert real[:7] == security.DUMMY_HASH[:7]  # same scheme, same cost


async def test_login_is_limited_per_account(client):
    await register_and_login(client, "target")  # one login used
    body = {"username_or_email": "target", "password": "wrong-password"}
    statuses = [(await client.post("/auth/login", json=body)).status_code for _ in range(9)]
    assert statuses == [401] * 9
    # The eleventh attempt in ten minutes is refused, right password or not.
    refused = await client.post(
        "/auth/login", json={"username_or_email": "TARGET ", "password": "password123"}
    )
    assert refused.status_code == 429
    assert refused.json()["code"] == "rate_limited"
    assert int(refused.headers["retry-after"]) > 0


async def test_login_is_limited_per_client(client, monkeypatch):
    monkeypatch.setattr(auth, "LOGIN_PER_CLIENT", Limit("login-client-test", 3, 60))
    for name in ("a1", "a2", "a3"):
        response = await client.post(
            "/auth/login", json={"username_or_email": name, "password": "password123"}
        )
        assert response.status_code == 401
    refused = await client.post(
        "/auth/login", json={"username_or_email": "a4", "password": "password123"}
    )
    assert refused.status_code == 429
    assert 1 <= int(refused.headers["retry-after"]) <= 60


async def test_register_is_limited_per_client(client, monkeypatch):
    monkeypatch.setattr(auth, "REGISTER_PER_CLIENT", Limit("register-client-test", 2, 3600))
    for i in range(2):
        response = await client.post(
            "/auth/register",
            json={"email": f"r{i}@example.com", "username": f"reg{i}", "password": "password123"},
        )
        assert response.status_code == 201
    refused = await client.post(
        "/auth/register",
        json={"email": "r9@example.com", "username": "reg9", "password": "password123"},
    )
    assert refused.status_code == 429
    assert refused.json()["code"] == "rate_limited"
    assert "retry-after" in refused.headers


async def test_forgot_password_is_limited_per_client(client, monkeypatch):
    monkeypatch.setattr(auth, "FORGOT_PER_CLIENT", Limit("forgot-client-test", 2, 3600))
    for i in range(2):
        response = await client.post("/auth/forgot-password", json={"email": f"f{i}@example.com"})
        assert response.status_code == 202
    refused = await client.post("/auth/forgot-password", json={"email": "f9@example.com"})
    assert refused.status_code == 429
    assert "retry-after" in refused.headers


async def test_reset_password_is_limited_per_client(client, monkeypatch):
    monkeypatch.setattr(auth, "RESET_PER_CLIENT", Limit("reset-client-test", 2, 900))
    body = {"token": "not-a-token", "password": "a-new-password"}
    assert [
        (await client.post("/auth/reset-password", json=body)).status_code for _ in range(2)
    ] == [
        401,
        401,
    ]
    refused = await client.post("/auth/reset-password", json=body)
    assert refused.status_code == 429
    assert "retry-after" in refused.headers
