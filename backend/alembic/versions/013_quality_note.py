"""Why a ready avatar may still look wrong.

Separate from `error`, which means the avatar failed. A face that is small,
cropped at the frame edge or turned away still produces a working avatar —
it just will not look its best, and the user can fix it if told.

Revision ID: 013_quality_note
Revises: 012_edit_history
"""

import sqlalchemy as sa
from alembic import op

revision = "013_quality_note"
down_revision = "012_edit_history"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("avatars", sa.Column("quality_note", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("avatars", "quality_note")
