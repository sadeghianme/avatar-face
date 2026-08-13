"""Password reset: single-use links, and an endpoint that reveals nothing."""

import time

import pytest

from app.services.reset_token import (
    InvalidResetToken,
    fingerprint,
    mint,
    verify,
)
from tests.conftest import register_and_login

SECRET = "test-secret"
HASH = "$2b$12$abcdefghijklmnopqrstuv"


# No limiter fixture: the throttle now counts rows in the database, and every
# test already gets its own database.


@pytest.fixture(autouse=True)
def _capture_mail(monkeypatch):
    """Never send real mail from a test, and keep the links for assertions."""
    sent: list[dict] = []

    async def fake_send(to, subject, html, text):
        sent.append({"to": to, "subject": subject, "html": html, "text": text})
        return True

    monkeypatch.setattr("app.api.auth.send_email", fake_send)
    return sent


def _link_from(mail: dict) -> str:
    for word in mail["text"].split():
        if "token=" in word:
            return word
    raise AssertionError("no reset link in the email")


# --- the token itself --------------------------------------------------------


def test_a_token_verifies_and_carries_its_user():
    token, expires_at = mint(SECRET, "user1", HASH)
    assert expires_at > time.time()
    user_id, print_ = verify(SECRET, token)
    assert user_id == "user1"
    assert print_ == fingerprint(HASH)


def test_the_fingerprint_changes_with_the_password_hash():
    """This is the whole single-use mechanism: reset, and the link dies."""
    assert fingerprint(HASH) != fingerprint(HASH + "x")


def test_a_token_signed_with_another_secret_is_rejected():
    token, _ = mint("not-our-secret", "user1", HASH)
    with pytest.raises(InvalidResetToken):
        verify(SECRET, token)


def test_the_user_id_cannot_be_edited():
    import base64

    token, _ = mint(SECRET, "user1", HASH)
    encoded, signature = token.removeprefix("lfr_").split(".", 1)
    payload = base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)).decode()
    forged_payload = payload.replace("user1", "user2")
    forged = (
        "lfr_"
        + base64.urlsafe_b64encode(forged_payload.encode()).decode().rstrip("=")
        + "."
        + signature
    )
    with pytest.raises(InvalidResetToken):
        verify(SECRET, forged)


def test_an_expired_token_is_rejected():
    token, _ = mint(SECRET, "user1", HASH, ttl_seconds=-1)
    with pytest.raises(InvalidResetToken):
        verify(SECRET, token)


def test_garbage_is_rejected_rather_than_crashing():
    for bad in ("", "lfr_", "lfr_zzz.sig", "lfsim_something", "nonsense"):
        with pytest.raises(InvalidResetToken):
            verify(SECRET, bad)


# --- through the API ---------------------------------------------------------


async def test_the_full_reset_flow(client, _capture_mail):
    await register_and_login(client, "resetme", email="resetme@example.com")

    started = await client.post("/auth/forgot-password", json={"email": "resetme@example.com"})
    assert started.status_code == 202
    assert len(_capture_mail) == 1

    token = _link_from(_capture_mail[0]).split("token=")[1]
    done = await client.post(
        "/auth/reset-password", json={"token": token, "password": "a-new-password"}
    )
    assert done.status_code == 200, done.text
    # Signed in immediately: bouncing someone back to a login form to retype
    # the password they just chose is pure friction.
    assert done.json()["access_token"]

    old = await client.post(
        "/auth/login", json={"username_or_email": "resetme", "password": "password123"}
    )
    assert old.status_code == 401, "the old password must stop working"

    new = await client.post(
        "/auth/login", json={"username_or_email": "resetme", "password": "a-new-password"}
    )
    assert new.status_code == 200


async def test_a_link_only_works_once(client, _capture_mail):
    await register_and_login(client, "onceonly", email="onceonly@example.com")
    await client.post("/auth/forgot-password", json={"email": "onceonly@example.com"})
    token = _link_from(_capture_mail[0]).split("token=")[1]

    first = await client.post(
        "/auth/reset-password", json={"token": token, "password": "first-password"}
    )
    assert first.status_code == 200

    second = await client.post(
        "/auth/reset-password", json={"token": token, "password": "second-password"}
    )
    assert second.status_code == 401, "a reset link must not be replayable"

    # And the password is still the one set by the first use.
    check = await client.post(
        "/auth/login", json={"username_or_email": "onceonly", "password": "first-password"}
    )
    assert check.status_code == 200


async def test_an_unknown_address_is_answered_exactly_like_a_known_one(client, _capture_mail):
    """Otherwise the endpoint tells anyone who asks who has an account."""
    await register_and_login(client, "known", email="known@example.com")

    hit = await client.post("/auth/forgot-password", json={"email": "known@example.com"})
    miss = await client.post("/auth/forgot-password", json={"email": "nobody@example.com"})

    assert hit.status_code == miss.status_code == 202
    assert hit.json() == miss.json()
    assert len(_capture_mail) == 1, "only the real address gets mail"


async def test_repeated_requests_are_throttled_without_saying_so(client, _capture_mail):
    """Three an hour, and the fourth looks identical — a distinct 429 would
    leak that this address had already been asked for."""
    await register_and_login(client, "floody", email="floody@example.com")
    for _ in range(5):
        response = await client.post(
            "/auth/forgot-password", json={"email": "floody@example.com"}
        )
        assert response.status_code == 202
    assert len(_capture_mail) == 3


async def test_a_short_password_is_refused(client, _capture_mail):
    await register_and_login(client, "shorty", email="shorty@example.com")
    await client.post("/auth/forgot-password", json={"email": "shorty@example.com"})
    token = _link_from(_capture_mail[0]).split("token=")[1]

    response = await client.post(
        "/auth/reset-password", json={"token": token, "password": "short"}
    )
    assert response.status_code == 422


async def test_the_address_is_matched_case_insensitively(client, _capture_mail):
    await register_and_login(client, "casey", email="casey@example.com")
    response = await client.post(
        "/auth/forgot-password", json={"email": "CASEY@Example.COM"}
    )
    assert response.status_code == 202
    assert len(_capture_mail) == 1, "an address typed with capitals is the same address"
