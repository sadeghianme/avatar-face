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
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.api.deps import DB
from app.core.config import get_settings
from app.core.errors import Auth401, Forbidden403, NotFound404, RateLimit429
from app.models import ApiKey, Avatar, AvatarStatus, hash_api_key, utcnow
from app.schemas.tts import CueOut, SynthesizeRequest, SynthesizeResponse
from app.services.rate_limit import get_embed_rate_limiter
from app.services.simulator_token import looks_like_one as looks_like_simulator_token
from app.services.storage import get_storage
from app.services.tts.registry import synthesize_cached
from app.services.tts.timing import cues_from_segments, plan_utterance, total_duration_ms
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


def _simulator_key(token: str, request: Request) -> ApiKey:
    """Resolve a Simulator token to a key-shaped object, without storing one.

    Returned transient: never added to the session, so nothing is written and
    nothing appears in the customer's key list. Everything downstream only
    reads org_id, an id for rate limiting, and the domain list — usage is
    metered per organisation, not per key, so there is no row to reference.
    """
    from app.services.simulator_token import InvalidSimulatorToken
    from app.services.simulator_token import verify as verify_simulator_token

    try:
        org_id = verify_simulator_token(
            get_settings().jwt_secret, token, _origin_host(request)
        )
    except InvalidSimulatorToken as exc:
        # One code for every failure: the Simulator re-mints and retries on
        # this, and distinguishing expired from forged would only help someone
        # probing.
        raise Auth401(f"Simulator token rejected ({exc})", code="simulator_token_invalid")

    key = ApiKey(org_id=org_id, name="Simulator", prefix="lfsim_", key_hash="", allowed_domains="")
    key.id = f"sim:{org_id}"  # stable, so simulator traffic shares a rate-limit bucket
    key.revoked_at = None  # is_active is derived from this, not settable
    return key


async def _authenticate(request: Request, db: DB) -> ApiKey:
    plaintext = request.headers.get("x-api-key") or request.query_params.get("key")
    if not plaintext:
        raise Auth401("Missing API key", code="missing_api_key")

    if looks_like_simulator_token(plaintext):
        return _simulator_key(plaintext, request)

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
        # The owner's framing choice, so a change in the dashboard shows up on
        # every embedding site at their next page load.
        "framing": avatar.framing,
        "rig_url": await storage.presign_get(avatar.rig_key or ""),
        "thumbnail_url": await storage.presign_get(avatar.thumbnail_key or ""),
        "image_url": image_url,
        "model_url": image_url if avatar.kind.value == "model3d" else None,
        "layer_urls": await _layer_urls(avatar, storage),
        "viseme_frames": await _viseme_frames(avatar, storage),
    }


async def _viseme_frames(avatar: Avatar, storage) -> dict | None:
    """Manifest + presigned frame URLs, or None when the mouth is geometric.

    The manifest carries each frame's blendshape coordinates, so the client
    can place them in the same shape space the cue blender already works in.
    """
    if not getattr(avatar, "viseme_frames", 0):
        return None
    import json as _json

    from app.services.visemeframes import frame_key, manifest_key

    key = manifest_key(avatar.org_id, avatar.id)
    if not await storage.exists(key):
        return None
    try:
        manifest = _json.loads(await storage.get_bytes(key))
    except Exception:
        return None
    frames = []
    for entry in manifest.get("frames", []):
        frames.append(
            {
                **entry,
                "url": await storage.presign_get(
                    frame_key(avatar.org_id, avatar.id, entry["viseme"])
                ),
            }
        )
    if not frames:
        return None
    return {"box": manifest["box"], "frames": frames}


async def _layer_urls(avatar: Avatar, storage) -> dict[str, str] | None:
    """Presigned URLs of the background/body/head decomposition, if built.

    The background is absent for cut-outs (nothing behind them); the widget
    treats a missing entry as transparent.
    """
    if not getattr(avatar, "has_layers", False):
        return None
    from app.services.layers import layer_key

    urls: dict[str, str] = {}
    for name in ("background", "body", "head"):
        key = layer_key(avatar.org_id, avatar.id, name)
        if name == "background" and not await storage.exists(key):
            continue
        urls[name] = await storage.presign_get(key)
    return urls


class CueRequest(BaseModel):
    text: str = Field(min_length=1, max_length=5000)
    locale: str = "en-US"


class WordMark(BaseModel):
    char: int
    t: int


class CueResponse(BaseModel):
    cues: list[CueOut]
    duration_ms: int
    word_marks: list[WordMark]


@router.post("/cues", response_model=CueResponse)
async def embed_cues(body: CueRequest) -> CueResponse:
    """Viseme cues for text WITHOUT synthesising audio.

    The browser-voice path plays audio through speechSynthesis, which never
    hands back a waveform, so timing cannot be measured from the audio. It
    used to guess a flat 60ms per character — that mismatch is what made the
    mouth look unrelated to the speech. This serves the same phoneme-duration
    model the server providers use, plus per-word offsets so the widget can
    resync exactly on each `onboundary` event.

    Unauthenticated on purpose: it synthesises nothing, touches no org data,
    and costs a text scan. Requiring a key would only add a failure mode to
    a path whose whole point is working without server audio.
    """
    segments, marks = plan_utterance(body.text, body.locale)
    return CueResponse(
        cues=[CueOut(**c) for c in cues_from_segments(segments)],
        duration_ms=total_duration_ms(segments),
        word_marks=[WordMark(**m) for m in marks],
    )


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
