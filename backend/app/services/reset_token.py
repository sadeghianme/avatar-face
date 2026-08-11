"""Single-use password reset links, without a database table.

The token carries a fingerprint of the password hash it was minted against.
Resetting the password changes that hash, so the fingerprint stops matching
and the link dies — single use, for free, with no row to insert, expire or
sweep. It also means a user who resets twice invalidates the first link, and
that any outstanding link is void the moment the password changes by any
route.

Signed rather than stored, like the Simulator token: the signature is the
record. What differs is what leaking one costs — a Simulator token spends a
little TTS quota, this one takes the account. So it is shorter-lived, tied to
one user, and dies on use.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import time

PREFIX = "lfr_"

# Long enough to arrive by email and be acted on, short enough that a link
# sitting in an inbox or a mail-server log is not a standing key to the
# account. Password reset links are routinely forwarded by accident.
DEFAULT_TTL_SECONDS = 30 * 60

_SIG_LEN = 43  # ~172 bits; this one is worth forging, unlike a test token


class InvalidResetToken(Exception):
    """Malformed, expired, already used, or not signed by us."""


def _sign(secret: str, payload: str) -> str:
    return hmac.new(secret.encode(), payload.encode(), hashlib.sha256).hexdigest()[:_SIG_LEN]


def fingerprint(password_hash: str) -> str:
    """A short digest of the current password hash.

    Bcrypt hashes are salted, so this changes on every reset even if someone
    sets the same password again — which is what makes the link single-use.
    """
    return hashlib.sha256(password_hash.encode()).hexdigest()[:16]


def mint(secret: str, user_id: str, password_hash: str, ttl_seconds: int = DEFAULT_TTL_SECONDS):
    """Return (token, expires_at_unix)."""
    expires_at = int(time.time()) + ttl_seconds
    payload = f"{user_id}|{fingerprint(password_hash)}|{expires_at}"
    encoded = base64.urlsafe_b64encode(payload.encode()).decode().rstrip("=")
    return f"{PREFIX}{encoded}.{_sign(secret, encoded)}", expires_at


def verify(secret: str, token: str) -> tuple[str, str]:
    """Return (user_id, fingerprint) for a structurally valid token.

    The caller still has to compare the fingerprint against the user's current
    password hash — that check needs the database and is what makes the token
    single-use.
    """
    if not token.startswith(PREFIX):
        raise InvalidResetToken("not a reset token")
    try:
        encoded, signature = token[len(PREFIX) :].split(".", 1)
        padding = "=" * (-len(encoded) % 4)
        user_id, print_, expires_at = (
            base64.urlsafe_b64decode(encoded + padding).decode().split("|", 2)
        )
    except (ValueError, UnicodeDecodeError) as exc:
        raise InvalidResetToken("malformed") from exc

    if not hmac.compare_digest(_sign(secret, encoded), signature):
        raise InvalidResetToken("bad signature")
    if int(expires_at) < int(time.time()):
        raise InvalidResetToken("expired")
    return user_id, print_
