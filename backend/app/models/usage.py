from __future__ import annotations

from sqlalchemy import ForeignKey, Index, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import TimestampedBase


class UsageEvent(TimestampedBase):
    """One row per metered action (currently: every TTS synthesis)."""

    __tablename__ = "usage_events"
    __table_args__ = (Index("ix_usage_org_created", "org_id", "created_at"),)

    org_id: Mapped[str] = mapped_column(
        ForeignKey("organizations.id", ondelete="CASCADE"), index=True, nullable=False
    )
    kind: Mapped[str] = mapped_column(String(32), default="tts_synthesis", nullable=False)
    provider: Mapped[str] = mapped_column(String(32), nullable=False)
    char_count: Mapped[int] = mapped_column(Integer, nullable=False)
    cached: Mapped[bool] = mapped_column(default=False, nullable=False)
    source: Mapped[str] = mapped_column(String(16), default="dashboard", nullable=False)
