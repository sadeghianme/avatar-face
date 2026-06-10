"""Enhancement: dashboard-managed provider credentials

Revision ID: 007_provider_credentials
Revises: 006_usage_events
"""
import sqlalchemy as sa
from alembic import op

revision = "007_provider_credentials"
down_revision = "006_usage_events"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "provider_credentials",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("name", sa.String(64), nullable=False),
        sa.Column("encrypted_value", sa.LargeBinary(), nullable=False),
    )
    op.create_index("ix_provider_credentials_name", "provider_credentials", ["name"], unique=True)


def downgrade() -> None:
    op.drop_table("provider_credentials")
