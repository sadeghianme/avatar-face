"""3D avatars: avatar.kind

Revision ID: 008_avatar_kind
Revises: 007_provider_credentials
"""
import sqlalchemy as sa
from alembic import op

revision = "008_avatar_kind"
down_revision = "007_provider_credentials"
branch_labels = None
depends_on = None


def upgrade() -> None:
    kind = sa.Enum("photo", "model3d", name="avatarkind")
    kind.create(op.get_bind(), checkfirst=True)
    op.add_column(
        "avatars",
        sa.Column("kind", kind, nullable=False, server_default="photo"),
    )


def downgrade() -> None:
    op.drop_column("avatars", "kind")
    sa.Enum(name="avatarkind").drop(op.get_bind(), checkfirst=True)
