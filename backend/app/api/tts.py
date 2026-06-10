from __future__ import annotations

import base64

from fastapi import APIRouter

from app.api.deps import DB, OrgMember
from app.schemas.tts import (
    CueOut,
    ProviderOut,
    SynthesizeRequest,
    SynthesizeResponse,
    VoiceOut,
)
from app.services.tts.registry import available_providers, get_provider, synthesize_cached
from app.services.usage import check_usage_limit, record_synthesis

router = APIRouter(prefix="/tts", tags=["tts"])


@router.get("/providers", response_model=list[ProviderOut])
async def list_providers() -> list[ProviderOut]:
    return [
        ProviderOut(name=p.name, display_name=p.display_name) for p in available_providers()
    ]


@router.get("/providers/{provider}/voices", response_model=list[VoiceOut])
async def list_voices(provider: str) -> list[VoiceOut]:
    voices = await get_provider(provider).voices()
    return [VoiceOut(id=v.id, name=v.name, locale=v.locale, gender=v.gender) for v in voices]


@router.post("/orgs/{org_id}/synthesize", response_model=SynthesizeResponse)
async def synthesize(body: SynthesizeRequest, ctx: OrgMember, db: DB) -> SynthesizeResponse:
    await check_usage_limit(db, ctx.org.id, len(body.text))
    result, cached = await synthesize_cached(
        db, body.provider, body.voice, body.locale, body.text
    )
    await record_synthesis(
        db, ctx.org.id, body.provider, len(body.text), cached, source="dashboard"
    )
    return SynthesizeResponse(
        audio_b64=base64.b64encode(result.audio).decode(),
        audio_mime=result.audio_mime,
        duration_ms=result.duration_ms,
        cues=[CueOut(**c) for c in result.cues],
        cached=cached,
    )
