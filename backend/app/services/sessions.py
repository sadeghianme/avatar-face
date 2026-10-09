"""Dashboard sessions: refresh tokens the server can revoke.

Signing in opens a session and issues two tokens. The access token is a JWT
of `access_token_minutes` (core.security) that the dashboard keeps in memory
and sends as a bearer header. The refresh token is 256 random bits that only
ever travel in an httpOnly cookie (api.auth); the database keeps its SHA-256
(models.RefreshToken), never the token.

Each refresh EXCHANGES the token: the one presented is spent, and the next
one of the same family (the session, `family_id`) takes its place, good for
`refresh_token_days` from now. A spent token presented again means the
session is in two hands, the user's and someone who copied a token: the
whole family is revoked, so both are signed out and the copy is worthless.

Except within `refresh_reuse_grace_seconds` of the exchange: then it is the
same browser asking twice, because its answer never arrived (the page was
reloaded or closed mid-request, the network dropped) or because two of its
tabs refreshed at once. It gets the same next token again, not a refusal:
the next token is derived from the one it replaces (`_successor`, an HMAC
with a server key), so it can be given again without ever being stored.
Nothing forks: there is still one live token per session. If that next token
has itself been exchanged already, the answer is `refresh_superseded`.

A session ends when its user signs out (that session), signs out
everywhere, or resets the password (every session), and each access token
dies with its session at once, not when it expires: api.deps checks the
session on every request (`session_user`).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import logging
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy import ColumnElement, delete, exists, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.errors import Auth401
from app.core.security import AccessClaims, create_access_token
from app.db import execute_dml, get_session_factory
from app.models import RefreshToken, User, new_id, utcnow

logger = logging.getLogger("liveface.auth")

TOKEN_PREFIX = "lfs_"
USER_AGENT_MAX = 255

# Domain separation for the address hash: the JWT secret signs tokens, and
# the same key must never produce a value that means something else (the
# consent record's address hash has a context of its own).
_IP_HASH_CONTEXT = b"liveface session ip v1:"
_SUCCESSOR_CONTEXT = b"liveface refresh successor v1:"


def hash_token(raw: str) -> str:
    """The stored form of a refresh token. A plain SHA-256: the token is 256
    random bits, so there is nothing to guess and nothing to slow down."""
    return hashlib.sha256(raw.encode()).hexdigest()


def ip_hash(ip: str | None) -> str | None:
    """A keyed SHA-256 of the address (HMAC with a server secret), or None.

    Keyed, because the IPv4 space is small enough to reverse a bare hash.
    It says only whether two refreshes came from the same address.
    """
    if not ip or ip == "unknown":
        return None
    key = _IP_HASH_CONTEXT + get_settings().jwt_secret.encode()
    return hmac.new(key, ip.encode(), hashlib.sha256).hexdigest()


@dataclass(frozen=True)
class Client:
    """Who is asking: the browser's User-Agent and its address
    (api.deps.client_address, through the proxies this server trusts)."""

    user_agent: str = ""
    ip: str | None = None


@dataclass(frozen=True)
class Issued:
    """A session's new tokens. `refresh_token` goes into the cookie and
    nowhere else."""

    access_token: str
    refresh_token: str
    session_id: str
    expires_in: int


def _aware(moment: datetime) -> datetime:
    # SQLite hands timestamps back without their zone; they are UTC.
    return moment if moment.tzinfo else moment.replace(tzinfo=UTC)


def _successor(raw: str) -> str:
    """The token that replaces `raw` when it is exchanged: an HMAC of it under
    a key of the server's, so the same exchange asked again gives the same
    token, and nobody without the key can tell what it will be."""
    key = hashlib.sha256(_SUCCESSOR_CONTEXT + get_settings().jwt_secret.encode()).digest()
    digest = hmac.new(key, raw.encode(), hashlib.sha256).digest()
    return TOKEN_PREFIX + base64.urlsafe_b64encode(digest).decode().rstrip("=")


def _new_token(
    user_id: str, family_id: str, client: Client, now: datetime, raw: str | None = None
) -> tuple[str, RefreshToken]:
    """A token row: `raw` given (a successor), or 256 random bits (a sign-in)."""
    raw = raw or TOKEN_PREFIX + secrets.token_urlsafe(32)
    row = RefreshToken(
        user_id=user_id,
        family_id=family_id,
        token_hash=hash_token(raw),
        expires_at=now + timedelta(days=get_settings().refresh_token_days),
        user_agent=client.user_agent[:USER_AGENT_MAX],
        ip_hash=ip_hash(client.ip),
    )
    return raw, row


def _issued(user_id: str, family_id: str, raw: str) -> Issued:
    return Issued(
        access_token=create_access_token(user_id, family_id),
        refresh_token=raw,
        session_id=family_id,
        expires_in=get_settings().access_token_minutes * 60,
    )


async def open_session(db: AsyncSession, user: User, client: Client) -> Issued:
    """A new session for `user`: signing in, or finishing a password reset."""
    family_id = new_id()
    raw, row = _new_token(user.id, family_id, client, utcnow())
    db.add(row)
    await db.commit()
    return _issued(user.id, family_id, raw)


async def rotate(db: AsyncSession, raw: str | None, client: Client) -> Issued:
    """Exchange a refresh token for the next one of its session, and a new
    access token. 401, with a code saying why, for anything else:

    * `no_session`: no token at all;
    * `invalid_refresh_token`: not one this server issued (or long expired);
    * `session_revoked`: its session was ended;
    * `refresh_superseded`: exchanged a moment ago, and the token that
      replaced it already exchanged too;
    * `refresh_token_reused`: exchanged before the grace: the session is
      revoked now, on every device;
    * `session_expired`: unused for `refresh_token_days`.

    Exchanged a moment ago (the grace), it answers with the same next token
    again: the browser that asked never got it.
    """
    if not raw:
        raise Auth401("Not signed in", code="no_session")
    row = (
        await db.execute(select(RefreshToken).where(RefreshToken.token_hash == hash_token(raw)))
    ).scalar_one_or_none()
    if row is None:
        raise Auth401("This session is not valid; sign in again", code="invalid_refresh_token")
    now = utcnow()
    if row.revoked_at is not None:
        raise Auth401("This session has ended; sign in again", code="session_revoked")
    if row.last_used_at is not None:
        return await _spent_token_presented(db, row, raw, now)
    if _aware(row.expires_at) <= now:
        raise Auth401("This session has expired; sign in again", code="session_expired")

    # Claimed by a conditional write, so that of two requests presenting the
    # same token at once exactly one exchanges it (on SQLite as on Postgres).
    claimed = await execute_dml(
        db,
        update(RefreshToken)
        .where(
            RefreshToken.id == row.id,
            RefreshToken.last_used_at.is_(None),
            RefreshToken.revoked_at.is_(None),
        )
        .values(last_used_at=now),
    )
    if claimed != 1:
        # Another request exchanged it in between: answered as a repeat.
        await db.rollback()
        await db.refresh(row)
        return await _spent_token_presented(db, row, raw, now)
    if await db.get(User, row.user_id) is None:
        await db.rollback()
        raise Auth401("User no longer exists", code="unknown_user")
    new_raw, new_row = _new_token(row.user_id, row.family_id, client, now, _successor(raw))
    db.add(new_row)
    await db.commit()
    return _issued(row.user_id, row.family_id, new_raw)


async def _spent_token_presented(
    db: AsyncSession, row: RefreshToken, raw: str, now: datetime
) -> Issued:
    """A token already exchanged is back. Within the grace, the same browser
    asking again: the same next token. Later, a copy: the session is revoked.
    Raises unless it answers."""
    if row.revoked_at is not None or row.last_used_at is None:
        raise Auth401("This session has ended; sign in again", code="session_revoked")
    grace = timedelta(seconds=get_settings().refresh_reuse_grace_seconds)
    if now - _aware(row.last_used_at) <= grace:
        successor = _successor(raw)
        live = (
            await db.execute(
                select(RefreshToken.id).where(
                    RefreshToken.token_hash == hash_token(successor),
                    RefreshToken.family_id == row.family_id,
                    RefreshToken.last_used_at.is_(None),
                    RefreshToken.revoked_at.is_(None),
                )
            )
        ).scalar_one_or_none()
        if live is not None:
            return _issued(row.user_id, row.family_id, successor)
        raise Auth401("This session was refreshed a moment ago", code="refresh_superseded")
    revoked = await _revoke(db, RefreshToken.family_id == row.family_id, "reuse")
    await db.commit()
    logger.warning(
        "a spent refresh token was presented again: session %s of user %s revoked (%d token(s))",
        row.family_id,
        row.user_id,
        revoked,
    )
    raise Auth401(
        "This session was used somewhere else and has been ended; sign in again",
        code="refresh_token_reused",
    )


async def _revoke(db: AsyncSession, which: ColumnElement[bool], reason: str) -> int:
    """Revoke the tokens `which` selects that are not revoked yet; how many.
    Not committed: the caller commits with whatever else it changed."""
    return await execute_dml(
        db,
        update(RefreshToken)
        .where(which, RefreshToken.revoked_at.is_(None))
        .values(revoked_at=utcnow(), revoked_reason=reason),
    )


async def end_session_of_token(db: AsyncSession, raw: str | None, reason: str = "logout") -> int:
    """Sign out: revoke the session `raw` belongs to, spent token or not.
    0 when it names no session. Not committed."""
    if not raw:
        return 0
    family_id = (
        await db.execute(
            select(RefreshToken.family_id).where(RefreshToken.token_hash == hash_token(raw))
        )
    ).scalar_one_or_none()
    if family_id is None:
        return 0
    return await _revoke(db, RefreshToken.family_id == family_id, reason)


async def end_session(db: AsyncSession, user_id: str, session_id: str, reason: str) -> int:
    """Revoke one session of `user_id`. Not committed."""
    return await _revoke(
        db,
        (RefreshToken.family_id == session_id) & (RefreshToken.user_id == user_id),
        reason,
    )


async def end_all_sessions(db: AsyncSession, user_id: str, reason: str) -> int:
    """Revoke every session of `user_id`: signing out everywhere, a new
    password. Not committed."""
    return await _revoke(db, RefreshToken.user_id == user_id, reason)


async def session_user(db: AsyncSession, claims: AccessClaims) -> User:
    """The user a valid access token names, while its session is open.

    One query on every authenticated request: the user, provided a token of
    the session is not revoked. 401 `session_revoked` once it is (signed
    out, out everywhere, a new password, a reused token), `unknown_user`
    once the account is gone.
    """
    open_token = exists().where(
        RefreshToken.family_id == claims.session_id,
        RefreshToken.user_id == User.id,
        RefreshToken.revoked_at.is_(None),
    )
    user = (
        await db.execute(select(User).where(User.id == claims.user_id, open_token))
    ).scalar_one_or_none()
    if user is not None:
        return user
    if await db.get(User, claims.user_id) is None:
        raise Auth401("User no longer exists", code="unknown_user")
    raise Auth401("This session has ended; sign in again", code="session_revoked")


async def purge_expired() -> int:
    """Delete the tokens past their expiry, revoked or not: none can be
    exchanged any more. The sweeper calls it (services.sweeper)."""
    async with get_session_factory()() as db:
        removed = await execute_dml(
            db, delete(RefreshToken).where(RefreshToken.expires_at < utcnow())
        )
        await db.commit()
    return removed
