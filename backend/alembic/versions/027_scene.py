"""The avatar's scene: zoom, pan and background.

`avatars.scene`: JSON {zoom, pan: {x, y}, background: {kind, color,
image_key}}, null for every avatar made before (services.scene reads the
`framing` column for those: face is zoom 1, full is zoom 0, no background).
No backfill: a null scene renders exactly as the framing did.

Revision ID: 027_scene
Revises: 026_personal_org
"""

import sqlalchemy as sa
from alembic import op

revision = "027_scene"
down_revision = "026_personal_org"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("avatars") as batch:
        batch.add_column(sa.Column("scene", sa.JSON(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("avatars") as batch:
        batch.drop_column("scene")
