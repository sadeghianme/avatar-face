"""One personal organization per user.

`organizations.personal_owner_id`: the user an organization is the automatic
personal one of, unique, so that two requests racing to make a new account's
organization cannot both succeed (POST /orgs with personal=true answers the
second with the first). Null for every organization made by hand and every
one that exists already.

Revision ID: 026_personal_org
Revises: 025_consent_subject
"""

import sqlalchemy as sa
from alembic import op

revision = "026_personal_org"
down_revision = "025_consent_subject"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("organizations") as batch:
        batch.add_column(sa.Column("personal_owner_id", sa.String(length=32), nullable=True))
        batch.create_unique_constraint("uq_organizations_personal_owner", ["personal_owner_id"])


def downgrade() -> None:
    with op.batch_alter_table("organizations") as batch:
        batch.drop_constraint("uq_organizations_personal_owner", type_="unique")
        batch.drop_column("personal_owner_id")
