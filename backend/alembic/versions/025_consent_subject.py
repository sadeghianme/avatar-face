"""A statement about a face names the creation it was made for.

`consents.subject_id`: for `depiction` ("I am this person or have their
permission, and they are 18 or older") and `generated_face` ("this face was
made by AI and is not a real person"), the creation the statement is about.
Such a statement is accepted for that creation only, so one made weeks ago
about someone else cannot stand behind a new avatar. Null for third-party AI
consents, which are about sending photos, not about one photo, and for any
statement recorded before this (none are accepted any more: finishing now
asks for one bound to the creation).

Revision ID: 025_consent_subject
Revises: 024_consent_ai_adjust
"""

import sqlalchemy as sa
from alembic import op

revision = "025_consent_subject"
down_revision = "024_consent_ai_adjust"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("consents") as batch:
        batch.add_column(sa.Column("subject_id", sa.String(length=32), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("consents") as batch:
        batch.drop_column("subject_id")
