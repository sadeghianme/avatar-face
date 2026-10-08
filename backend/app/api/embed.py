"""Public embed API (key-authenticated, used by the widget on third-party sites).

Auth: the X-Api-Key header only. A key in the query string (`?key=`, once
accepted) would be written to access logs, proxies and Referer headers;
the widget has always sent the header. The key's org is the acting org —
never a client-supplied org id. Browser calls are origin-checked against the key's
allowed_domains, and each key (each organization's Simulator, for its
tokens) is rate-limited per minute. A page whose origin is opaque
(`Origin: null`: a sandboxed frame, a data: or file: page) cannot use a key
locked to domains; only a Simulator token is accepted from one. The one unauthenticated route, /cues, is
rate-limited per client address instead.

CORS for /embed/* is handled by the path-scoped middleware in main.py, which
reflects any Origin so the widget works from anywhere the key's domain list
allows.
"""

from __future__ import annotations

import base64
from urllib.parse import urlsplit

from fastapi import APIRouter, Request, Response
from pydantic import BaseModel, Field

from app.api.deps import DB, client_address
from app.core.config import get_settings
from app.core.errors import Auth401, Forbidden403, NotFound404
from app.models import ApiKey, AvatarStatus
from app.schemas.published import EmbedAvatarOut
from app.schemas.tts import CueOut, SynthesizeRequest, SynthesizeResponse
from app.services import api_keys
from app.services.avatars import repo as avatars
from app.services.publishing import published_view
from app.services.rate_limit import CUES_PER_CLIENT, embed_per_key, enforce
from app.services.simulator_token import InvalidSimulatorToken
from app.services.simulator_token import looks_like_one as looks_like_simulator_token
from app.services.simulator_token import verify as verify_simulator_token
from app.services.storage import get_storage
from app.services.tts.registry import synthesize_cached
from app.services.tts.timing import cue_track, on_planner_thread
from app.services.usage import check_usage_limit, record_synthesis

router = APIRouter(prefix="/embed/v1", tags=["embed"])


def _origin_host(request: Request) -> str | None:
    """Host from Origin (preferred) or Referer; None for a client that sends
    neither (not a browser) and for an opaque origin (`_opaque_origin`)."""
    origin = request.headers.get("origin") or request.headers.get("referer")
    if not origin:
        return None
    return (urlsplit(origin).hostname or "").lower() or None


def _opaque_origin(request: Request) -> bool:
    """A browser that says where it is, but not who: `Origin: null` (a
    sandboxed frame, a data: or file: page, a redirect across origins), or
    any Origin or Referer without a host. Any website can produce one, by
    putting the widget in a sandboxed frame, so it vouches for no domain."""
    origin = request.headers.get("origin") or request.headers.get("referer")
    return bool(origin) and _origin_host(request) is None


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

    An opaque origin (`Origin: null`) is accepted here, and only here: the
    dashboard's Simulator runs the widget in a frame sandboxed without
    allow-same-origin, which has one. The token was minted for a signed-in
    member, from the dashboard's own origin, for one organization, and lives
    fifteen minutes; a page that names a host must still be the one it was
    minted for.
    """
    try:
        org_id = verify_simulator_token(get_settings().jwt_secret, token, _origin_host(request))
    except InvalidSimulatorToken as exc:
        # One code for every failure: the Simulator re-mints and retries on
        # this, and distinguishing expired from forged would only help someone
        # probing.
        raise Auth401(f"Simulator token rejected ({exc})", code="simulator_token_invalid") from exc

    key = ApiKey(org_id=org_id, name="Simulator", prefix="lfsim_", key_hash="", allowed_domains="")
    key.id = f"sim:{org_id}"  # stable, so simulator traffic shares a rate-limit bucket
    key.revoked_at = None  # is_active is derived from this, not settable
    return key


async def _authenticate(request: Request, db: DB) -> ApiKey:
    """The key a request presents, checked and counted.

    401 missing_api_key / invalid_api_key / simulator_token_invalid, 403
    origin_not_allowed (a host outside a key's domains, or an opaque origin
    for a key that has domains), 429 rate_limited (with Retry-After) past the
    per-key limit. A Simulator token is limited like a key, in one bucket per
    organization: origin binding does not stop a client that forges the
    Origin header, so the limit is what bounds it.
    """
    plaintext = request.headers.get("x-api-key")
    if not plaintext:
        raise Auth401("Missing API key", code="missing_api_key")

    simulator = looks_like_simulator_token(plaintext)
    if simulator:
        api_key = _simulator_key(plaintext, request)
    else:
        found = await api_keys.by_plaintext(db, plaintext)
        if found is None or not found.is_active:
            raise Auth401("Invalid API key", code="invalid_api_key")
        api_key = found
        if api_key.domain_list:
            # A sandboxed frame on any website sends `Origin: null`: taken as
            # "no browser", it skipped the domain check for every such page.
            if _opaque_origin(request):
                raise Forbidden403(
                    "This key is locked to its domains; a page with no origin "
                    "(Origin: null) cannot use it",
                    code="origin_not_allowed",
                )
            host = _origin_host(request)
            if host is not None and not _host_allowed(host, api_key.domain_list):
                raise Forbidden403("Origin not allowed for this key", code="origin_not_allowed")

    enforce(embed_per_key(), api_key.id, "Embed rate limit exceeded")

    if not simulator:
        await api_keys.mark_used(db, api_key)
    return api_key


@router.get("/avatars/{avatar_id}", response_model=EmbedAvatarOut)
async def embed_avatar(avatar_id: str, request: Request, db: DB) -> EmbedAvatarOut:
    """The PUBLISHED avatar, for the widget: its files presigned, its scene,
    voice, mouth and disclosure (schemas.published, the public contract).

    401 missing_api_key / invalid_api_key; 403 origin_not_allowed; 404
    avatar_not_found, avatar_not_ready (never published and not ready) or
    avatar_not_published; 429 rate_limited past the key's limit."""
    api_key = await _authenticate(request, db)
    avatar = await avatars.require_in_org(db, api_key.org_id, avatar_id)
    # The draft's status says nothing about the published snapshot: a
    # re-detect or a retry puts the DRAFT through processing (or failure)
    # while the published copies sit untouched. Gating on it took customer
    # sites offline for as long as an owner's edit ran. Only an avatar that
    # was never published is judged by its status.
    if not avatar.published_config and avatar.status != AvatarStatus.ready:
        raise NotFound404("Avatar is not ready", code="avatar_not_ready")
    storage = get_storage()
    # The PUBLISHED snapshot, never the draft. An owner mid-edit must not be
    # able to change what a visitor sees by accident; that only happens when
    # they press Publish.

    view = await published_view(avatar, storage)
    if view is None:
        raise NotFound404("Avatar has not been published", code="avatar_not_published")
    # Every field is the published snapshot's, so a site keeps what its
    # owner last published: the face type chooses the head motion's default
    # (data-head-motion still overrides), the scene the zoom (data-framing
    # and data-zoom still override), the voice the speech (data-voice still
    # overrides: that is per-site intent).
    return EmbedAvatarOut.of(avatar, view)


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


def _cue_body(text: str, locale: str) -> bytes:
    """The /cues answer, serialised.

    Built whole on the planning thread, JSON included: two thousand
    characters are a thousand cues, and validating and encoding twenty of
    those at once on the event loop was what still held it up.
    """
    cues, duration_ms, marks = cue_track(text, locale)
    answer = CueResponse(
        cues=[CueOut(**c) for c in cues],
        duration_ms=duration_ms,
        word_marks=[WordMark(**m) for m in marks],
    )
    return answer.model_dump_json().encode()


@router.post("/cues", response_model=CueResponse)
async def embed_cues(body: CueRequest, request: Request) -> Response:
    """Viseme cues for text WITHOUT synthesising audio.

    The browser-voice path plays audio through speechSynthesis, which never
    hands back a waveform, so timing cannot be measured from the audio. It
    used to guess a flat 60ms per character — that mismatch is what made the
    mouth look unrelated to the speech. This serves the same phoneme-duration
    model the server providers use, plus per-word offsets so the widget can
    resync exactly on each `onboundary` event.

    Unauthenticated on purpose: it synthesises nothing and touches no org
    data. Requiring a key would only add a failure mode to a path whose whole
    point is working without server audio. What it does cost — a text scan
    and, outside English, one espeak-ng process for the whole text — runs on
    a worker thread, never on the loop that serves every other widget.

    Errors: 422 `validation_error` for text over 5,000 characters (or
    empty); 429 `rate_limited`, with Retry-After, past
    `rate_limit.CUES_PER_CLIENT` requests a minute from one address.
    """
    enforce(CUES_PER_CLIENT, client_address(request))
    content = await on_planner_thread(_cue_body, body.text, body.locale)
    return Response(content=content, media_type="application/json")


@router.post("/synthesize", response_model=SynthesizeResponse)
async def embed_synthesize(body: SynthesizeRequest, request: Request, db: DB) -> SynthesizeResponse:
    api_key = await _authenticate(request, db)
    await check_usage_limit(db, api_key.org_id, len(body.text))
    result, cached = await synthesize_cached(
        db, body.provider, body.voice, body.locale, body.text, org_id=api_key.org_id
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
