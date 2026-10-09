"""Async engine and session factory."""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any, cast

from sqlalchemy import CursorResult, Executable, event
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.core.config import get_settings

_engine: AsyncEngine | None = None
_session_factory: async_sessionmaker[AsyncSession] | None = None


def _tune_sqlite(dbapi_connection, _record) -> None:
    """WAL and a busy timeout, on every new SQLite connection.

    The default rollback journal locks the whole file for a write, so a
    visitor's embed read and a background rig job's commit collide, and the
    loser fails at once with "database is locked". WAL lets reads proceed
    beside a write; the timeout makes a second writer wait its turn instead
    of failing.
    """
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.execute("PRAGMA busy_timeout=5000")
    cursor.close()


def get_engine() -> AsyncEngine:
    global _engine, _session_factory
    if _engine is None:
        _engine = create_async_engine(get_settings().database_url, future=True)
        if _engine.dialect.name == "sqlite":
            event.listen(_engine.sync_engine, "connect", _tune_sqlite)
        _session_factory = async_sessionmaker(_engine, expire_on_commit=False)
    return _engine


def get_session_factory() -> async_sessionmaker[AsyncSession]:
    get_engine()
    assert _session_factory is not None
    return _session_factory


async def get_db() -> AsyncIterator[AsyncSession]:
    async with get_session_factory()() as session:
        yield session


async def execute_dml(db: AsyncSession, statement: Executable) -> int:
    """Run an UPDATE or DELETE and return how many rows it matched.

    The count is what the conditional writes here are about (a revision or a
    status as read: 0 means someone else got there first). AsyncSession
    types execute() as a plain Result; for DML it is a CursorResult, which is
    what carries the count."""
    result = await db.execute(statement)
    return cast("CursorResult[Any]", result).rowcount


def reset_engine() -> None:
    """Drop the cached engine (used by tests when settings change)."""
    global _engine, _session_factory
    _engine = None
    _session_factory = None
