"""A public share page per avatar.

Null means not shared, which is the default and stays the default: an avatar
becomes reachable without a login only when its owner asks.

Revision ID: 018_share_token
Revises: 017_drop_viseme_frames
"""

import sqlalchemy as sa
from alembic import op

revision = "018_share_token"
down_revision = "017_drop_viseme_frames"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("avatars", sa.Column("share_token", sa.String(length=32), nullable=True))
    op.create_index("ix_avatars_share_token", "avatars", ["share_token"], unique=True)


def downgrade() -> None:
    op.drop_index("ix_avatars_share_token", table_name="avatars")
    op.drop_column("avatars", "share_token")
