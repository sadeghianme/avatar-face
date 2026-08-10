"""An undo stack for avatar edits.

Replaces one reset button per feature with a single history. Each entry is a
snapshot of the editable state taken before a change, so undo does not need to
know how to invert any particular operation.

Revision ID: 012_edit_history
Revises: 011_precrop_image
"""

import sqlalchemy as sa
from alembic import op

revision = "012_edit_history"
down_revision = "011_precrop_image"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # JSON as text: the only access pattern is push and pop of the whole list,
    # so a real JSON column would buy nothing SQLite would honour anyway.
    op.add_column("avatars", sa.Column("edit_history", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("avatars", "edit_history")
