"""Consent, AI adjust and disclosure (milestone 4 of docs/avatar-lines.md).

- `consents`: append-only statements (third-party AI, depiction), each with
  the wording version it was made under and a keyed hash of the address,
  never the address itself.
- `organizations.third_party_ai_enabled`: the org-wide switch; on for every
  existing organization, which keeps the AI steps they have today.
- `avatars.ai_edited`: {mode, model} when an AI made or changed the picture;
  null for every existing avatar (nothing before this recorded it, and a
  guess would be a false disclosure either way).
- `avatars.consent_ids`, `creations.consent_ids`: the consents relied on.
- `creations.ai_usage`: per-creation AI budget, last adjust round, and the
  point finder's cache.

Revision ID: 024_consent_ai_adjust
Revises: 023_creations
"""

import sqlalchemy as sa
from alembic import op

revision = "024_consent_ai_adjust"
down_revision = "023_creations"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "consents",
        sa.Column("id", sa.String(length=32), primary_key=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "org_id",
            sa.String(length=32),
            sa.ForeignKey("organizations.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "user_id",
            sa.String(length=32),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("scope", sa.String(length=32), nullable=False),
        sa.Column("providers", sa.JSON(), nullable=False),
        sa.Column("text_version", sa.String(length=32), nullable=False),
        sa.Column("ip_hash", sa.String(length=64), nullable=True),
    )
    op.create_index("ix_consents_org_user_scope", "consents", ["org_id", "user_id", "scope"])
    op.add_column(
        "organizations",
        sa.Column(
            "third_party_ai_enabled", sa.Boolean(), nullable=False, server_default=sa.true()
        ),
    )
    op.add_column("avatars", sa.Column("ai_edited", sa.JSON(), nullable=True))
    op.add_column("avatars", sa.Column("consent_ids", sa.JSON(), nullable=True))
    op.add_column("creations", sa.Column("consent_ids", sa.JSON(), nullable=True))
    op.add_column("creations", sa.Column("ai_usage", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("creations", "ai_usage")
    op.drop_column("creations", "consent_ids")
    op.drop_column("avatars", "consent_ids")
    op.drop_column("avatars", "ai_edited")
    op.drop_column("organizations", "third_party_ai_enabled")
    op.drop_index("ix_consents_org_user_scope", table_name="consents")
    op.drop_table("consents")
