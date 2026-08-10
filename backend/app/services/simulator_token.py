"""Short-lived credentials for the in-dashboard Simulator.

The Simulator needs to authenticate to the embed API exactly as a visitor's
browser would, but it cannot use the customer's real key. Two reasons, both
fatal:

- Keys are stored as a SHA-256 hash. The plaintext is returned once at
  creation and is genuinely not recoverable, so there is nothing to look up.
- Real keys are usually locked to the customer's own domain, and the
  Simulator runs on the dashboard's domain. Even with the plaintext it would
  be rejected as origin_not_allowed.

So this mints something else: a signed capability, valid for minutes, bound
to the origin that asked for it. It is not stored anywhere — the signature is
the record — so there is no key to leak from the database, nothing to appear
in the customer's key list, and nothing to clean up.

Binding to origin matters more than the expiry. A token that only works from
a page the holder must already be signed in to is close to worthless if it
escapes; the expiry just bounds how long that stays true.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import time

PREFIX = "lfsim_"

# Short, because the Simulator re-mints silently. Without renewal this number
# would be a guess about how long someone sits on the page, and getting it
# wrong shows up as Speak dying mid-session — which reads as a broken product
# rather than an expired token.
DEFAULT_TTL_SECONDS = 15 * 60

# Truncated to keep the token short; 128 bits is far past what forging a
# 15-minute, origin-bound capability would be worth.
_SIG_LEN = 32


class InvalidSimulatorToken(Exception):
    """Malformed, expired, wrongly signed, or presented from another origin."""


def _sign(secret: str, payload: str) -> str:
    return hmac.new(secret.encode(), payload.encode(), hashlib.sha256).hexdigest()[:_SIG_LEN]


def mint(secret: str, org_id: str, origin_host: str, ttl_seconds: int = DEFAULT_TTL_SECONDS):
    """Return (token, expires_at_unix)."""
    expires_at = int(time.time()) + ttl_seconds
    payload = f"{org_id}|{origin_host}|{expires_at}"
    encoded = base64.urlsafe_b64encode(payload.encode()).decode().rstrip("=")
    return f"{PREFIX}{encoded}.{_sign(secret, encoded)}", expires_at


def looks_like_one(token: str) -> bool:
    return token.startswith(PREFIX)


def verify(secret: str, token: str, origin_host: str | None) -> str:
    """Return the org id, or raise InvalidSimulatorToken."""
    if not looks_like_one(token):
        raise InvalidSimulatorToken("not a simulator token")
    try:
        encoded, signature = token[len(PREFIX) :].split(".", 1)
        padding = "=" * (-len(encoded) % 4)
        org_id, bound_host, expires_at = (
            base64.urlsafe_b64decode(encoded + padding).decode().split("|", 2)
        )
    except (ValueError, UnicodeDecodeError) as exc:
        raise InvalidSimulatorToken("malformed") from exc

    # Constant time: the signature is the only thing standing between a
    # guessed payload and a working token.
    if not hmac.compare_digest(_sign(secret, encoded), signature):
        raise InvalidSimulatorToken("bad signature")
    if int(expires_at) < int(time.time()):
        raise InvalidSimulatorToken("expired")
    # A token that escapes is useless anywhere but the page it was minted for.
    if origin_host is not None and origin_host.lower() != bound_host.lower():
        raise InvalidSimulatorToken("wrong origin")
    return org_id
