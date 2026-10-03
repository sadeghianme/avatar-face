from __future__ import annotations

import enum
import secrets
from datetime import datetime

from sqlalchemy import Boolean, DateTime, Enum, ForeignKey, String, UniqueConstraint, true
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import TimestampedBase


class Role(str, enum.Enum):
    owner = "owner"
    admin = "admin"
    member = "member"


# Privilege order for "at least this role" checks.
ROLE_RANK = {Role.member: 0, Role.admin: 1, Role.owner: 2}


class Organization(TimestampedBase):
    __tablename__ = "organizations"

    name: Mapped[str] = mapped_column(String(128), nullable=False)
    # May photos be sent to a third-party AI (Google) at all? On by default,
    # so the AI steps work out of the box; an owner or admin turns it off
    # for an organization whose policy forbids it, and then no route sends
    # a pixel out, whatever consent a member gives (services.consent).
    third_party_ai_enabled: Mapped[bool] = mapped_column(
        Boolean, default=True, server_default=true(), nullable=False
    )

    # The user this is the PERSONAL organization of (the one a new account
    # gets automatically), else null. Unique, so a user has at most one:
    # two requests racing to make it (a double-fired effect, two tabs, a
    # retry) cannot both succeed, and the loser is answered with the winner.
    personal_owner_id: Mapped[str | None] = mapped_column(
        String(32), nullable=True, unique=True
    )

    memberships: Mapped[list["Membership"]] = relationship(
        back_populates="organization", cascade="all, delete-orphan"
    )


class Membership(TimestampedBase):
    __tablename__ = "memberships"
    __table_args__ = (UniqueConstraint("user_id", "org_id", name="uq_membership_user_org"),)

    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False
    )
    org_id: Mapped[str] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), index=True, nullable=False
    )
    role: Mapped[Role] = mapped_column(Enum(Role), default=Role.member, nullable=False)

    organization: Mapped[Organization] = relationship(back_populates="memberships")


def new_invitation_token() -> str:
    return secrets.token_urlsafe(32)


class Invitation(TimestampedBase):
    __tablename__ = "invitations"

    org_id: Mapped[str] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), index=True, nullable=False
    )
    email: Mapped[str] = mapped_column(String(255), nullable=False)
    role: Mapped[Role] = mapped_column(Enum(Role), default=Role.member, nullable=False)
    token: Mapped[str] = mapped_column(
        String(64), unique=True, index=True, default=new_invitation_token, nullable=False
    )
    invited_by_id: Mapped[str] = mapped_column(ForeignKey("users.id"), nullable=False)
    accepted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    @property
    def is_pending(self) -> bool:
        return self.accepted_at is None and self.revoked_at is None
