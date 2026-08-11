from __future__ import annotations

import hmac
import logging

from fastapi import APIRouter
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import func, or_, select

from app.api.deps import DB, CurrentUser
from app.core.errors import Auth401, Conflict409
from app.core.security import (
    create_access_token,
    create_refresh_token,
    decode_token,
    hash_password,
    verify_password,
)
from app.core.config import get_settings
from app.models import User
from app.services.email import reset_email
from app.services.email import send as send_email
from app.services.rate_limit import get_reset_rate_limiter
from app.services.reset_token import DEFAULT_TTL_SECONDS as RESET_TTL_SECONDS
from app.services.reset_token import InvalidResetToken
from app.services.reset_token import fingerprint as hash_fingerprint
from app.services.reset_token import mint as mint_reset_token
from app.services.reset_token import verify as verify_reset_token
from app.schemas.auth import (
    LoginRequest,
    RefreshRequest,
    RegisterRequest,
    TokenPair,
    UserOut,
)

logger = logging.getLogger("liveface.auth")
router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/register", response_model=UserOut, status_code=201)
async def register(body: RegisterRequest, db: DB) -> User:
    existing = (
        await db.execute(
            select(User).where(
                or_(User.email == body.email.lower(), User.username == body.username)
            )
        )
    ).scalar_one_or_none()
    if existing is not None:
        raise Conflict409("Email or username already in use", code="user_exists")
    user = User(
        email=body.email.lower(),
        username=body.username,
        password_hash=hash_password(body.password),
        display_name=body.display_name or body.username,
    )
    db.add(user)
    await db.commit()
    return user


@router.post("/login", response_model=TokenPair)
async def login(body: LoginRequest, db: DB) -> TokenPair:
    identifier = body.username_or_email.strip()
    user = (
        await db.execute(
            select(User).where(
                or_(User.email == identifier.lower(), User.username == identifier)
            )
        )
    ).scalar_one_or_none()
    if user is None or not verify_password(body.password, user.password_hash):
        raise Auth401("Invalid credentials", code="invalid_credentials")
    return TokenPair(
        access_token=create_access_token(user.id),
        refresh_token=create_refresh_token(user.id),
    )


@router.post("/refresh", response_model=TokenPair)
async def refresh(body: RefreshRequest, db: DB) -> TokenPair:
    user_id = decode_token(body.refresh_token, "refresh")
    user = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
    if user is None:
        raise Auth401("User no longer exists", code="unknown_user")
    return TokenPair(
        access_token=create_access_token(user.id),
        refresh_token=create_refresh_token(user.id),
    )


@router.get("/me", response_model=UserOut)
async def me(user: CurrentUser) -> User:
    return user


class ForgotPasswordRequest(BaseModel):
    email: EmailStr


class ResetPasswordRequest(BaseModel):
    token: str
    password: str = Field(min_length=8, max_length=128)


@router.post("/forgot-password", status_code=202)
async def forgot_password(body: ForgotPasswordRequest, db: DB) -> dict:
    """Start a password reset.

    Always answers the same way, whether or not the address has an account.
    Anything else turns this into a membership oracle: try an address, read
    the response, learn who is a customer. That is why there is no "no such
    user" branch and why a delivery failure is not reported either — the
    difference would be just as readable.

    Rate limited per address so it cannot be used to mail-bomb someone, and
    because Resend charges per message.
    """
    settings = get_settings()
    address = body.email.strip().lower()

    if not get_reset_rate_limiter().allow(address):
        # Same shape as success on purpose — a distinct 429 would leak that
        # this address had already been asked for.
        logger.info("password reset throttled for an address")
        return {"status": "sent"}

    user = (
        await db.execute(select(User).where(func.lower(User.email) == address))
    ).scalar_one_or_none()

    if user is not None:
        token, _ = mint_reset_token(settings.jwt_secret, user.id, user.password_hash)
        link = f"{settings.app_base_url.rstrip('/')}/reset-password?token={token}"
        subject, html, text = reset_email(
            settings.app_name, link, RESET_TTL_SECONDS // 60
        )
        await send_email(user.email, subject, html, text)

    return {"status": "sent"}


@router.post("/reset-password", response_model=TokenPair)
async def reset_password(body: ResetPasswordRequest, db: DB) -> TokenPair:
    """Finish a reset, and sign the user straight in.

    Signing in here is deliberate: the alternative is bouncing someone who has
    just proved control of the mailbox back to a login form to type the
    password they set four seconds ago.
    """
    settings = get_settings()
    try:
        user_id, token_fingerprint = verify_reset_token(settings.jwt_secret, body.token)
    except InvalidResetToken as exc:
        raise Auth401(f"This reset link is not valid ({exc})", code="reset_token_invalid")

    user = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
    if user is None:
        raise Auth401("This reset link is not valid", code="reset_token_invalid")

    # The fingerprint is of the password hash the link was minted against, so
    # this is what makes it single-use: once the password changes, the hash
    # changes, and every outstanding link stops matching.
    if not hmac.compare_digest(token_fingerprint, hash_fingerprint(user.password_hash)):
        raise Auth401("This reset link has already been used", code="reset_token_used")

    user.password_hash = hash_password(body.password)
    await db.commit()
    return TokenPair(
        access_token=create_access_token(user.id),
        refresh_token=create_refresh_token(user.id),
    )
