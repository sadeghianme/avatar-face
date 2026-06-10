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
