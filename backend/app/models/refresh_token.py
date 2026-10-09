from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, String
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import TimestampedBase


class RefreshToken(TimestampedBase):
    """One refresh token of a dashboard session (services.sessions).

    A session is a family: the token a sign-in issues, and each token that
    replaced the one before it (`family_id` is the session's id, the `sid`
    of its access tokens). A token is spent once it has been exchanged
    (`last_used_at`); presenting a spent one again means two parties hold
    the same session, and the whole family is revoked.

    Only the SHA-256 of the token is kept: it is 256 random bits, so a
    fast hash is enough, and a copy of the database opens no session.
    """

    __tablename__ = "refresh_tokens"
    __table_args__ = (Index("ix_refresh_tokens_expires_at", "expires_at"),)

    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False
    )
    family_id: Mapped[str] = mapped_column(String(32), index=True, nullable=False)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    # When it was exchanged for the next token of its family: spent.
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # Why: logout, logout_all, password_reset (or _change), reuse.
    revoked_reason: Mapped[str | None] = mapped_column(String(32), nullable=True)
    # Who asked for it: the browser's User-Agent (cut to 255) and a keyed
    # hash of its address (services.sessions.ip_hash), never the address.
    user_agent: Mapped[str] = mapped_column(String(255), default="", nullable=False)
    ip_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
