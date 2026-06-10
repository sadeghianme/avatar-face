"""M6: usage events

Revision ID: 006_usage_events
Revises: 005_api_keys
"""
import sqlalchemy as sa
from alembic import op

revision = "006_usage_events"
down_revision = "005_api_keys"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "usage_events",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("org_id", sa.String(32), sa.ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False),
        sa.Column("kind", sa.String(32), nullable=False),
        sa.Column("provider", sa.String(32), nullable=False),
        sa.Column("char_count", sa.Integer(), nullable=False),
        sa.Column("cached", sa.Boolean(), nullable=False),
        sa.Column("source", sa.String(16), nullable=False),
    )
    op.create_index("ix_usage_events_org_id", "usage_events", ["org_id"])
    op.create_index("ix_usage_org_created", "usage_events", ["org_id", "created_at"])


def downgrade() -> None:
    op.drop_table("usage_events")
