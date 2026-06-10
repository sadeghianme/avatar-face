"""Password hashing and JWT issuing/validation."""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
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


def _create_token(subject: str, token_type: TokenType, expires: timedelta) -> str:
    settings = get_settings()
    now = datetime.now(timezone.utc)
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
