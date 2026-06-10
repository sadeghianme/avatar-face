"""M4: speech cache

Revision ID: 004_speech_cache
Revises: 003_avatars
"""
import sqlalchemy as sa
from alembic import op

revision = "004_speech_cache"
down_revision = "003_avatars"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "speech_cache",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("cache_key", sa.String(64), nullable=False),
        sa.Column("provider", sa.String(32), nullable=False),
        sa.Column("voice", sa.String(128), nullable=False),
        sa.Column("locale", sa.String(16), nullable=False),
        sa.Column("char_count", sa.Integer(), nullable=False),
        sa.Column("audio_mime", sa.String(64), nullable=False),
        sa.Column("audio", sa.LargeBinary(), nullable=False),
        sa.Column("cues_json", sa.Text(), nullable=False),
        sa.Column("duration_ms", sa.Integer(), nullable=False),
    )
    op.create_index("ix_speech_cache_cache_key", "speech_cache", ["cache_key"], unique=True)


def downgrade() -> None:
    op.drop_table("speech_cache")
