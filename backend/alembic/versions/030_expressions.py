"""The avatar's AI expression pictures: the owner's choice and what was made.

`avatars.expressions`: JSON {ai, consent_id, consent_user_id, delivery,
kit, pending}, null for every avatar until its owner turns AI expressions on
(services.expressions). Null plays the animated expressions alone, exactly
as before. No backfill.

Re-runnable, as 029: rolling back to the release before this one means
stamping the database back to an older revision first (docs/process.md,
"Rollback"), and that release neither reads nor drops this column, so the
next deploy finds it there and keeps it (the choices and kits made before
the rollback come back with it).

Downgrade drops the column; the release before this one never reads it, and
the files it names (expr-*.webp/.json beside the avatar's other files) are
then nobody's (this release sweeps them at the next publish when it is
deployed again).

Revision ID: 030_expressions
Revises: 029_refresh_tokens
"""

import sqlalchemy as sa
from alembic import op

revision = "030_expressions"
down_revision = "029_refresh_tokens"
branch_labels = None
depends_on = None


def _has_column() -> bool:
    columns = sa.inspect(op.get_bind()).get_columns("avatars")
    return any(column["name"] == "expressions" for column in columns)


def upgrade() -> None:
    if _has_column():
        return
    with op.batch_alter_table("avatars") as batch:
        batch.add_column(sa.Column("expressions", sa.JSON(), nullable=True))


def downgrade() -> None:
    if not _has_column():
        return
    with op.batch_alter_table("avatars") as batch:
        batch.drop_column("expressions")
