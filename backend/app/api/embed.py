"""Public embed API (key-authenticated, used by the widget on third-party sites).

Auth: X-Api-Key header (or ?key=). The key's org is the acting org — never a
client-supplied org id. Browser calls are origin-checked against the key's
allowed_domains, and each key is rate-limited per minute.

CORS for /embed/* is handled by the path-scoped middleware in main.py, which
reflects any Origin so the widget works from anywhere the key's domain list
allows.
"""
from __future__ import annotations

import base64
from urllib.parse import urlsplit

from fastapi import APIRouter, Request
from sqlalchemy import select

from app.api.deps import DB
from app.core.errors import Auth401, Forbidden403, NotFound404, RateLimit429
from app.models import ApiKey, Avatar, AvatarStatus, hash_api_key, utcnow
from app.schemas.tts import CueOut, SynthesizeRequest, SynthesizeResponse
from app.services.rate_limit import get_embed_rate_limiter
from app.services.storage import get_storage
from app.services.tts.registry import synthesize_cached
from app.services.usage import check_usage_limit, record_synthesis

router = APIRouter(prefix="/embed/v1", tags=["embed"])


def _origin_host(request: Request) -> str | None:
    """Host from Origin (preferred) or Referer; None for non-browser clients."""
    origin = request.headers.get("origin") or request.headers.get("referer")
    if not origin:
        return None
    return (urlsplit(origin).hostname or "").lower() or None


def _host_allowed(host: str, patterns: list[str]) -> bool:
    for pattern in patterns:
        if pattern.startswith("*."):
            if host == pattern[2:] or host.endswith(pattern[1:]):
                return True
        elif host == pattern:
            return True
    return False


async def _authenticate(request: Request, db: DB) -> ApiKey:
    plaintext = request.headers.get("x-api-key") or request.query_params.get("key")
    if not plaintext:
        raise Auth401("Missing API key", code="missing_api_key")
    api_key = (
        await db.execute(select(ApiKey).where(ApiKey.key_hash == hash_api_key(plaintext)))
    ).scalar_one_or_none()
    if api_key is None or not api_key.is_active:
        raise Auth401("Invalid API key", code="invalid_api_key")

    host = _origin_host(request)
    if api_key.domain_list and host is not None and not _host_allowed(host, api_key.domain_list):
        raise Forbidden403("Origin not allowed for this key", code="origin_not_allowed")

    if not get_embed_rate_limiter().allow(api_key.id):
        raise RateLimit429("Embed rate limit exceeded", code="rate_limited")

    api_key.last_used_at = utcnow()
    await db.commit()
    return api_key


@router.get("/avatars/{avatar_id}")
async def embed_avatar(avatar_id: str, request: Request, db: DB) -> dict:
    api_key = await _authenticate(request, db)
    avatar = (
        await db.execute(
            select(Avatar).where(Avatar.id == avatar_id, Avatar.org_id == api_key.org_id)
        )
    ).scalar_one_or_none()
    if avatar is None:
        raise NotFound404("Avatar not found", code="avatar_not_found")
    if avatar.status != AvatarStatus.ready:
        raise NotFound404("Avatar is not ready", code="avatar_not_ready")
    storage = get_storage()
    # Absolute URLs: the widget runs on a third-party origin.
    image_url = await storage.presign_get(avatar.image_key or "")
    return {
        "id": avatar.id,
        "name": avatar.name,
        "kind": avatar.kind.value,
        "rig_url": await storage.presign_get(avatar.rig_key or ""),
        "thumbnail_url": await storage.presign_get(avatar.thumbnail_key or ""),
        "image_url": image_url,
        "model_url": image_url if avatar.kind.value == "model3d" else None,
    }


@router.post("/synthesize", response_model=SynthesizeResponse)
async def embed_synthesize(
    body: SynthesizeRequest, request: Request, db: DB
) -> SynthesizeResponse:
    api_key = await _authenticate(request, db)
    await check_usage_limit(db, api_key.org_id, len(body.text))
    result, cached = await synthesize_cached(
        db, body.provider, body.voice, body.locale, body.text
    )
    await record_synthesis(
        db, api_key.org_id, body.provider, len(body.text), cached, source="embed"
    )
    return SynthesizeResponse(
        audio_b64=base64.b64encode(result.audio).decode(),
        audio_mime=result.audio_mime,
        duration_ms=result.duration_ms,
        cues=[CueOut(**c) for c in result.cues],
        cached=cached,
    )
