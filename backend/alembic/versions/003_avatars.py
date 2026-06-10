"""M3: avatars

Revision ID: 003_avatars
Revises: 002_orgs
"""
import sqlalchemy as sa
from alembic import op

revision = "003_avatars"
down_revision = "002_orgs"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "avatars",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("org_id", sa.String(32), sa.ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False),
        sa.Column("created_by_id", sa.String(32), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("name", sa.String(128), nullable=False),
        sa.Column("status", sa.Enum("pending", "processing", "ready", "failed", name="avatarstatus"), nullable=False),
        sa.Column("content_type", sa.String(64), nullable=False),
        sa.Column("image_key", sa.String(255), nullable=True),
        sa.Column("rig_key", sa.String(255), nullable=True),
        sa.Column("thumbnail_key", sa.String(255), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
    )
    op.create_index("ix_avatars_org_id", "avatars", ["org_id"])


def downgrade() -> None:
    op.drop_table("avatars")
    sa.Enum(name="avatarstatus").drop(op.get_bind(), checkfirst=True)
