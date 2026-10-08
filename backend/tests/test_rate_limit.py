"""The in-memory sliding-window limiter (services.rate_limit)."""

import pytest

from app.core.errors import RateLimit429
from app.services.rate_limit import (
    Limit,
    SlidingWindowRateLimiter,
    enforce,
    limiter_for,
    reset_rate_limiters,
)


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def test_allows_up_to_the_limit_then_refuses_with_the_wait():
    clock = Clock()
    limiter = SlidingWindowRateLimiter(3, 60, clock=clock)
    assert [limiter.hit("a") for _ in range(3)] == [0.0, 0.0, 0.0]
    clock.now += 10
    # The oldest hit leaves the window 50 seconds from now.
    assert limiter.hit("a") == pytest.approx(50.0)
    assert limiter.allow("b"), "keys are counted separately"


def test_a_refused_hit_is_not_counted():
    """Waiting the advertised time must be enough, however often the client
    knocked meanwhile."""
    clock = Clock()
    limiter = SlidingWindowRateLimiter(1, 60, clock=clock)
    assert limiter.allow("a")
    for _ in range(5):
        clock.now += 10
        assert not limiter.allow("a")
    clock.now += 10.5
    assert limiter.allow("a")


def test_idle_keys_are_evicted():
    """One entry per client address forever was the leak: a key with no hit
    inside the window must not be kept."""
    clock = Clock()
    limiter = SlidingWindowRateLimiter(5, 60, clock=clock)
    for i in range(100):
        limiter.allow(f"client-{i}")
    assert len(limiter) == 100
    clock.now += 61
    limiter.allow("someone-new")
    assert len(limiter) == 1


def test_a_key_still_in_its_window_survives_the_sweep():
    clock = Clock()
    limiter = SlidingWindowRateLimiter(2, 60, clock=clock)
    limiter.allow("old")
    clock.now += 30
    limiter.allow("recent")
    clock.now += 31  # "old" is idle now, "recent" is not
    limiter.allow("third")
    assert len(limiter) == 2
    limiter.allow("recent")
    assert not limiter.allow("recent"), "its hit from 31s ago still counts"


def test_memory_is_bounded_under_a_flood_of_distinct_keys():
    clock = Clock()
    limiter = SlidingWindowRateLimiter(1, 60, max_keys=50, clock=clock)
    for i in range(10_000):
        limiter.allow(f"client-{i}")
        clock.now += 0.001
    assert len(limiter) == 50
    # The most recent keys are the ones kept (and still counted)...
    assert not limiter.allow("client-9999")
    # ...the oldest were forgotten.
    assert limiter.allow("client-0")
    assert len(limiter) == 50


def test_the_least_recently_hit_key_is_the_one_forgotten():
    clock = Clock()
    limiter = SlidingWindowRateLimiter(1, 60, max_keys=2, clock=clock)
    limiter.allow("a")
    clock.now += 1
    limiter.allow("b")
    clock.now += 1
    limiter.allow("c")  # evicts "a"
    assert limiter.allow("a"), "a was forgotten, so it is let through"
    assert not limiter.allow("c"), "c is still counted"


def test_a_limit_must_allow_something():
    with pytest.raises(ValueError):
        SlidingWindowRateLimiter(0, 60)


def test_enforce_raises_429_with_retry_after():
    reset_rate_limiters()
    limit = Limit("test-enforce", 1, 30)
    enforce(limit, "k")
    with pytest.raises(RateLimit429) as refused:
        enforce(limit, "k", code="slow_down")
    assert refused.value.code == "slow_down"
    retry_after = int(refused.value.headers["Retry-After"])
    assert 1 <= retry_after <= 30
    reset_rate_limiters()


def test_limiters_are_shared_by_name_and_reset_together():
    reset_rate_limiters()
    limit = Limit("test-shared", 1, 60)
    assert limiter_for(limit) is limiter_for(limit)
    assert limiter_for(limit).allow("k")
    assert not limiter_for(limit).allow("k")
    reset_rate_limiters()
    assert limiter_for(limit).allow("k")
    reset_rate_limiters()
