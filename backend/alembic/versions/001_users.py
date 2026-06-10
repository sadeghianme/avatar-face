"""M1: users

Revision ID: 001_users
Revises:
"""
import sqlalchemy as sa
from alembic import op

revision = "001_users"
down_revision = None
branch_labels = None
depends_on = None


def _common():
    return [
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    ]


def upgrade() -> None:
    op.create_table(
        "users",
        *_common(),
        sa.Column("email", sa.String(255), nullable=False),
        sa.Column("username", sa.String(64), nullable=False),
        sa.Column("password_hash", sa.String(255), nullable=False),
        sa.Column("display_name", sa.String(128), nullable=False),
    )
    op.create_index("ix_users_email", "users", ["email"], unique=True)
    op.create_index("ix_users_username", "users", ["username"], unique=True)


def downgrade() -> None:
    op.drop_table("users")
