"""M2: organizations, memberships, invitations

Revision ID: 002_orgs
Revises: 001_users
"""
import sqlalchemy as sa
from alembic import op

revision = "002_orgs"
down_revision = "001_users"
branch_labels = None
depends_on = None

ROLE = sa.Enum("owner", "admin", "member", name="role")


def _common():
    return [
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    ]


def upgrade() -> None:
    op.create_table(
        "organizations",
        *_common(),
        sa.Column("name", sa.String(128), nullable=False),
    )
    op.create_table(
        "memberships",
        *_common(),
        sa.Column("user_id", sa.String(32), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("org_id", sa.String(32), sa.ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False),
        sa.Column("role", ROLE, nullable=False),
        sa.UniqueConstraint("user_id", "org_id", name="uq_membership_user_org"),
    )
    op.create_index("ix_memberships_user_id", "memberships", ["user_id"])
    op.create_index("ix_memberships_org_id", "memberships", ["org_id"])
    op.create_table(
        "invitations",
        *_common(),
        sa.Column("org_id", sa.String(32), sa.ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False),
        sa.Column("email", sa.String(255), nullable=False),
        sa.Column("role", ROLE, nullable=False),
        sa.Column("token", sa.String(64), nullable=False),
        sa.Column("invited_by_id", sa.String(32), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("accepted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_invitations_org_id", "invitations", ["org_id"])
    op.create_index("ix_invitations_token", "invitations", ["token"], unique=True)


def downgrade() -> None:
    op.drop_table("invitations")
    op.drop_table("memberships")
    op.drop_table("organizations")
    ROLE.drop(op.get_bind(), checkfirst=True)
