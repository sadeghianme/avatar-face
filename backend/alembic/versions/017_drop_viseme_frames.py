"""Drop viseme_frames: the AI mouth-keyframe approach is gone.

Crossfading between generated mouth photographs read as fast jumping between
discrete shapes rather than as speech, however the blending was weighted —
the keys are too far apart in appearance for a dissolve to bridge them. The
geometric mouth is the only mouth again.

Revision ID: 017_drop_viseme_frames
Revises: 016_viseme_frames
"""

import sqlalchemy as sa
from alembic import op

revision = "017_drop_viseme_frames"
down_revision = "016_viseme_frames"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_column("avatars", "viseme_frames")


def downgrade() -> None:
    op.add_column(
        "avatars",
        sa.Column("viseme_frames", sa.Integer(), nullable=False, server_default="0"),
    )
