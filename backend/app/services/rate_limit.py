"""Per-key sliding-window rate limiter.

In-memory and per-process: fine for one worker, and listed in the
production-hardening backlog to move to Redis before scaling out.
"""
from __future__ import annotations

import time
from collections import deque


class SlidingWindowRateLimiter:
    def __init__(self, limit: int, window_seconds: float = 60.0):
        self.limit = limit
        self.window = window_seconds
        self._hits: dict[str, deque[float]] = {}

    def allow(self, key: str) -> bool:
        now = time.monotonic()
        hits = self._hits.setdefault(key, deque())
        while hits and hits[0] <= now - self.window:
            hits.popleft()
        if len(hits) >= self.limit:
            return False
        hits.append(now)
        return True

    def reset(self) -> None:
        self._hits.clear()


_limiter: SlidingWindowRateLimiter | None = None


def get_embed_rate_limiter() -> SlidingWindowRateLimiter:
    global _limiter
    if _limiter is None:
        from app.core.config import get_settings

        _limiter = SlidingWindowRateLimiter(get_settings().embed_rate_limit_per_minute)
    return _limiter


def reset_embed_rate_limiter() -> None:
    global _limiter
    _limiter = None


# Password-reset throttle: three an hour, enough for someone who mistypes or
# loses the first mail, far short of using the endpoint to bury an inbox.
# Keyed by address rather than by IP because the inbox is what gets hurt, and
# an attacker changes address far more easily than a victim changes mailbox.
RESET_LIMIT = 3
RESET_WINDOW_SECONDS = 3600


async def allow_persistent(db, key: str, *, limit: int, window_seconds: int) -> bool:
    """Sliding-window limit counted in the database.

    For limits where surviving a restart matters: the in-memory limiter
    reset on every deploy, and this project deploys many times a day, so
    "3 per hour" was really "3 per deploy". Low-traffic keys only — this
    costs a delete, a count and an insert per call.

    Rows the caller creates are committed by the caller's own transaction,
    which is the point: the hit and the action it gates land atomically.
    """
    from datetime import timedelta

    from sqlalchemy import delete, func, select

    from app.models import RateHit
    from app.models.base import utcnow

    cutoff = utcnow() - timedelta(seconds=window_seconds)
    # Purge this key's expired rows — keeps the table at worst a few rows per
    # active key without needing a background job.
    await db.execute(delete(RateHit).where(RateHit.key == key, RateHit.created_at < cutoff))
    hits = (
        await db.execute(
            select(func.count()).select_from(RateHit).where(RateHit.key == key, RateHit.created_at >= cutoff)
        )
    ).scalar_one()
    if hits >= limit:
        return False
    db.add(RateHit(key=key))
    return True
