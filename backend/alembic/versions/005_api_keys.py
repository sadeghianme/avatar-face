"""M5: api keys

Revision ID: 005_api_keys
Revises: 004_speech_cache
"""
import sqlalchemy as sa
from alembic import op

revision = "005_api_keys"
down_revision = "004_speech_cache"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "api_keys",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("org_id", sa.String(32), sa.ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False),
        sa.Column("created_by_id", sa.String(32), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("name", sa.String(128), nullable=False),
        sa.Column("prefix", sa.String(12), nullable=False),
        sa.Column("key_hash", sa.String(64), nullable=False, unique=True),
        sa.Column("allowed_domains", sa.Text(), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_api_keys_org_id", "api_keys", ["org_id"])
    op.create_index("ix_api_keys_prefix", "api_keys", ["prefix"])


def downgrade() -> None:
    op.drop_table("api_keys")
