"""Draft/published split for avatars.

Every existing avatar is backfilled as published at revision 0, pointing at
the keys that are live right now, so the sixteen avatars already embedded on
customer sites keep serving exactly what they served before this ran. The
first real publish replaces those pointers with immutable copies.

No file I/O here on purpose: a migration that copies storage objects can
fail halfway with no way back.

Revision ID: 020_publishing
Revises: 019_face_type
"""

import json

import sqlalchemy as sa
from alembic import op

revision = "020_publishing"
down_revision = "019_face_type"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "avatars",
        sa.Column("draft_revision", sa.Integer(), nullable=False, server_default="0"),
    )
    op.add_column("avatars", sa.Column("published_config", sa.Text(), nullable=True))

    avatars = sa.table(
        "avatars",
        sa.column("id", sa.String),
        sa.column("status", sa.String),
        sa.column("framing", sa.String),
        sa.column("face_type", sa.String),
        sa.column("image_key", sa.String),
        sa.column("rig_key", sa.String),
        sa.column("thumbnail_key", sa.String),
        sa.column("has_layers", sa.Boolean),
        sa.column("org_id", sa.String),
        sa.column("published_config", sa.Text),
    )
    connection = op.get_bind()
    rows = connection.execute(
        sa.select(
            avatars.c.id,
            avatars.c.org_id,
            avatars.c.framing,
            avatars.c.face_type,
            avatars.c.image_key,
            avatars.c.rig_key,
            avatars.c.thumbnail_key,
            avatars.c.has_layers,
        ).where(avatars.c.status == "ready", avatars.c.image_key.is_not(None))
    ).fetchall()

    for row in rows:
        layer_keys = None
        if row.has_layers:
            base = f"orgs/{row.org_id}/avatars/{row.id}/layers"
            layer_keys = {
                "background": f"{base}/background.jpg",
                "body": f"{base}/body.png",
                "head": f"{base}/head.png",
            }
        config = {
            "revision": 0,
            "framing": row.framing,
            "face_type": row.face_type,
            "image_key": row.image_key,
            "rig_key": row.rig_key,
            "thumbnail_key": row.thumbnail_key,
            "layer_keys": layer_keys,
            "published_at": None,  # backfilled, never explicitly published
        }
        connection.execute(
            avatars.update()
            .where(avatars.c.id == row.id)
            .values(published_config=json.dumps(config))
        )


def downgrade() -> None:
    op.drop_column("avatars", "published_config")
    op.drop_column("avatars", "draft_revision")
