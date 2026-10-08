"""Public share pages: an avatar anyone with the link can talk to.

No API key, no login, no org context supplied by the caller — the token IS
the authorisation, and it resolves to exactly one avatar. Everything here is
deliberately narrow because the audience is the open internet:

* Only PUBLISHED avatars resolve, and they keep resolving while the owner's
  draft is rebuilt. A token for a never-published avatar is a 404, not a
  broken page.
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

from app.api.deps import DB, client_address
from app.core.errors import NotFound404
from app.models import Avatar
from app.schemas.published import PublishedAvatarOut
from app.schemas.tts import CueOut
from app.services.avatars import repo as avatars
from app.services.publishing import published_view
from app.services.rate_limit import SHARE_PER_CLIENT, SHARE_PER_TOKEN, enforce
from app.services.storage import get_storage
from app.services.tts.registry import synthesize_cached
from app.services.usage import check_usage_limit, record_synthesis

router = APIRouter(prefix="/public/v1", tags=["share"])

# A visitor on a shared link is a person pressing Play, not a program: the
# text is capped short, and speaking is rate limited (rate_limit.SHARE_*).
MAX_SHARE_TEXT = 600


async def _resolve(token: str, db: DB) -> Avatar:
    avatar = await avatars.by_share_token(db, token)
    # One message for "no such token" and "not published": a visitor can do
    # nothing with the difference, and it keeps token probing uninformative.
    # Published, not ready: the draft's status changes while the owner edits
    # (a re-detect runs it through processing) and says nothing about the
    # snapshot visitors are served. A never-published avatar has nothing to
    # show, so its link must not speak on the owner's quota either.
    if avatar is None or not avatar.published_config:
        raise NotFound404("This link is not available", code="share_not_found")
    return avatar


@router.get("/avatars/{token}", response_model=PublishedAvatarOut)
async def public_avatar(token: str, db: DB) -> PublishedAvatarOut:
    """Everything the widget engine needs to render, and nothing else: the
    embed answer without its id (schemas.published). 404 share_not_found."""
    avatar = await _resolve(token, db)
    storage = get_storage()
    # Published, like the embed: a share link is a page other people open,
    # so a half-finished edit must not appear on it either.

    view = await published_view(avatar, storage)
    if view is None:
        raise NotFound404("This link is not available", code="share_not_found")
    return PublishedAvatarOut.of(avatar, view)


class PublicSpeak(BaseModel):
    text: str = Field(min_length=1, max_length=MAX_SHARE_TEXT)
    provider: str = "browser"
    voice: str = ""
    locale: str = "en-US"


class PublicSpeech(BaseModel):
    """A visitor's line, spoken: the audio and its mouth cues."""

    audio_b64: str
    audio_mime: str
    duration_ms: int
    cues: list[CueOut]


@router.post("/avatars/{token}/speak", response_model=PublicSpeech)
async def public_speak(token: str, body: PublicSpeak, request: Request, db: DB) -> PublicSpeech:
    """Synthesise for a visitor, on the owner's quota.

    Two limits, because they stop different things: per token bounds what one
    shared link can cost its owner in a minute; per client stops a single
    visitor from being the one who spends it. Either answers 429
    `rate_limited` with Retry-After.
    """
    avatar = await _resolve(token, db)

    enforce(SHARE_PER_TOKEN, token)
    enforce(SHARE_PER_CLIENT, f"{token}:{client_address(request)}")

    await check_usage_limit(db, avatar.org_id, len(body.text))
    result, cached = await synthesize_cached(
        db, body.provider, body.voice, body.locale, body.text
    )
    await record_synthesis(
        db, avatar.org_id, body.provider, len(body.text), cached, source="share"
    )
    return PublicSpeech(
        audio_b64=base64.b64encode(result.audio).decode(),
        audio_mime=result.audio_mime,
        duration_ms=result.duration_ms,
        cues=[CueOut(**c) for c in result.cues],
    )
