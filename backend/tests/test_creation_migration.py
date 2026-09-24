"""Migration 023 applies to a database built by the earlier ones, and
comes back out cleanly.

Run in a subprocess: alembic's env runs its own event loop and reconfigures
logging from alembic.ini, neither of which belongs inside the test process.
"""

import sqlite3
import subprocess
import sys
from contextlib import closing
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]

SCRIPT = """
import sys
from alembic import command
from alembic.config import Config
cfg = Config("alembic.ini")
command.{action}(cfg, "{target}")
"""


def _alembic(database: Path, action: str, target: str) -> None:
    import os

    env = {**os.environ, "DATABASE_URL": f"sqlite+aiosqlite:///{database}"}
    result = subprocess.run(
        [sys.executable, "-c", SCRIPT.format(action=action, target=target)],
        cwd=BACKEND, env=env, capture_output=True, text=True,
    )
    assert result.returncode == 0, result.stderr[-3000:]


def _columns(database: Path, table: str) -> set[str]:
    with closing(sqlite3.connect(database)) as db:
        return {row[1] for row in db.execute(f"pragma table_info({table})")}


def _indexes(database: Path, table: str) -> set[str]:
    with closing(sqlite3.connect(database)) as db:
        return {row[1] for row in db.execute(f"pragma index_list({table})")}


def test_023_upgrades_and_downgrades(tmp_path):
    database = tmp_path / "migrate.sqlite3"
    _alembic(database, "upgrade", "head")
    assert {
        "id", "org_id", "created_by_id", "face_type", "status", "revision", "steps",
        "analysis", "anchors", "job", "avatar_id", "created_at", "updated_at",
    } <= _columns(database, "creations")
    assert "ix_creations_org_status_updated" in _indexes(database, "creations")
    assert "upload_image_key" in _columns(database, "avatars")

    _alembic(database, "downgrade", "022_mouth_config")
    assert _columns(database, "creations") == set()
    assert "upload_image_key" not in _columns(database, "avatars")
    assert "mouth_config" in _columns(database, "avatars")

    _alembic(database, "upgrade", "head")
    assert "upload_image_key" in _columns(database, "avatars")
