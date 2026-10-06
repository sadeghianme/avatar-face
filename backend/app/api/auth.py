from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel, EmailStr, Field

from app.api.deps import DB, CurrentUser
from app.core.security import create_access_token, create_refresh_token, decode_token
from app.models import User
from app.schemas.auth import (
    LoginRequest,
    RefreshRequest,
    RegisterRequest,
    TokenPair,
    UserOut,
)
from app.services import accounts

router = APIRouter(prefix="/auth", tags=["auth"])


def _tokens(user: User) -> TokenPair:
    return TokenPair(
        access_token=create_access_token(user.id),
        refresh_token=create_refresh_token(user.id),
    )


@router.post("/register", response_model=UserOut, status_code=201)
async def register(body: RegisterRequest, db: DB) -> User:
    return await accounts.register(
        db, body.email, body.username, body.password, body.display_name
    )


@router.post("/login", response_model=TokenPair)
async def login(body: LoginRequest, db: DB) -> TokenPair:
    return _tokens(await accounts.login(db, body.username_or_email, body.password))


@router.post("/refresh", response_model=TokenPair)
async def refresh(body: RefreshRequest, db: DB) -> TokenPair:
    user_id = decode_token(body.refresh_token, "refresh")
    return _tokens(await accounts.require_user(db, user_id))


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
    await accounts.request_password_reset(db, body.email)
    # The same answer when the address was throttled, on purpose: a distinct
    # 429 would leak that this address had already been asked for.
    return {"status": "sent"}


@router.post("/reset-password", response_model=TokenPair)
async def reset_password(body: ResetPasswordRequest, db: DB) -> TokenPair:
    """Finish a reset, and sign the user straight in.

    Signing in here is deliberate: the alternative is bouncing someone who has
    just proved control of the mailbox back to a login form to type the
    password they set four seconds ago.
    """
    return _tokens(await accounts.reset_password(db, body.token, body.password))
