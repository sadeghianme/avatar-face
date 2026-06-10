from __future__ import annotations

import enum

from sqlalchemy import Enum, ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import TimestampedBase


class AvatarStatus(str, enum.Enum):
    pending = "pending"
    processing = "processing"
    ready = "ready"
    failed = "failed"


class Avatar(TimestampedBase):
    __tablename__ = "avatars"

    org_id: Mapped[str] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), index=True, nullable=False
    )
    created_by_id: Mapped[str] = mapped_column(ForeignKey("users.id"), nullable=False)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    status: Mapped[AvatarStatus] = mapped_column(
        Enum(AvatarStatus), default=AvatarStatus.pending, nullable=False
    )
    content_type: Mapped[str] = mapped_column(String(64), nullable=False)
    # Storage keys (set as the pipeline progresses)
    image_key: Mapped[str | None] = mapped_column(String(255), nullable=True)
    rig_key: Mapped[str | None] = mapped_column(String(255), nullable=True)
    thumbnail_key: Mapped[str | None] = mapped_column(String(255), nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
