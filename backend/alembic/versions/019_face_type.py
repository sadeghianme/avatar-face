"""What kind of face this is: human, animal or cartoon.

Only two things read it: which viseme table the rig gets, and whether the
human-proportion quality checks apply. Everything already stored is human,
which is the default, so no existing avatar changes behaviour.

Revision ID: 019_face_type
Revises: 018_share_token
"""

import sqlalchemy as sa
from alembic import op

revision = "019_face_type"
down_revision = "018_share_token"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "avatars",
        sa.Column("face_type", sa.String(length=16), nullable=False, server_default="human"),
    )


def downgrade() -> None:
    op.drop_column("avatars", "face_type")
