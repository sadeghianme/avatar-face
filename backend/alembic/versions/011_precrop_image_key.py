"""Remember the pre-crop photo so cropping can be undone.

Revision ID: 011_precrop_image
Revises: 010_avatar_framing
"""

import sqlalchemy as sa
from alembic import op

revision = "011_precrop_image"
down_revision = "010_avatar_framing"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Null means the current image has never been cropped. Kept separate from
    # original_image_key, which tracks background removal: the two are
    # independent, and a single "the previous file" pointer would make undoing
    # one silently undo the other.
    op.add_column("avatars", sa.Column("precrop_image_key", sa.String(255), nullable=True))


def downgrade() -> None:
    op.drop_column("avatars", "precrop_image_key")
