"""Persistent hits for the password-reset rate limit.

The in-memory limiter reset on every deploy — and this project deploys many
times a day, so the 3-per-hour throttle was closer to 3-per-deploy. Rows are
cheap (one per reset request) and purged as they age out of the window.

Revision ID: 014_rate_hits
Revises: 013_quality_note
"""

import sqlalchemy as sa
from alembic import op

revision = "014_rate_hits"
down_revision = "013_quality_note"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "rate_hits",
        sa.Column("id", sa.String(length=32), nullable=False),
        sa.Column("key", sa.String(length=320), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_rate_hits_key_created", "rate_hits", ["key", "created_at"])


def downgrade() -> None:
    op.drop_index("ix_rate_hits_key_created", table_name="rate_hits")
    op.drop_table("rate_hits")
