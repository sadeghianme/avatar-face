"""Password hashing, and the dashboard's access tokens.

Passwords are bcrypt, through the `bcrypt` package itself. Every hash in the
database was written by passlib's bcrypt handler, which is the same
algorithm in the same format (`$2b$12$…`): `bcrypt.checkpw` verifies them
as they are, and new ones are written exactly as passlib wrote them (cost
12, `$2b$`, the password's UTF-8 cut at bcrypt's 72 bytes). So nothing is
migrated and nobody resets a password. tests/test_security.py checks hashes
passlib made.

An access token is a JWT (PyJWT, HS256) that lives `access_token_minutes`
and names its user (`sub`) and its session (`sid`, services.sessions). Its
key is derived from JWT_SECRET for this one use (`access_key`), so no other
value made with that secret (a reset link's signature, an address hash)
can ever be mistaken for one. The session is the revocable part: the refresh token,
in an httpOnly cookie, and its row in the database. api.deps checks on
every request that the session is still open, so signing out, signing out
everywhere or resetting the password ends every token at once, not when
they expire.
"""

from __future__ import annotations

import asyncio
import hashlib
import re
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from typing import NamedTuple

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
DUMMY_HASH = "$2b$12$x3/4aDHIb0RTc6fytEX28.Y.HGctK4NEhtR3VVzyOTyDWK.Q.4rla"


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
        _hashing, verify_password, plain, hashed if hashed is not None else DUMMY_HASH
    )
    return matched and hashed is not None


class AccessClaims(NamedTuple):
    """Whose a valid access token is, and the session it was issued for."""

    user_id: str
    session_id: str


def access_key(secret: str) -> bytes:
    """The access tokens' signing key: 32 bytes, from JWT_SECRET and a
    label of their own (domain separation; and the full HS256 key length
    whatever the secret's, so PyJWT has no short key to warn about)."""
    return hashlib.sha256(b"liveface access token v1:" + secret.encode()).digest()


def create_access_token(user_id: str, session_id: str) -> str:
    settings = get_settings()
    now = datetime.now(UTC)
    claims = {
        "sub": user_id,
        "sid": session_id,
        "type": "access",
        "iat": now,
        "exp": now + timedelta(minutes=settings.access_token_minutes),
        "jti": uuid.uuid4().hex,
    }
    return jwt.encode(claims, access_key(settings.jwt_secret), algorithm=settings.jwt_algorithm)


def decode_access_token(token: str) -> AccessClaims:
    """The claims of a valid, unexpired access token; 401 `invalid_token`
    for anything else, a token from before sessions (no `sid`) included.
    Whether the session is still open is the caller's to check
    (services.sessions.session_user)."""
    settings = get_settings()
    try:
        claims = jwt.decode(
            token,
            access_key(settings.jwt_secret),
            algorithms=[settings.jwt_algorithm],
            options={"require": ["exp", "iat", "sub", "sid"]},
        )
    except jwt.PyJWTError as exc:
        raise Auth401("Invalid or expired token", code="invalid_token") from exc
    if claims.get("type") != "access":
        raise Auth401("Wrong token type", code="invalid_token")
    user_id, session_id = claims["sub"], claims["sid"]
    if not isinstance(user_id, str) or not user_id or not isinstance(session_id, str):
        raise Auth401("Malformed token", code="invalid_token")
    return AccessClaims(user_id, session_id)
