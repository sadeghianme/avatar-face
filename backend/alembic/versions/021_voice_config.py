"""The avatar's voice, as a draft/published property.

Until now the voice lived only in the embed snippet's data attributes: the
owner picked one while testing, the snippet froze it, and changing it later
reached nobody. Storing it on the avatar puts voice through the same
publish flow as framing — change it, see the Publish bar, publish, and
every embedding site and share link speaks with the new voice.

Revision ID: 021_voice_config
Revises: 020_publishing
"""

import sqlalchemy as sa
from alembic import op

revision = "021_voice_config"
down_revision = "020_publishing"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # One JSON column, not three: provider/voice/locale only ever change
    # together, and a partial update of the trio is never meaningful.
    op.add_column("avatars", sa.Column("voice_config", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("avatars", "voice_config")
