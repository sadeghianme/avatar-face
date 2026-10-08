"""Password hashing and JWT issuing/validation."""
from __future__ import annotations

import asyncio
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from typing import Literal

from jose import JWTError, jwt
from passlib.context import CryptContext

from app.core.config import get_settings
from app.core.errors import Auth401

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

TokenType = Literal["access", "refresh"]


def hash_password(plain: str) -> str:
    return pwd_context.hash(plain)


def verify_password(plain: str, hashed: str) -> bool:
    return pwd_context.verify(plain, hashed)


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
    except JWTError as exc:
        raise Auth401("Invalid or expired token", code="invalid_token") from exc
    if claims.get("type") != expected_type:
        raise Auth401("Wrong token type", code="invalid_token")
    sub = claims.get("sub")
    if not sub:
        raise Auth401("Malformed token", code="invalid_token")
    return str(sub)
