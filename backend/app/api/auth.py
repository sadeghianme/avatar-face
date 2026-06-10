from __future__ import annotations

from fastapi import APIRouter
from sqlalchemy import or_, select

from app.api.deps import DB, CurrentUser
from app.core.errors import Auth401, Conflict409
from app.core.security import (
    create_access_token,
    create_refresh_token,
    decode_token,
    hash_password,
    verify_password,
)
from app.models import User
from app.schemas.auth import (
    LoginRequest,
    RefreshRequest,
    RegisterRequest,
    TokenPair,
    UserOut,
)

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
