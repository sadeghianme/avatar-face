from __future__ import annotations

import enum
import secrets
from datetime import datetime

from sqlalchemy import DateTime, Enum, ForeignKey, String, UniqueConstraint
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
