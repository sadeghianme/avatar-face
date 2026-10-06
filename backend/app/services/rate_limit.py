"""Rate limits: an in-memory sliding window, and a persistent one.

The in-memory limiter is per process: fine for one worker, and listed in
the production-hardening backlog to move to Redis before scaling out. Every
limit the API applies is named here (`Limit`), so the numbers sit side by
side and tests can reset them all at once (`reset_rate_limiters`).
"""

from __future__ import annotations

import math
import time
from collections import OrderedDict, deque
from collections.abc import Callable
from dataclasses import dataclass
from datetime import timedelta

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.errors import RateLimit429
from app.models import RateHit, utcnow

# Past this many keys the least recently hit one is forgotten. Ten thousand
# deques of a few floats each is a few megabytes at most.
DEFAULT_MAX_KEYS = 10_000


class SlidingWindowRateLimiter:
    """At most `limit` hits per key in any `window_seconds`.

    Memory is bounded two ways. A key whose newest hit has left the window
    holds nothing worth keeping, and is dropped: keys are kept in the order
    of their newest hit, so the idle ones are always at the front and every
    call sweeps them in amortised constant time. And at most `max_keys` keys
    are tracked: beyond that the least recently hit is forgotten. On the
    open internet a key is a client address, and without the bound a flood
    of distinct addresses grows memory for as long as it lasts. Forgetting a
    key can only let that key through sooner, never refuse anyone wrongly.
    """

    def __init__(
        self,
        limit: int,
        window_seconds: float = 60.0,
        *,
        max_keys: int = DEFAULT_MAX_KEYS,
        clock: Callable[[], float] = time.monotonic,
    ):
        if limit < 1:
            raise ValueError("a rate limit allows at least one hit")
        self.limit = limit
        self.window = window_seconds
        self.max_keys = max_keys
        self._clock = clock
        self._hits: OrderedDict[str, deque[float]] = OrderedDict()

    def hit(self, key: str) -> float:
        """Count a hit for `key` if the limit allows it.

        0.0 when it was allowed (and counted); otherwise the seconds until
        it would be, which is what a Retry-After header should say. A
        refused hit is not counted, so a client that waits that long gets
        through.
        """
        now = self._clock()
        self._evict_idle(now)
        hits = self._hits.get(key)
        if hits is None:
            hits = self._hits[key] = deque()
            if len(self._hits) > self.max_keys:
                self._hits.popitem(last=False)
        cutoff = now - self.window
        while hits and hits[0] <= cutoff:
            hits.popleft()
        if len(hits) >= self.limit:
            return hits[0] + self.window - now
        hits.append(now)
        # Newest hit last: what keeps the idle sweep at the front.
        self._hits.move_to_end(key)
        return 0.0

    def allow(self, key: str) -> bool:
        return self.hit(key) == 0.0

    def _evict_idle(self, now: float) -> None:
        cutoff = now - self.window
        while self._hits:
            hits = next(iter(self._hits.values()))
            if hits and hits[-1] > cutoff:
                return
            self._hits.popitem(last=False)

    def __len__(self) -> int:
        return len(self._hits)

    def reset(self) -> None:
        self._hits.clear()


@dataclass(frozen=True)
class Limit:
    """A named limit: `count` hits per `window_seconds`, per key."""

    name: str
    count: int
    window_seconds: float


# --- The limits ------------------------------------------------------------
#
# Keyed by client address, the address is the one Caddy saw (uvicorn trusts
# its X-Forwarded-For, deploy/docker-compose.prod.yml). Behind Cloudflare
# that is an edge address many visitors share, so the per-address numbers
# are generous on purpose: they stop a script, not a busy office.

# /embed/v1/cues: unauthenticated, called once per sentence the browser
# voice speaks. Two a second per address is far beyond a person listening.
CUES_PER_CLIENT = Limit("cues-client", 120, 60)

# Signing in. Per address bounds a scripted guesser; per account bounds a
# distributed one aimed at one person (at the price that it can lock that
# person out for ten minutes, which is the usual trade).
LOGIN_PER_CLIENT = Limit("login-client", 30, 60)
LOGIN_PER_ACCOUNT = Limit("login-account", 10, 600)
# Accounts made from one address: a household or an office signs up a few
# people, a script signs up thousands.
REGISTER_PER_CLIENT = Limit("register-client", 20, 3600)
# Asking for reset mail, per address. The per-mailbox limit (RESET_LIMIT,
# below) is the one that protects an inbox; this one stops one client from
# cycling through other people's addresses.
FORGOT_PER_CLIENT = Limit("forgot-client", 10, 3600)
# Setting a new password from a link. A link is signed, so guessing them is
# hopeless; this bounds the password hashing a client can make the box do.
RESET_PER_CLIENT = Limit("reset-client", 20, 900)

# A visitor on a shared link is a person pressing Play, not a program. These
# are generous for the former and useless for the latter (api.share).
SHARE_PER_TOKEN = Limit("share-token", 30, 60)
SHARE_PER_CLIENT = Limit("share-client", 12, 60)


def embed_per_key() -> Limit:
    """Requests per API key per minute (EMBED_RATE_LIMIT_PER_MINUTE)."""
    return Limit("embed-key", get_settings().embed_rate_limit_per_minute, 60)


_limiters: dict[str, SlidingWindowRateLimiter] = {}


def limiter_for(limit: Limit) -> SlidingWindowRateLimiter:
    """The process-wide limiter enforcing `limit`."""
    existing = _limiters.get(limit.name)
    if existing is None:
        existing = _limiters[limit.name] = SlidingWindowRateLimiter(
            limit.count, limit.window_seconds
        )
    return existing


def enforce(
    limit: Limit,
    key: str,
    detail: str = "Too many requests — try again in a moment",
    code: str = "rate_limited",
) -> None:
    """Count a hit on `limit` for `key`, or raise 429 with Retry-After."""
    wait = limiter_for(limit).hit(key)
    if wait > 0:
        raise RateLimit429(
            detail, code=code, headers={"Retry-After": str(max(1, math.ceil(wait)))}
        )


def reset_rate_limiters() -> None:
    """Forget every in-memory limiter (tests: each starts from zero)."""
    _limiters.clear()


# Password-reset throttle: three an hour, enough for someone who mistypes or
# loses the first mail, far short of using the endpoint to bury an inbox.
# Keyed by address rather than by IP because the inbox is what gets hurt, and
# an attacker changes address far more easily than a victim changes mailbox.
RESET_LIMIT = 3
RESET_WINDOW_SECONDS = 3600


async def allow_persistent(
    db: AsyncSession, key: str, *, limit: int, window_seconds: int
) -> bool:
    """Sliding-window limit counted in the database.

    For limits where surviving a restart matters: the in-memory limiter
    reset on every deploy, and this project deploys many times a day, so
    "3 per hour" was really "3 per deploy". Low-traffic keys only — this
    costs a delete, a count and an insert per call.

    Rows the caller creates are committed by the caller's own transaction,
    which is the point: the hit and the action it gates land atomically.
    """
    cutoff = utcnow() - timedelta(seconds=window_seconds)
    # Purge this key's expired rows — keeps the table at worst a few rows per
    # active key without needing a background job.
    await db.execute(delete(RateHit).where(RateHit.key == key, RateHit.created_at < cutoff))
    hits = (
        await db.execute(
            select(func.count())
            .select_from(RateHit)
            .where(RateHit.key == key, RateHit.created_at >= cutoff)
        )
    ).scalar_one()
    if hits >= limit:
        return False
    db.add(RateHit(key=key))
    return True
