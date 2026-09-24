"""Creations: the wizard's state, and the upload an avatar was made from.

A creation is a photo on its way to becoming an avatar (see
app.models.creation). It holds every image the wizard produced, the analysis,
the marks bound to the image they were placed on, and the last background
job's state, so the flow can be resumed after a reload and survive a deploy.

`avatars.upload_image_key` keeps the photo as the wizard received it (cleaned,
nothing else), separate from `original_image_key`, which is the photo before
its background came off and therefore may already be framed.

The consents table and `avatars.ai_edited` from the design belong to the AI
adjust milestone and arrive with it.

Revision ID: 023_creations
Revises: 022_mouth_config
"""

import sqlalchemy as sa
from alembic import op

revision = "023_creations"
down_revision = "022_mouth_config"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "creations",
        sa.Column("id", sa.String(length=32), primary_key=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "org_id",
            sa.String(length=32),
            sa.ForeignKey("organizations.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("created_by_id", sa.String(length=32), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("face_type", sa.String(length=16), nullable=True),
        sa.Column(
            "status",
            sa.Enum("draft", "finishing", "finished", "expired", name="creationstatus"),
            nullable=False,
        ),
        sa.Column("revision", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("steps", sa.JSON(), nullable=True),
        sa.Column("analysis", sa.JSON(), nullable=True),
        sa.Column("anchors", sa.JSON(), nullable=True),
        sa.Column("job", sa.JSON(), nullable=True),
        sa.Column("avatar_id", sa.String(length=32), nullable=True),
    )
    op.create_index(
        "ix_creations_org_status_updated", "creations", ["org_id", "status", "updated_at"]
    )
    op.add_column("avatars", sa.Column("upload_image_key", sa.String(length=255), nullable=True))


def downgrade() -> None:
    op.drop_column("avatars", "upload_image_key")
    op.drop_index("ix_creations_org_status_updated", table_name="creations")
    op.drop_table("creations")
    sa.Enum(name="creationstatus").drop(op.get_bind(), checkfirst=True)
