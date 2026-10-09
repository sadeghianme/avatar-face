"""Dashboard sessions the server can end: one row per refresh token.

Until now a refresh token was a JWT that lived 30 days whatever happened:
signing out only forgot it in the browser, and a password reset left every
copy working. `refresh_tokens` holds each token's SHA-256 (never the token),
its session (`family_id`), when it expires, when it was exchanged for the
next one, and when and why it was revoked (services.sessions). The token
itself travels only in an httpOnly cookie.

No data moves. The stateless refresh tokens issued before this have no row,
so they are refused, and the access tokens issued before it carry no
session: everyone signed in is signed out once, at the deploy that brings
this, and signs in again. Honouring the old tokens would have kept alive
exactly the credentials this exists to make revocable.

Re-runnable: rolling back to the release before this one means stamping the
database back to 028 first (docs/process.md, "Rollback"), and that release
neither reads this table nor revokes anything in it (a password reset there
leaves every session here open). So when the next deploy runs this again,
the sessions from before the rollback are deleted, not trusted: everyone
signs in once more, as at the first deploy.

Downgrade drops the table; the release before this one never reads it (and
does not read the new cookie either: its users sign in again too).

Revision ID: 029_refresh_tokens
Revises: 028_speech_clips
"""

import sqlalchemy as sa
from alembic import op

revision = "029_refresh_tokens"
down_revision = "028_speech_clips"
branch_labels = None
depends_on = None


def upgrade() -> None:
    if sa.inspect(op.get_bind()).has_table("refresh_tokens"):
        op.execute("DELETE FROM refresh_tokens")
        return
    op.create_table(
        "refresh_tokens",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "user_id",
            sa.String(32),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("family_id", sa.String(32), nullable=False),
        sa.Column("token_hash", sa.String(64), nullable=False, unique=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked_reason", sa.String(32), nullable=True),
        sa.Column("user_agent", sa.String(255), nullable=False),
        sa.Column("ip_hash", sa.String(64), nullable=True),
    )
    op.create_index("ix_refresh_tokens_user_id", "refresh_tokens", ["user_id"])
    op.create_index("ix_refresh_tokens_family_id", "refresh_tokens", ["family_id"])
    op.create_index("ix_refresh_tokens_expires_at", "refresh_tokens", ["expires_at"])


def downgrade() -> None:
    op.drop_index("ix_refresh_tokens_expires_at", table_name="refresh_tokens")
    op.drop_index("ix_refresh_tokens_family_id", table_name="refresh_tokens")
    op.drop_index("ix_refresh_tokens_user_id", table_name="refresh_tokens")
    op.drop_table("refresh_tokens")
