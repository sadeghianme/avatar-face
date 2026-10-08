"""The speech cache leaves the database: an index row per line, audio in storage.

`speech_cache` kept every line ever spoken as an inline WAV blob in the main
SQLite file, with nothing ever evicting it, and every deploy's backup copied
all of it. `speech_clips` is the index (services.tts.speech_cache): the
recording lives in storage as MP3 (`audio_key`), and lines are evicted least
recently used first.

Upgrade: the new table, then the old one emptied. Its lines are a cache, made
again on the next request, except a cloned voice's (provider "cloned"),
which were uploaded or rendered elsewhere and cannot be: those are copied
across with their recording still inline (`audio`), pinned, and attributed
to the organization their voice id names; the application moves them to
storage at startup (speech_cache.drain). The old table stays, empty, so the
release before this one can still be rolled back to; a later migration
drops it.

Re-runnable: rolling back to a release before this one means stamping the
database back to 027 first (docs/process.md, "Rollback"), and that release
writes to the old table; running this again then keeps the new table and
the lines in it, and carries over only what is new.

The file does not shrink by itself: SQLite keeps the freed pages and reuses
them. Backups are compact from now on (deploy/backup_db.py copies with
VACUUM INTO), and docs/process.md says how to compact the live file.

Downgrade: the lines whose recording is still inline go back to the old
table; those already moved to storage are dropped from the index (their
files stay under speech/ in storage).

Revision ID: 028_speech_clips
Revises: 027_scene
"""

import sqlalchemy as sa
from alembic import op

revision = "028_speech_clips"
down_revision = "027_scene"
branch_labels = None
depends_on = None


def upgrade() -> None:
    if not sa.inspect(op.get_bind()).has_table("speech_clips"):
        _create_speech_clips()
    _carry_over_cloned_lines()
    op.execute("DELETE FROM speech_cache")


def _create_speech_clips() -> None:
    op.create_table(
        "speech_clips",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("cache_key", sa.String(64), nullable=False),
        sa.Column("provider", sa.String(32), nullable=False),
        sa.Column("voice", sa.String(128), nullable=False),
        sa.Column("locale", sa.String(16), nullable=False),
        sa.Column("char_count", sa.Integer(), nullable=False),
        sa.Column("duration_ms", sa.Integer(), nullable=False),
        sa.Column("cues_json", sa.Text(), nullable=False),
        sa.Column("audio_mime", sa.String(64), nullable=False),
        sa.Column("audio_key", sa.String(255), nullable=True),
        sa.Column("audio", sa.LargeBinary(), nullable=True),
        sa.Column("size_bytes", sa.Integer(), nullable=False),
        sa.Column("org_id", sa.String(32), nullable=True),
        sa.Column("pinned", sa.Boolean(), nullable=False),
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_speech_clips_cache_key", "speech_clips", ["cache_key"], unique=True)
    op.create_index("ix_speech_clips_org_id", "speech_clips", ["org_id"])
    op.create_index(
        "ix_speech_clips_pinned_last_used", "speech_clips", ["pinned", "last_used_at"]
    )


def _carry_over_cloned_lines() -> None:
    """A cloned voice's lines, one at a time (each carries its recording), in
    plain SQLAlchemy so that Postgres runs it as SQLite does; a line already
    carried over is left as it is."""
    bind = op.get_bind()
    old = sa.table(
        "speech_cache",
        *(sa.column(name) for name in (
            "id", "created_at", "updated_at", "cache_key", "provider", "voice", "locale",
            "char_count", "audio_mime", "audio", "cues_json", "duration_ms",
        )),
    )
    new = sa.table(
        "speech_clips",
        *(sa.column(name) for name in (
            "id", "created_at", "updated_at", "cache_key", "provider", "voice", "locale",
            "char_count", "duration_ms", "cues_json", "audio_mime", "audio_key", "audio",
            "size_bytes", "org_id", "pinned", "last_used_at",
        )),
    )
    cloned = bind.execute(
        sa.select(old.c.id).where(
            old.c.provider == "cloned",
            old.c.cache_key.not_in(sa.select(new.c.cache_key)),
        )
    ).scalars().all()
    for line_id in cloned:
        line = bind.execute(sa.select(old).where(old.c.id == line_id)).mappings().one()
        # A cloned voice's id is "<org id>:<name>" (services.tts.cloned).
        org_id, sep, _ = line["voice"].partition(":")
        bind.execute(new.insert().values(
            id=line["id"], created_at=line["created_at"], updated_at=line["updated_at"],
            cache_key=line["cache_key"], provider=line["provider"], voice=line["voice"],
            locale=line["locale"], char_count=line["char_count"],
            duration_ms=line["duration_ms"], cues_json=line["cues_json"],
            audio_mime=line["audio_mime"], audio_key=None, audio=line["audio"],
            size_bytes=len(line["audio"]), org_id=org_id if sep and org_id else None,
            pinned=True, last_used_at=line["updated_at"],
        ))


def downgrade() -> None:
    op.execute(
        """
        INSERT INTO speech_cache (
            id, created_at, updated_at, cache_key, provider, voice, locale, char_count,
            audio_mime, audio, cues_json, duration_ms
        )
        SELECT
            id, created_at, updated_at, cache_key, provider, voice, locale, char_count,
            audio_mime, audio, cues_json, duration_ms
        FROM speech_clips
        WHERE audio IS NOT NULL
          AND cache_key NOT IN (SELECT cache_key FROM speech_cache)
        """
    )
    op.drop_index("ix_speech_clips_pinned_last_used", table_name="speech_clips")
    op.drop_index("ix_speech_clips_org_id", table_name="speech_clips")
    op.drop_index("ix_speech_clips_cache_key", table_name="speech_clips")
    op.drop_table("speech_clips")
