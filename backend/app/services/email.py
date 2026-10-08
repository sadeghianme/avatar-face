"""Transactional email, via Resend.

One provider, called over plain HTTP — Resend's API is a single POST, so a SDK
would add a dependency to save four lines.

Sending is best-effort from the caller's point of view: a failure is logged
and reported as a boolean, never raised into a request handler. The reason is
specific to password reset, which is the only thing that sends mail here — the
endpoint deliberately answers the same way whether or not the address exists,
so that it cannot be used to discover who has an account. An exception
escaping on a delivery failure would undo that by making a real address
respond differently from an unknown one.

For the same reason a reset mail is never awaited by the request that asks
for it (`deliver_in_background`): Resend's round trip, up to TIMEOUT_SECONDS,
would otherwise be added to the answer for a real address only, and the time
an answer takes is just as readable as its body.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Coroutine
from typing import Any

import httpx

from app.core.config import get_settings

logger = logging.getLogger("liveface.email")

API_URL = "https://api.resend.com/emails"
TIMEOUT_SECONDS = 10


def configured() -> bool:
    settings = get_settings()
    return bool(settings.resend_api_key and settings.email_from)


async def send(to: str, subject: str, html: str, text: str) -> bool:
    """Send one message. Returns whether it was accepted.

    Both a text and an HTML part: some clients show the text, and a reset mail
    with no plain-text alternative is more likely to be filtered.
    """
    settings = get_settings()
    if not configured():
        # Loud, because in production this means password reset is silently
        # dead — the user sees "check your inbox" and nothing ever arrives.
        logger.error("email is not configured (RESEND_API_KEY / EMAIL_FROM); not sending %r", subject)
        return False

    try:
        async with httpx.AsyncClient(timeout=TIMEOUT_SECONDS) as client:
            response = await client.post(
                API_URL,
                headers={"Authorization": f"Bearer {settings.resend_api_key}"},
                json={
                    "from": settings.email_from,
                    "to": [to],
                    "subject": subject,
                    "html": html,
                    "text": text,
                },
            )
    except httpx.HTTPError:
        logger.exception("email delivery failed")
        return False

    if response.status_code >= 300:
        # The body carries Resend's reason — an unverified sending domain is
        # the usual one, and it is invisible without this.
        logger.error("email rejected (%s): %s", response.status_code, response.text[:300])
        return False
    return True


# Mail being sent after its request was answered. Held here because the loop
# keeps only a weak reference to a task: an unreferenced one can be collected
# mid-send. Bounded by the limits in front of it (a reset mail goes only to a
# real account, at most RESET_LIMIT an hour per address).
_outbox: set[asyncio.Task[Any]] = set()


def deliver_in_background(message: Coroutine[Any, Any, Any]) -> None:
    """Send `message` (a coroutine that sends mail) after this request.

    The caller returns at once; the send runs on the loop like any other
    network wait. Its failures are logged here, and shutdown waits for it
    (`drain`), so a deploy does not drop a reset mail half-sent.
    """
    task = asyncio.get_running_loop().create_task(message)
    _outbox.add(task)
    task.add_done_callback(_sent)


def _sent(task: asyncio.Task[Any]) -> None:
    _outbox.discard(task)
    if not task.cancelled() and (error := task.exception()) is not None:
        logger.error("background email failed", exc_info=error)


def pending() -> int:
    """How many messages are still being sent."""
    return len(_outbox)


async def drain(timeout: float = TIMEOUT_SECONDS + 5) -> None:
    """Wait for the mail still being sent (at shutdown, and in tests)."""
    if _outbox:
        await asyncio.wait(set(_outbox), timeout=timeout)


def reset_email(app_name: str, link: str, minutes: int) -> tuple[str, str, str]:
    """(subject, html, text) for a password reset."""
    subject = f"Reset your {app_name} password"
    text = (
        f"Someone asked to reset the password for your {app_name} account.\n\n"
        f"{link}\n\n"
        f"The link works once and expires in {minutes} minutes.\n"
        "If this wasn't you, ignore this email — your password has not changed."
    )
    html = f"""<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;line-height:1.6;color:#111">
  <p>Someone asked to reset the password for your {app_name} account.</p>
  <p style="margin:24px 0">
    <a href="{link}" style="background:#0a0a0a;color:#fff;padding:11px 20px;border-radius:999px;text-decoration:none;display:inline-block">Choose a new password</a>
  </p>
  <p style="color:#666;font-size:13.5px">The link works once and expires in {minutes} minutes.
  If this wasn't you, ignore this email — your password has not changed.</p>
  <p style="color:#999;font-size:12px;word-break:break-all">{link}</p>
</div>"""
    return subject, html, text
