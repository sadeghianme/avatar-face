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


def test_024_upgrades_and_downgrades(tmp_path):
    """Consents, the org switch (on for every existing org), disclosure and
    the creation's AI state; and back out without touching 023's tables."""
    database = tmp_path / "migrate.sqlite3"
    _alembic(database, "upgrade", "023_creations")
    with closing(sqlite3.connect(database)) as db:
        db.execute(
            "insert into organizations (id, name, created_at, updated_at) "
            "values ('o1', 'Old', '2026-01-01', '2026-01-01')"
        )
        db.commit()

    _alembic(database, "upgrade", "head")
    assert {
        "id", "created_at", "org_id", "user_id", "scope", "providers", "text_version", "ip_hash",
        "subject_id",
    } == _columns(database, "consents")
    assert "ix_consents_org_user_scope" in _indexes(database, "consents")
    assert {"ai_edited", "consent_ids"} <= _columns(database, "avatars")
    assert {"consent_ids", "ai_usage"} <= _columns(database, "creations")
    with closing(sqlite3.connect(database)) as db:
        (enabled,) = db.execute(
            "select third_party_ai_enabled from organizations where id = 'o1'"
        ).fetchone()
    assert enabled == 1, "existing organizations keep the AI steps they have"

    _alembic(database, "downgrade", "023_creations")
    assert _columns(database, "consents") == set()
    assert "third_party_ai_enabled" not in _columns(database, "organizations")
    assert not {"ai_edited", "consent_ids"} & _columns(database, "avatars")
    assert not {"consent_ids", "ai_usage"} & _columns(database, "creations")
    assert "steps" in _columns(database, "creations")

    _alembic(database, "upgrade", "head")
    assert "ai_usage" in _columns(database, "creations")


def test_025_binds_statements_to_a_creation_and_back(tmp_path):
    """subject_id arrives on consents made under 024 (null: they were not
    about one creation) and leaves again without touching the rest."""
    database = tmp_path / "migrate.sqlite3"
    _alembic(database, "upgrade", "024_consent_ai_adjust")
    assert "subject_id" not in _columns(database, "consents")
    with closing(sqlite3.connect(database)) as db:
        db.execute(
            "insert into organizations (id, name, created_at, updated_at) "
            "values ('o1', 'Old', '2026-01-01', '2026-01-01')"
        )
        db.execute(
            "insert into users (id, email, username, password_hash, display_name, created_at, "
            "updated_at) "
            "values ('u1', 'a@b.c', 'a', 'x', '', '2026-01-01', '2026-01-01')"
        )
        db.execute(
            "insert into consents (id, created_at, org_id, user_id, scope, providers, "
            "text_version) values ('c1', '2026-09-25', 'o1', 'u1', 'depiction', '[]', "
            "'2026-09-25')"
        )
        db.commit()

    _alembic(database, "upgrade", "head")
    assert "subject_id" in _columns(database, "consents")
    with closing(sqlite3.connect(database)) as db:
        assert db.execute("select subject_id from consents where id = 'c1'").fetchone() == (None,)

    _alembic(database, "downgrade", "024_consent_ai_adjust")
    assert "subject_id" not in _columns(database, "consents")
    with closing(sqlite3.connect(database)) as db:
        assert db.execute("select scope from consents where id = 'c1'").fetchone() == ("depiction",)


def test_026_personal_org_is_unique_per_user(tmp_path):
    database = tmp_path / "migrate.sqlite3"
    _alembic(database, "upgrade", "025_consent_subject")
    assert "personal_owner_id" not in _columns(database, "organizations")
    with closing(sqlite3.connect(database)) as db:
        db.execute(
            "insert into organizations (id, name, created_at, updated_at) "
            "values ('o1', 'Old', '2026-01-01', '2026-01-01')"
        )
        db.commit()
    _alembic(database, "upgrade", "head")
    assert "personal_owner_id" in _columns(database, "organizations")
    with closing(sqlite3.connect(database)) as db:
        assert db.execute("select personal_owner_id from organizations").fetchone() == (None,)
        for org_id in ("o2", "o3"):  # several without one are fine
            db.execute(
                "insert into organizations (id, name, created_at, updated_at) "
                f"values ('{org_id}', 'N', '2026-01-01', '2026-01-01')"
            )
        db.execute("update organizations set personal_owner_id = 'u1' where id = 'o2'")
        try:
            db.execute("update organizations set personal_owner_id = 'u1' where id = 'o3'")
            raise AssertionError("a second personal organization for one user was accepted")
        except sqlite3.IntegrityError:
            pass
    _alembic(database, "downgrade", "025_consent_subject")
    assert "personal_owner_id" not in _columns(database, "organizations")
