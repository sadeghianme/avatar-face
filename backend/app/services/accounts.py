"""Accounts: who a user is, signing up and in, and resetting a password.

The queries and writes behind api.auth and the bearer-token dependency
(api.deps.get_current_user). Tokens themselves are app.core.security's;
this module only decides whose they are.
"""

from __future__ import annotations

import hmac
import logging

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.errors import Auth401, Conflict409
from app.core.security import hash_password, verify_password
from app.models import User
from app.services.email import reset_email
from app.services.email import send as send_email
from app.services.rate_limit import RESET_LIMIT, RESET_WINDOW_SECONDS, allow_persistent
from app.services.reset_token import DEFAULT_TTL_SECONDS as RESET_TTL_SECONDS
from app.services.reset_token import InvalidResetToken
from app.services.reset_token import fingerprint as hash_fingerprint
from app.services.reset_token import mint as mint_reset_token
from app.services.reset_token import verify as verify_reset_token

logger = logging.getLogger("liveface.auth")


async def get_user(db: AsyncSession, user_id: str) -> User | None:
    return (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()


async def require_user(db: AsyncSession, user_id: str) -> User:
    """The user a valid token names; 401 unknown_user once they are gone."""
    user = await get_user(db, user_id)
    if user is None:
        raise Auth401("User no longer exists", code="unknown_user")
    return user


async def register(
    db: AsyncSession, email: str, username: str, password: str, display_name: str | None
) -> User:
    """A new account (409 user_exists when the email or username is taken)."""
    existing = (
        await db.execute(
            select(User).where(or_(User.email == email.lower(), User.username == username))
        )
    ).scalar_one_or_none()
    if existing is not None:
        raise Conflict409("Email or username already in use", code="user_exists")
    user = User(
        email=email.lower(),
        username=username,
        password_hash=hash_password(password),
        display_name=display_name or username,
    )
    db.add(user)
    await db.commit()
    return user


async def login(db: AsyncSession, username_or_email: str, password: str) -> User:
    """The user these credentials sign in; one 401 for every way they do not."""
    identifier = username_or_email.strip()
    user = (
        await db.execute(
            select(User).where(or_(User.email == identifier.lower(), User.username == identifier))
        )
    ).scalar_one_or_none()
    if user is None or not verify_password(password, user.password_hash):
        raise Auth401("Invalid credentials", code="invalid_credentials")
    return user


async def request_password_reset(db: AsyncSession, email: str) -> None:
    """Mail a reset link to `email` if it has an account, within the limit.

    Says nothing either way (api.auth.forgot_password answers the same
    whatever happens here), and is rate limited per address so it cannot be
    used to mail-bomb someone, and because Resend charges per message.
    """
    settings = get_settings()
    address = email.strip().lower()

    allowed = await allow_persistent(
        db, f"pwreset:{address}", limit=RESET_LIMIT, window_seconds=RESET_WINDOW_SECONDS
    )
    # get_db never commits on its own, and this request otherwise writes
    # nothing — without this the counted hit would evaporate per request and
    # the limit would never engage.
    await db.commit()
    if not allowed:
        logger.info("password reset throttled for an address")
        return

    user = (
        await db.execute(select(User).where(func.lower(User.email) == address))
    ).scalar_one_or_none()

    if user is not None:
        token, _ = mint_reset_token(settings.jwt_secret, user.id, user.password_hash)
        link = f"{settings.app_base_url.rstrip('/')}/reset-password?token={token}"
        subject, html, text = reset_email(settings.app_name, link, RESET_TTL_SECONDS // 60)
        await send_email(user.email, subject, html, text)


async def reset_password(db: AsyncSession, token: str, password: str) -> User:
    """Set the password a reset link was sent for; the user, to sign in."""
    settings = get_settings()
    try:
        user_id, token_fingerprint = verify_reset_token(settings.jwt_secret, token)
    except InvalidResetToken as exc:
        raise Auth401(f"This reset link is not valid ({exc})", code="reset_token_invalid")

    user = await get_user(db, user_id)
    if user is None:
        raise Auth401("This reset link is not valid", code="reset_token_invalid")

    # The fingerprint is of the password hash the link was minted against, so
    # this is what makes it single-use: once the password changes, the hash
    # changes, and every outstanding link stops matching.
    if not hmac.compare_digest(token_fingerprint, hash_fingerprint(user.password_hash)):
        raise Auth401("This reset link has already been used", code="reset_token_used")

    user.password_hash = hash_password(password)
    await db.commit()
    return user
