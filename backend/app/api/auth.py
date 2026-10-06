from __future__ import annotations

from fastapi import APIRouter, Request
from pydantic import BaseModel, EmailStr, Field

from app.api.deps import DB, CurrentUser, client_address
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
from app.services.rate_limit import (
    FORGOT_PER_CLIENT,
    LOGIN_PER_ACCOUNT,
    LOGIN_PER_CLIENT,
    REGISTER_PER_CLIENT,
    RESET_PER_CLIENT,
    enforce,
)

router = APIRouter(prefix="/auth", tags=["auth"])

# Every route that hashes a password or sends mail is rate limited before it
# does either (services.rate_limit has the numbers). Over a limit is a 429,
# code `rate_limited`, with Retry-After in seconds.
TOO_MANY = "Too many attempts — try again in a few minutes"


def _tokens(user: User) -> TokenPair:
    return TokenPair(
        access_token=create_access_token(user.id),
        refresh_token=create_refresh_token(user.id),
    )


@router.post("/register", response_model=UserOut, status_code=201)
async def register(body: RegisterRequest, request: Request, db: DB) -> User:
    """A new account. 409 `user_exists`; 429 `rate_limited` past
    REGISTER_PER_CLIENT sign-ups an hour from one address."""
    enforce(REGISTER_PER_CLIENT, client_address(request), TOO_MANY)
    return await accounts.register(
        db, body.email, body.username, body.password, body.display_name
    )


@router.post("/login", response_model=TokenPair)
async def login(body: LoginRequest, request: Request, db: DB) -> TokenPair:
    """Tokens for these credentials. 401 `invalid_credentials`; 429
    `rate_limited` past LOGIN_PER_CLIENT attempts a minute from one address
    or LOGIN_PER_ACCOUNT attempts on one account in ten minutes."""
    enforce(LOGIN_PER_CLIENT, client_address(request), TOO_MANY)
    enforce(LOGIN_PER_ACCOUNT, body.username_or_email.strip().lower(), TOO_MANY)
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
async def forgot_password(body: ForgotPasswordRequest, request: Request, db: DB) -> dict:
    """Start a password reset.

    Always answers the same way, whether or not the address has an account.
    Anything else turns this into a membership oracle: try an address, read
    the response, learn who is a customer. That is why there is no "no such
    user" branch and why a delivery failure is not reported either — the
    difference would be just as readable.

    Rate limited per address so it cannot be used to mail-bomb someone, and
    because Resend charges per message. Also per client (FORGOT_PER_CLIENT
    an hour): that one does answer 429 `rate_limited`, which says something
    about the caller, never about the address asked for.
    """
    enforce(FORGOT_PER_CLIENT, client_address(request), TOO_MANY)
    await accounts.request_password_reset(db, body.email)
    # The same answer when the address was throttled, on purpose: a distinct
    # 429 would leak that this address had already been asked for.
    return {"status": "sent"}


@router.post("/reset-password", response_model=TokenPair)
async def reset_password(body: ResetPasswordRequest, request: Request, db: DB) -> TokenPair:
    """Finish a reset, and sign the user straight in.

    Signing in here is deliberate: the alternative is bouncing someone who has
    just proved control of the mailbox back to a login form to type the
    password they set four seconds ago.

    401 `reset_token_invalid` / `reset_token_used`; 429 `rate_limited` past
    RESET_PER_CLIENT attempts in fifteen minutes from one address.
    """
    enforce(RESET_PER_CLIENT, client_address(request), TOO_MANY)
    return _tokens(await accounts.reset_password(db, body.token, body.password))
