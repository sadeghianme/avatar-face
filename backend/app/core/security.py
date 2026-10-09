"""Password hashing and JWT issuing/validation.

Passwords are bcrypt, through the `bcrypt` package itself. Every hash in the
database was written by passlib's bcrypt handler, which is the same
algorithm in the same format (`$2b$12$…`): `bcrypt.checkpw` verifies them
as they are, and new ones are written exactly as passlib wrote them (cost
12, `$2b$`, the password's UTF-8 cut at bcrypt's 72 bytes). So nothing is
migrated and nobody resets a password. tests/test_security.py checks hashes
passlib made.

Tokens are PyJWT's, in the same HS256 form python-jose wrote.
"""

from __future__ import annotations

import asyncio
import re
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from typing import Literal

import bcrypt
import jwt

from app.core.config import get_settings
from app.core.errors import Auth401

# What passlib used for every hash already stored, and so what new ones use:
# the cost (2^12 rounds, about a quarter of a second) and the variant.
BCRYPT_ROUNDS = 12
BCRYPT_PREFIX = b"2b"
# bcrypt reads the first 72 bytes of the password and no more. passlib cut
# longer ones there silently, so the cut stays: a long password set before
# this change must still verify. (bcrypt 5 refuses them instead of cutting.)
BCRYPT_MAX_BYTES = 72

# What a bcrypt hash looks like: variant, cost, 22 characters of salt and 31
# of checksum. Checked before bcrypt sees one: the library panics (an
# exception that is not an Exception) on a truncated hash.
_BCRYPT_HASH = re.compile(r"\$2[abxy]\$\d\d\$[./A-Za-z0-9]{53}")

TokenType = Literal["access", "refresh"]


def _secret(plain: str) -> bytes:
    return plain.encode("utf-8")[:BCRYPT_MAX_BYTES]


def hash_password(plain: str) -> str:
    """A bcrypt hash of `plain`, as passlib wrote them. ValueError on a NUL
    byte, which bcrypt would read as the end of the password (passlib
    refused those too; the request schemas refuse them first)."""
    if "\x00" in plain:
        raise ValueError("a password cannot contain a NUL byte")
    salt = bcrypt.gensalt(rounds=BCRYPT_ROUNDS, prefix=BCRYPT_PREFIX)
    return bcrypt.hashpw(_secret(plain), salt).decode("ascii")


def verify_password(plain: str, hashed: str) -> bool:
    """Whether `plain` is the password `hashed` was made from. False, never an
    exception, for a hash that is not bcrypt and for a NUL byte."""
    if "\x00" in plain or not _BCRYPT_HASH.fullmatch(hashed):
        return False
    try:
        return bcrypt.checkpw(_secret(plain), hashed.encode("ascii"))
    except ValueError:
        return False


# bcrypt is slow on purpose (about a quarter of a second at cost 12), and
# on the event loop that quarter second is every widget on every customer's
# site waiting. It runs on threads of its own, two of them: bcrypt releases
# the GIL, so the loop keeps serving, and a burst of sign-ins queues here
# instead of taking every core from speech synthesis.
_hashing = ThreadPoolExecutor(max_workers=2, thread_name_prefix="liveface-bcrypt")

# A bcrypt hash of a random password nobody knows, at the cost new hashes
# get. Checking a password against it when no account matches makes "no
# such user" take as long as "wrong password", so response time does not
# tell an attacker which usernames exist.
_DUMMY_HASH = "$2b$12$x3/4aDHIb0RTc6fytEX28.Y.HGctK4NEhtR3VVzyOTyDWK.Q.4rla"


async def hash_password_async(plain: str) -> str:
    """`hash_password`, off the event loop."""
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(_hashing, hash_password, plain)


async def verify_password_async(plain: str, hashed: str | None) -> bool:
    """`verify_password`, off the event loop.

    `hashed` None means no account matched: the password is still checked,
    against a dummy hash, and the answer is False either way.
    """
    loop = asyncio.get_running_loop()
    matched = await loop.run_in_executor(
        _hashing, verify_password, plain, hashed if hashed is not None else _DUMMY_HASH
    )
    return matched and hashed is not None


def _create_token(subject: str, token_type: TokenType, expires: timedelta) -> str:
    settings = get_settings()
    now = datetime.now(UTC)
    claims = {
        "sub": subject,
        "type": token_type,
        "iat": now,
        "exp": now + expires,
        "jti": uuid.uuid4().hex,
    }
    return jwt.encode(claims, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def create_access_token(user_id: str) -> str:
    settings = get_settings()
    return _create_token(user_id, "access", timedelta(minutes=settings.access_token_minutes))


def create_refresh_token(user_id: str) -> str:
    settings = get_settings()
    return _create_token(user_id, "refresh", timedelta(days=settings.refresh_token_days))


def decode_token(token: str, expected_type: TokenType) -> str:
    """Return the user id from a valid token of the expected type."""
    settings = get_settings()
    try:
        claims = jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
    except jwt.PyJWTError as exc:
        raise Auth401("Invalid or expired token", code="invalid_token") from exc
    if claims.get("type") != expected_type:
        raise Auth401("Wrong token type", code="invalid_token")
    sub = claims.get("sub")
    if not sub:
        raise Auth401("Malformed token", code="invalid_token")
    return str(sub)
