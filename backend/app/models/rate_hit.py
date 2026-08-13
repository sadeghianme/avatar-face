from __future__ import annotations

from sqlalchemy import Index, String
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import TimestampedBase


class RateHit(TimestampedBase):
    """One row per counted hit on a persistent rate limit.

    Only for limits where surviving a restart matters and traffic is low —
    the password-reset throttle. The embed limiter stays in memory: it runs
    per request on the hot path, and losing a minute's window on deploy is
    harmless there.
    """

    __tablename__ = "rate_hits"
    __table_args__ = (Index("ix_rate_hits_key_created", "key", "created_at"),)

    key: Mapped[str] = mapped_column(String(320), nullable=False)
