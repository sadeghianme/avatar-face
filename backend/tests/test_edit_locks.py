"""services.edit_locks: one edit at a time per avatar, and nothing kept."""

import asyncio

import pytest

from app.services.edit_locks import KeyedLock


async def test_one_holder_per_key_in_arrival_order():
    locks = KeyedLock()
    order: list[str] = []
    first_in = asyncio.Event()
    release_first = asyncio.Event()

    async def first():
        async with locks.hold("a"):
            order.append("first in")
            first_in.set()
            await release_first.wait()
            order.append("first out")

    async def second():
        await first_in.wait()
        async with locks.hold("a"):
            order.append("second in")

    tasks = [asyncio.create_task(first()), asyncio.create_task(second())]
    await first_in.wait()
    await asyncio.sleep(0.01)
    assert order == ["first in"]
    release_first.set()
    await asyncio.gather(*tasks)
    assert order == ["first in", "first out", "second in"]
    assert len(locks) == 0


async def test_different_keys_do_not_wait_for_each_other():
    locks = KeyedLock()
    async with locks.hold("a"):
        await asyncio.wait_for(_enter(locks, "b"), timeout=1)


async def _enter(locks: KeyedLock, key: str) -> None:
    async with locks.hold(key):
        pass


async def test_a_holder_that_fails_or_a_waiter_that_gives_up_leaves_nothing():
    locks = KeyedLock()
    with pytest.raises(RuntimeError):
        async with locks.hold("a"):
            raise RuntimeError("the edit failed")
    assert len(locks) == 0

    async with locks.hold("a"):
        waiter = asyncio.create_task(_enter(locks, "a"))
        await asyncio.sleep(0.01)
        waiter.cancel()
        with pytest.raises(asyncio.CancelledError):
            await waiter
    assert len(locks) == 0
    # And the key still works afterwards.
    await asyncio.wait_for(_enter(locks, "a"), timeout=1)
