"""Accounts and dashboard sessions.

A sign-in answers with an access token in the body (the dashboard keeps it
in memory, never in storage) and sets two cookies:

* `lf_refresh`: the refresh token. httpOnly, so no script reads it;
  SameSite=Strict, so no other site's page sends it; Path=/api/auth
  (SESSION_COOKIE_PATH), so it goes to these routes and to nothing else;
  Secure wherever the dashboard is https (Settings.cookies_secure).
* `lf_session=1`: the same lifetime, no secret, readable by the dashboard:
  whether there is a session to restore on load at all, so a visitor who
  never signed in (the landing page, a share page) makes no refresh request.

The refresh cookie authenticates only POST /auth/refresh and /auth/logout,
and they, like every route here that sets it, refuse a request from another
site (deps.require_same_origin). Everything else is authorized by the bearer
access token, which no browser attaches by itself.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Cookie, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, EmailStr, Field, field_validator

from app.api.deps import DB, CurrentUser, SameOrigin, access_claims, client_address
from app.core.config import get_settings
from app.core.errors import Auth401
from app.models import User
from app.schemas.auth import AccessToken, LoginRequest, RegisterRequest, UserOut, no_nul
from app.services import accounts, sessions
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

REFRESH_COOKIE = "lf_refresh"
SESSION_HINT_COOKIE = "lf_session"

RefreshCookie = Annotated[str | None, Cookie(alias=REFRESH_COOKIE)]


def _client(request: Request) -> sessions.Client:
    return sessions.Client(
        user_agent=request.headers.get("user-agent", ""), ip=client_address(request)
    )


def _set_session_cookies(response: Response, issued: sessions.Issued) -> None:
    settings = get_settings()
    max_age = settings.refresh_token_days * 24 * 3600
    response.set_cookie(
        REFRESH_COOKIE,
        issued.refresh_token,
        max_age=max_age,
        path=settings.session_cookie_path,
        secure=settings.cookies_secure,
        httponly=True,
        samesite="strict",
    )
    response.set_cookie(
        SESSION_HINT_COOKIE,
        "1",
        max_age=max_age,
        path="/",
        secure=settings.cookies_secure,
        httponly=False,
        samesite="strict",
    )


def _clear_session_cookies(response: Response) -> None:
    settings = get_settings()
    response.delete_cookie(
        REFRESH_COOKIE,
        path=settings.session_cookie_path,
        secure=settings.cookies_secure,
        httponly=True,
        samesite="strict",
    )
    response.delete_cookie(
        SESSION_HINT_COOKIE, path="/", secure=settings.cookies_secure, samesite="strict"
    )


def _signed_in(response: Response, issued: sessions.Issued) -> AccessToken:
    _set_session_cookies(response, issued)
    return AccessToken(access_token=issued.access_token, expires_in=issued.expires_in)


def _refused(error: Auth401) -> JSONResponse:
    """A refused refresh, in the usual envelope, that also deletes the
    cookies: a session that cannot be refreshed is over in this browser."""
    response = JSONResponse(
        status_code=401,
        content={"detail": error.detail, "code": error.code},
        headers={"WWW-Authenticate": "Bearer"},
    )
    _clear_session_cookies(response)
    return response


@router.post("/register", response_model=UserOut, status_code=201)
async def register(body: RegisterRequest, request: Request, db: DB) -> User:
    """A new account. 409 `user_exists`; 429 `rate_limited` past
    REGISTER_PER_CLIENT sign-ups an hour from one address."""
    enforce(REGISTER_PER_CLIENT, client_address(request), TOO_MANY)
    return await accounts.register(db, body.email, body.username, body.password, body.display_name)


@router.post("/login", response_model=AccessToken, dependencies=[SameOrigin])
async def login(body: LoginRequest, request: Request, response: Response, db: DB) -> AccessToken:
    """A new session for these credentials: its access token, and its
    refresh cookie. 401 `invalid_credentials`; 429 `rate_limited` past
    LOGIN_PER_CLIENT attempts a minute from one address or LOGIN_PER_ACCOUNT
    attempts on one account in ten minutes; 403 `cross_site_request`."""
    enforce(LOGIN_PER_CLIENT, client_address(request), TOO_MANY)
    enforce(LOGIN_PER_ACCOUNT, body.username_or_email.strip().lower(), TOO_MANY)
    user = await accounts.login(db, body.username_or_email, body.password)
    return _signed_in(response, await sessions.open_session(db, user, _client(request)))


@router.post(
    "/refresh",
    response_model=AccessToken,
    dependencies=[SameOrigin],
    responses={401: {"description": "No session to refresh; the cookies are deleted"}},
)
async def refresh(
    request: Request, response: Response, db: DB, lf_refresh: RefreshCookie = None
) -> AccessToken | JSONResponse:
    """A new access token for the session in the refresh cookie, which is
    exchanged for the next one (services.sessions.rotate). 401 with the
    cookies deleted when there is none to refresh: `no_session`,
    `invalid_refresh_token`, `session_revoked`, `session_expired`,
    `refresh_token_reused` (the session is revoked everywhere), or
    `refresh_superseded` (exchanged a moment ago by another tab: try again).
    403 `cross_site_request`."""
    try:
        issued = await sessions.rotate(db, lf_refresh, _client(request))
    except Auth401 as error:
        if error.code == "refresh_superseded":
            # Another tab holds the session's new token, in this same cookie
            # jar: the session is fine, and this browser keeps its cookies.
            raise
        return _refused(error)
    return _signed_in(response, issued)


@router.post("/logout", status_code=204, dependencies=[SameOrigin])
async def logout(
    request: Request, response: Response, db: DB, lf_refresh: RefreshCookie = None
) -> None:
    """Sign this browser out: its session is revoked (the one the refresh
    cookie names, and the bearer token's, if one came along) and the
    cookies are deleted. Always 204, signed in or not. 403
    `cross_site_request`."""
    await sessions.end_session_of_token(db, lf_refresh)
    try:
        claims = access_claims(request)
    except Auth401:
        claims = None
    if claims is not None:
        await sessions.end_session(db, claims.user_id, claims.session_id, "logout")
    await db.commit()
    _clear_session_cookies(response)


@router.post("/logout-all", status_code=204)
async def logout_all(user: CurrentUser, response: Response, db: DB) -> None:
    """Sign out everywhere: every session of this account is revoked, this
    one included, and this browser's cookies are deleted. Bearer-authorized,
    so another site cannot make a browser send it."""
    await sessions.end_all_sessions(db, user.id, "logout_all")
    await db.commit()
    _clear_session_cookies(response)


@router.get("/me", response_model=UserOut)
async def me(user: CurrentUser) -> User:
    return user


class ForgotPasswordRequest(BaseModel):
    email: EmailStr


class ResetPasswordRequest(BaseModel):
    token: str
    password: str = Field(min_length=8, max_length=128)

    @field_validator("password")
    @classmethod
    def password_has_no_nul(cls, value: str) -> str:
        return no_nul(value)


@router.post("/forgot-password", status_code=202)
async def forgot_password(body: ForgotPasswordRequest, request: Request, db: DB) -> dict:
    """Start a password reset.

    Always answers the same way, whether or not the address has an account.
    Anything else turns this into a membership oracle: try an address, read
    the response, learn who is a customer. That is why there is no "no such
    user" branch and why a delivery failure is not reported either — the
    difference would be just as readable. So is the time an answer takes:
    the mail is sent after the answer, never before it.

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


@router.post("/reset-password", response_model=AccessToken, dependencies=[SameOrigin])
async def reset_password(
    body: ResetPasswordRequest, request: Request, response: Response, db: DB
) -> AccessToken:
    """Finish a reset: every session of the account is revoked with the old
    password, and this browser is signed straight into a new one.

    Signing in here is deliberate: the alternative is bouncing someone who has
    just proved control of the mailbox back to a login form to type the
    password they set four seconds ago.

    401 `reset_token_invalid` / `reset_token_used`; 429 `rate_limited` past
    RESET_PER_CLIENT attempts in fifteen minutes from one address; 403
    `cross_site_request`.
    """
    enforce(RESET_PER_CLIENT, client_address(request), TOO_MANY)
    user = await accounts.reset_password(db, body.token, body.password)
    return _signed_in(response, await sessions.open_session(db, user, _client(request)))
