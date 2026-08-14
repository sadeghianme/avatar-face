"""Whether an avatar has a background/body/head layer decomposition.

Layered avatars are how the embed stops tearing a single flat photo when the
head moves: real content exists behind the head and body. The flag lives on
the row so serving an embed does not need a storage existence check.

Revision ID: 015_has_layers
Revises: 014_rate_hits
"""

import sqlalchemy as sa
from alembic import op

revision = "015_has_layers"
down_revision = "014_rate_hits"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "avatars",
        sa.Column("has_layers", sa.Boolean(), nullable=False, server_default=sa.false()),
    )


def downgrade() -> None:
    op.drop_column("avatars", "has_layers")
