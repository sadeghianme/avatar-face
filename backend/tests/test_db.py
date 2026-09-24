"""SQLite connection settings, and the deploy backup they make necessary."""

import shutil
import sqlite3
import subprocess
import sys
from contextlib import closing
from pathlib import Path

from sqlalchemy import text

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


def test_the_deploy_backup_refuses_a_missing_database(tmp_path):
    """sqlite3 would create the file and back up an empty database."""
    target = tmp_path / "backup.sqlite3"
    result = subprocess.run(
        [sys.executable, str(BACKUP_SCRIPT), str(tmp_path / "typo.sqlite3"), str(target)],
        capture_output=True, text=True,
    )
    assert result.returncode != 0 and "no database" in result.stderr
    assert not target.exists()
