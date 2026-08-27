"""Public share pages: an avatar anyone with the link can talk to.

No API key, no login, no org context supplied by the caller — the token IS
the authorisation, and it resolves to exactly one avatar. Everything here is
deliberately narrow because the audience is the open internet:

* Only READY avatars resolve. A token for a failed or half-built avatar is a
  404, not a broken page.
* Text is capped short. The dashboard allows long scripts; a stranger on a
  link does not need them, and every character is billed to the owner.
* Speaking is rate-limited per token AND per client, so one shared link
  cannot be turned into a free TTS endpoint that empties the owner's quota.
* The response carries no org id, no avatar id, no key — nothing that would
  let a visitor address anything except this one avatar.

Revoking is a single UPDATE that nulls the token, which kills every copy of
the link everywhere at once.
"""

from __future__ import annotations

import base64

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.api.deps import DB
from app.core.errors import NotFound404, RateLimit429
from app.models import Avatar, AvatarStatus
from app.schemas.tts import CueOut
from app.services.rate_limit import SlidingWindowRateLimiter
from app.services.storage import get_storage
from app.services.tts.registry import synthesize_cached
from app.services.usage import check_usage_limit, record_synthesis

router = APIRouter(prefix="/public/v1", tags=["share"])

# A visitor on a shared link is a person pressing Play, not a program. These
# are generous for the former and useless for the latter.
MAX_SHARE_TEXT = 600
_per_token = SlidingWindowRateLimiter(limit=30, window_seconds=60.0)
_per_client = SlidingWindowRateLimiter(limit=12, window_seconds=60.0)


async def _resolve(token: str, db: DB) -> Avatar:
    avatar = (
        await db.execute(select(Avatar).where(Avatar.share_token == token))
    ).scalar_one_or_none()
    # One message for "no such token" and "not ready": a visitor can do
    # nothing with the difference, and it keeps token probing uninformative.
    if avatar is None or avatar.status != AvatarStatus.ready:
        raise NotFound404("This link is not available", code="share_not_found")
    return avatar


@router.get("/avatars/{token}")
async def public_avatar(token: str, db: DB) -> dict:
    """Everything the widget engine needs to render, and nothing else."""
    avatar = await _resolve(token, db)
    storage = get_storage()
    # Published, like the embed: a share link is a page other people open,
    # so a half-finished edit must not appear on it either.
    from app.services.publishing import published_view

    view = await published_view(avatar, storage)
    if view is None:
        raise NotFound404("This link is not available", code="share_not_found")
    return {
        "name": avatar.name,
        "kind": avatar.kind.value,
        "framing": view["framing"],
        "rig_url": view["rig_url"],
        "thumbnail_url": view["thumbnail_url"],
        "image_url": view["image_url"],
        "model_url": view["image_url"] if avatar.kind.value == "model3d" else None,
        "layer_urls": view["layer_urls"],
    }


class PublicSpeak(BaseModel):
    text: str = Field(min_length=1, max_length=MAX_SHARE_TEXT)
    provider: str = "browser"
    voice: str = ""
    locale: str = "en-US"


@router.post("/avatars/{token}/speak")
async def public_speak(token: str, body: PublicSpeak, request: Request, db: DB) -> dict:
    """Synthesise for a visitor, on the owner's quota.

    Two limits, because they stop different things: per token bounds what one
    shared link can cost its owner in a minute; per client stops a single
    visitor from being the one who spends it.
    """
    avatar = await _resolve(token, db)

    client = request.client.host if request.client else "unknown"
    if not _per_token.allow(token) or not _per_client.allow(f"{token}:{client}"):
        raise RateLimit429("Too many requests — try again in a moment", code="rate_limited")

    await check_usage_limit(db, avatar.org_id, len(body.text))
    result, cached = await synthesize_cached(
        db, body.provider, body.voice, body.locale, body.text
    )
    await record_synthesis(
        db, avatar.org_id, body.provider, len(body.text), cached, source="share"
    )
    return {
        "audio_b64": base64.b64encode(result.audio).decode(),
        "audio_mime": result.audio_mime,
        "duration_ms": result.duration_ms,
        "cues": [CueOut(**c).model_dump() for c in result.cues],
    }
