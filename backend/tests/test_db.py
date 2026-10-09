"""SQLite connection settings, and the deploy backup they make necessary."""

import shutil
import sqlite3
import subprocess
import sys
from contextlib import closing
from pathlib import Path

from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from app import main
from app.core.config import get_settings
from app.db import get_engine, reset_engine


async def test_every_sqlite_connection_is_in_wal_with_a_busy_timeout(tmp_path, monkeypatch):
    """WAL lets visitors' reads run beside a background job's write; the
    timeout makes a second writer wait instead of failing on the spot."""
    monkeypatch.setattr(
        get_settings(), "database_url", f"sqlite+aiosqlite:///{tmp_path / 'wal.sqlite3'}"
    )
    reset_engine()
    engine = get_engine()
    try:
        async with engine.connect() as conn:
            assert (await conn.execute(text("PRAGMA journal_mode"))).scalar() == "wal"
            assert (await conn.execute(text("PRAGMA busy_timeout"))).scalar() == 5000
    finally:
        await engine.dispose()
        reset_engine()


BACKUP_SCRIPT = Path(__file__).resolve().parents[2] / "deploy" / "backup_db.py"
BACKEND_DIR = Path(__file__).resolve().parents[1]


def _rows(path: Path) -> int:
    with closing(sqlite3.connect(path)) as db:
        return db.execute("select count(*) from t").fetchone()[0]


def test_the_deploy_backup_holds_commits_still_in_the_wal(tmp_path):
    """In WAL mode a commit reaches the main file only at a checkpoint, and
    the API holds its connections open, so copying the main file loses
    recent commits. The deploy backup must not."""
    live = tmp_path / "live.sqlite3"
    with closing(sqlite3.connect(live)) as api:  # stays open, as the API's pool does
        api.execute("PRAGMA journal_mode=WAL")
        api.execute("PRAGMA wal_autocheckpoint=0")
        api.execute("create table t (n integer)")
        api.executemany("insert into t values (?)", [(n,) for n in range(50)])
        api.commit()

        copied = tmp_path / "copied.sqlite3"
        shutil.copy(live, copied)
        with closing(sqlite3.connect(copied)) as db:
            tables = db.execute("select name from sqlite_master").fetchall()
        assert tables == [], "the premise: a plain copy misses what is in the WAL"

        backup = tmp_path / "backup.sqlite3"
        subprocess.run([sys.executable, str(BACKUP_SCRIPT), str(live), str(backup)], check=True)
        assert _rows(backup) == 50


def test_the_deploy_backup_leaves_free_pages_behind(tmp_path):
    """SQLite keeps the pages a delete frees (the speech cache's audio, after
    migration 028); a page-for-page copy carried them into every backup."""
    live = tmp_path / "live.sqlite3"
    with closing(sqlite3.connect(live)) as api:
        api.execute("PRAGMA journal_mode=WAL")
        api.execute("create table t (n integer, blob blob)")
        api.executemany("insert into t values (?, ?)", [(n, bytes(50_000)) for n in range(100)])
        api.commit()
        api.execute("delete from t where n >= 10")
        api.commit()
        api.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        assert live.stat().st_size > 4_000_000, "the premise: the live file keeps its pages"

        backup = tmp_path / "backup.sqlite3"
        subprocess.run([sys.executable, str(BACKUP_SCRIPT), str(live), str(backup)], check=True)
    assert _rows(backup) == 10
    assert backup.stat().st_size < 1_000_000


def test_the_deploy_backup_never_overwrites_a_file(tmp_path):
    live, backup = tmp_path / "live.sqlite3", tmp_path / "backup.sqlite3"
    with closing(sqlite3.connect(live)) as db:
        db.execute("create table t (n integer)")
    backup.write_bytes(b"precious")
    result = subprocess.run(
        [sys.executable, str(BACKUP_SCRIPT), str(live), str(backup)],
        capture_output=True,
        text=True,
    )
    assert result.returncode != 0 and "already exists" in result.stderr
    assert backup.read_bytes() == b"precious"


def test_the_deploy_backup_refuses_a_missing_database(tmp_path):
    """sqlite3 would create the file and back up an empty database."""
    target = tmp_path / "backup.sqlite3"
    result = subprocess.run(
        [sys.executable, str(BACKUP_SCRIPT), str(tmp_path / "typo.sqlite3"), str(target)],
        capture_output=True,
        text=True,
    )
    assert result.returncode != 0 and "no database" in result.stderr
    assert not target.exists()


def _upgrade_to_head(database: Path) -> None:
    """In a subprocess: alembic's env runs its own event loop."""
    import os

    env = {**os.environ, "DATABASE_URL": f"sqlite+aiosqlite:///{database}"}
    script = (
        "from alembic import command; from alembic.config import Config; "
        "command.upgrade(Config('alembic.ini'), 'head')"
    )
    subprocess.run(
        [sys.executable, "-c", script], cwd=BACKEND_DIR, env=env, check=True, capture_output=True
    )


async def test_a_database_a_newer_release_migrated_is_served_as_it_is(tmp_path, caplog):
    """deploy.sh --rollback starts the older release on the database the
    newer one migrated: its migrations do not know that revision, and
    `alembic upgrade` failing on it kept the server from starting at all."""
    database = tmp_path / "newer.sqlite3"
    _upgrade_to_head(database)
    with closing(sqlite3.connect(database)) as db:
        db.execute("update alembic_version set version_num = '099_from_a_newer_release'")
        db.commit()
    engine = create_async_engine(f"sqlite+aiosqlite:///{database}")
    try:
        await main.ensure_schema(engine)
    finally:
        await engine.dispose()
    assert "does not know" in caplog.text
    with closing(sqlite3.connect(database)) as db:
        assert db.execute("select version_num from alembic_version").fetchone() == (
            "099_from_a_newer_release",
        )
