"""Persist how an avatar is framed, so the choice reaches embedded sites.

Framing used to be a dashboard-only view toggle, which meant every embed was
hard-wired to the face crop no matter what the owner had picked.

Revision ID: 010_avatar_framing
Revises: 009_original_image
"""

import sqlalchemy as sa
from alembic import op

revision = "010_avatar_framing"
down_revision = "009_original_image"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # server_default, not just a Python default: existing rows need a value,
    # and "face" is what they were already being rendered as.
    op.add_column(
        "avatars",
        sa.Column("framing", sa.String(8), nullable=False, server_default="face"),
    )


def downgrade() -> None:
    op.drop_column("avatars", "framing")
