"""Passwords with bcrypt itself, tokens with PyJWT (app.core.security), and
the libraries they replaced gone (passlib, python-jose)."""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from app.core.security import _DUMMY_HASH, hash_password, verify_password
from app.db import get_session_factory
from app.models import User
from app.services.tts import providers

BACKEND = Path(__file__).resolve().parents[1]

# Made by passlib 1.7.4 (CryptContext(schemes=["bcrypt"]), bcrypt 4.0.1
# backend), exactly as the accounts in production were: every one of them
# must keep signing in. Generated once, 2026-10-09, and never again (passlib
# is gone).
PASSLIB_HASHES = [
    ("password123", "$2b$12$PC016pCj.sB4mtCwEPXWF.ghnQ4bekk/LdiyDEwtLNJmuY6U3tpua"),
    (
        "correct horse battery staple",
        "$2b$12$075aVUKmZqLE/oXk0FoIvOYjSKPWMeXBuQKlj9VYty90whB8vYcve",
    ),
    ("pässwörd-ünïcödé-密码", "$2b$12$5Nl4JVkOJOud36o7.X1gp.elQIN.2GwKQJGHUetGAnUIorZ1cF.le"),
    # 100 bytes: passlib cut it at bcrypt's 72.
    ("x" * 100, "$2b$12$i86JllStwtomK76m7r8aSe0TFNUH6oPvvrGrL4gn9qU6qwHpNMImC"),
    ("short-cost-4", "$2b$04$Lbr9IHWem/iudPNRO0YDKOfoAJ3nr.b5kUVgB1hrJBHeUDtr031LW"),
    # The older $2a$ variant, which passlib could be configured to write.
    ("legacy-2a-password", "$2a$12$/ZWDAU2IjroTxSs3YddTvuj3IXnQrsJQybqEu0VqOQeQ0pUWVRIx."),
]

PASSLIB_FORMAT = re.compile(r"^\$2b\$12\$[./A-Za-z0-9]{53}$")


# --- passwords ---------------------------------------------------------------


@pytest.mark.parametrize(("password", "hashed"), PASSLIB_HASHES)
def test_every_hash_passlib_wrote_still_verifies(password, hashed):
    assert verify_password(password, hashed)
    assert not verify_password("!" + password, hashed)
    assert not verify_password(password[: len(password) // 2], hashed)


def test_a_password_longer_than_72_bytes_is_cut_where_passlib_cut_it():
    password, hashed = PASSLIB_HASHES[3]
    assert verify_password("x" * 72 + "anything after the 72nd byte", hashed)
    assert not verify_password("x" * 71, hashed)
    fresh = hash_password("y" * 100)
    assert verify_password("y" * 72, fresh)


def test_new_hashes_are_written_as_passlib_wrote_them():
    hashed = hash_password("password123")
    assert PASSLIB_FORMAT.match(hashed), hashed
    assert hashed[:7] == _DUMMY_HASH[:7]
    assert verify_password("password123", hashed)
    assert not verify_password("password124", hashed)
    # Salted: the same password never hashes the same twice.
    assert hash_password("password123") != hashed


def test_unicode_is_hashed_as_utf8():
    hashed = hash_password("pässwörd-ünïcödé-密码")
    assert verify_password("pässwörd-ünïcödé-密码", hashed)
    assert not verify_password("passwrd-unicode", hashed)


def test_a_nul_byte_is_refused_not_cut():
    with pytest.raises(ValueError):
        hash_password("before\x00after")
    assert not verify_password("password123\x00", PASSLIB_HASHES[0][1])


@pytest.mark.parametrize(
    "hashed",
    ["", "plain-text", "$1$md5$crypt", "$2b$12$short", "€uro", PASSLIB_HASHES[0][1][:-1]],
)
def test_a_hash_that_is_not_bcrypt_never_verifies_and_never_raises(hashed):
    assert verify_password("password123", hashed) is False


async def test_a_nul_byte_in_a_new_password_is_a_422(client):
    response = await client.post(
        "/auth/register",
        json={"email": "nul@example.com", "username": "nul", "password": "pass\x00word12"},
    )
    assert response.status_code == 422
    assert response.json()["code"] == "validation_error"


async def test_an_account_from_before_signs_in(client):
    """A user row as production has them: a passlib hash, no session yet."""
    async with get_session_factory()() as db:
        db.add(User(email="old@example.com", username="old", password_hash=PASSLIB_HASHES[1][1]))
        await db.commit()
    response = await client.post(
        "/auth/login",
        json={"username_or_email": "old", "password": "correct horse battery staple"},
    )
    assert response.status_code == 200, response.text
    me = await client.get(
        "/auth/me", headers={"Authorization": f"Bearer {response.json()['access_token']}"}
    )
    assert me.json()["username"] == "old"


# --- tokens ------------------------------------------------------------------


async def test_google_tts_signs_its_assertion_with_pyjwt(monkeypatch):
    """The service-account assertion (RS256) PyJWT now signs: Google would
    verify it with the account's public key. No request leaves the test."""
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode()
    account = {"client_email": "tts@example.iam.gserviceaccount.com", "private_key": pem}
    sent: dict = {}

    class FakeResponse:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict:
            return {"access_token": "google-token"}

    class FakeClient:
        def __init__(self, **_):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return None

        async def post(self, url, data):
            sent.update(url=url, data=data)
            return FakeResponse()

    provider = providers.GoogleTTSProvider()
    monkeypatch.setattr(provider, "_service_account", lambda: account)
    monkeypatch.setattr(providers.httpx, "AsyncClient", FakeClient)
    assert await provider._access_token() == "google-token"
    claims = jwt.decode(
        sent["data"]["assertion"],
        key.public_key(),
        algorithms=["RS256"],
        audience="https://oauth2.googleapis.com/token",
    )
    assert claims["iss"] == account["client_email"]
    assert claims["exp"] - claims["iat"] == 3600


# --- the libraries -----------------------------------------------------------


def test_passlib_and_python_jose_are_gone():
    """Not imported by the application, and not required by the project:
    passlib needs `crypt`, which Python 3.13 removes."""
    loaded = subprocess.run(
        [
            sys.executable,
            "-c",
            "import sys, app.main; "
            "print(sorted({m.split('.')[0] for m in sys.modules} & {'passlib', 'jose', 'crypt'}))",
        ],
        cwd=BACKEND,
        capture_output=True,
        text=True,
        check=True,
    )
    assert loaded.stdout.strip() == "[]", loaded.stdout + loaded.stderr
    requirements = (BACKEND / "pyproject.toml").read_text() + (
        BACKEND / "constraints.txt"
    ).read_text()
    for name in ("passlib", "python-jose", "ecdsa=="):
        assert f'"{name}' not in requirements and f"\n{name}" not in requirements, name
