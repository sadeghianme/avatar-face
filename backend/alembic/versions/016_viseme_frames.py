"""How many AI-generated mouth keyframes an avatar has.

Opt-in per avatar: the frames cost money to generate, so this counts what
was actually built rather than flagging an intention. Zero means the mouth
is drawn geometrically, which is every avatar until its owner asks.

Revision ID: 016_viseme_frames
Revises: 015_has_layers
"""

import sqlalchemy as sa
from alembic import op

revision = "016_viseme_frames"
down_revision = "015_has_layers"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "avatars",
        sa.Column("viseme_frames", sa.Integer(), nullable=False, server_default="0"),
    )


def downgrade() -> None:
    op.drop_column("avatars", "viseme_frames")
