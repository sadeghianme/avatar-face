"""Which mouth an avatar speaks with, as a draft/published property.

The original engine draws a mouth interior: a dark crescent and a tooth
strip. The continuous mouth replaces it with photographic oral detail and
motion retargeted from authored poses, optionally using the person's own
teeth from a second photo. It was proven in the lab on previews that were
lost on reload and could not be published; this column is what lets it be
chosen for a real avatar and travel through the same publish flow as
framing and voice.

Null means the classic mouth, so every existing avatar is untouched.

Revision ID: 022_mouth_config
Revises: 021_voice_config
"""

import sqlalchemy as sa
from alembic import op

revision = "022_mouth_config"
down_revision = "021_voice_config"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # One JSON column: renderer, fit profile and the mouth-photo keys only
    # make sense together.
    op.add_column("avatars", sa.Column("mouth_config", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("avatars", "mouth_config")
