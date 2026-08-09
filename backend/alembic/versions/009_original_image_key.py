"""Remember the pre-cut-out photo so background removal can be undone.

Revision ID: 009_original_image
Revises: 008_avatar_kind
"""

import sqlalchemy as sa
from alembic import op

revision = "009_original_image"
down_revision = "008_avatar_kind"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Null means "the current image IS the original" — background removal has
    # either not been run, or has been undone.
    op.add_column("avatars", sa.Column("original_image_key", sa.String(255), nullable=True))


def downgrade() -> None:
    op.drop_column("avatars", "original_image_key")
