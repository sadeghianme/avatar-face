"""One edit at a time per avatar.

An avatar's draft is a database row plus files rewritten in place (rig.json,
fit-base.json, source-crop.png, layers/*). An edit route reads the row,
rewrites the files, and commits the row last, with awaits in between: the
layer build alone waits seconds on the shared CPU thread (services.jobs).
Two edits of one avatar interleaving there read one another's half-done
state, e.g. a second crop taking the old image from the row and the already
moved rig.json from storage, moving the rig twice for one crop of the image.

The API is one process (see services.jobs), so an in-process lock per avatar
serializes them exactly. Callers take it BEFORE reading the row, so the
second edit starts from what the first committed. Moving to several
processes would need the same guarantee from the database instead.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager


class KeyedLock:
    """An asyncio.Lock per key, alive only while someone holds or waits on
    it, so a key edited once does not keep a lock forever."""

    def __init__(self) -> None:
        self._locks: dict[str, asyncio.Lock] = {}
        self._users: dict[str, int] = {}

    @asynccontextmanager
    async def hold(self, key: str) -> AsyncIterator[None]:
        lock = self._locks.setdefault(key, asyncio.Lock())
        self._users[key] = self._users.get(key, 0) + 1
        try:
            async with lock:
                yield
        finally:
            self._users[key] -= 1
            if not self._users[key]:
                del self._users[key]
                del self._locks[key]

    def __len__(self) -> int:
        """Keys with a lock alive (tests: nothing leaks)."""
        return len(self._locks)


avatar_edits = KeyedLock()
