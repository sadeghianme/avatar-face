from __future__ import annotations

import asyncio
import base64
import json
import logging
import time

from fastapi import APIRouter
from starlette.background import BackgroundTask
from starlette.responses import StreamingResponse

from app.api.deps import DB, OrgMember
from app.core.errors import RateLimit429
from app.db import get_session_factory
from app.schemas.tts import (
    CueOut,
    ProviderOut,
    SynthesizeRequest,
    SynthesizeResponse,
    VoiceOut,
)
from app.services.tts.languages import available_languages
from app.services.tts.registry import available_providers, get_provider, synthesize_cached
from app.services.tts.stream import pcm_packet, phrase_batch_size, speech_phrases
from app.services.usage import check_usage_limit, record_synthesis

router = APIRouter(prefix="/tts", tags=["tts"])

# One stream per organisation, a few per process: a phrase stream holds a
# synthesis worker for the whole utterance, and the standard Kokoro path is
# serialised behind one semaphore.
_streams: dict[str, object] = {}
MAX_STREAMS = 4


@router.get("/providers", response_model=list[ProviderOut])
async def list_providers() -> list[ProviderOut]:
    return [
        ProviderOut(name=p.name, display_name=p.display_name) for p in available_providers()
    ]


@router.get("/languages")
async def list_languages() -> list[dict]:
    """Languages this deployment can speak, each already resolved to the best
    provider and voice for it.

    The picker asks for a language, not a provider: nobody choosing Persian
    should have to know that Piper speaks it and Kokoro does not. Each entry
    also carries a sample line in that language, so pressing Speak
    demonstrates something the user can judge rather than English read by a
    Persian voice.

    Unauthenticated for the same reason /cues is: it synthesises nothing,
    touches no org data, and the share page needs it too.
    """
    return await available_languages()


@router.get("/providers/{provider}/voices", response_model=list[VoiceOut])
async def list_voices(provider: str) -> list[VoiceOut]:
    voices = await get_provider(provider).voices()
    return [VoiceOut(id=v.id, name=v.name, locale=v.locale, gender=v.gender) for v in voices]


@router.post("/orgs/{org_id}/synthesize", response_model=SynthesizeResponse)
async def synthesize(body: SynthesizeRequest, ctx: OrgMember, db: DB) -> SynthesizeResponse:
    await check_usage_limit(db, ctx.org.id, len(body.text))
    result, cached = await synthesize_cached(
        db, body.provider, body.voice, body.locale, body.text, org_id=ctx.org.id
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


@router.post("/orgs/{org_id}/stream")
async def stream(body: SynthesizeRequest, ctx: OrgMember, db: DB):
    """Speech in phrases, so the first word plays before the rest exists.

    NDJSON frames: `start`, ordered `chunk`s of mono 24 kHz PCM16 with the
    phrase's own cues, then `done` (or `error`). Only Kokoro streams; any
    other provider gets one `recording` frame from the existing path, and the
    client plays it exactly as before.

    Same synthesis as the whole-recording endpoint — same voice, same measured
    cues, same cache — cut at clause boundaries. What changes is when the
    audio is heard, not what it sounds like. Metered per phrase, before
    delivery, once. Never retried after audio has been delivered.
    """
    logger = logging.getLogger("liveface.tts.stream")
    org_id = ctx.org.id
    await check_usage_limit(db, org_id, len(body.text))
    if org_id in _streams or len(_streams) >= MAX_STREAMS:
        raise RateLimit429("Speech is already being prepared. Stop it or try again shortly.", code="speech_busy")
    streams = body.provider == "kokoro"
    # No request-scoped connection is held while synthesis runs.
    await db.rollback()
    ticket = object()
    _streams[org_id] = ticket

    def release() -> None:
        if _streams.get(org_id) is ticket:
            _streams.pop(org_id, None)

    def line(payload: dict) -> bytes:
        return (json.dumps(payload, separators=(",", ":")) + "\n").encode()

    async def events():
        try:
            yield line({"type": "start", "version": 1, "mode": "phrases" if streams else "recording"})
            if not streams:
                async with get_session_factory()() as session:
                    result, cached = await synthesize_cached(
                        session, body.provider, body.voice, body.locale, body.text, org_id=org_id
                    )
                    await record_synthesis(session, org_id, body.provider, len(body.text), cached, source="dashboard")
                yield line({"type": "recording", "audio_b64": base64.b64encode(result.audio).decode(),
                            "audio_mime": result.audio_mime, "duration_ms": result.duration_ms,
                            "cues": result.cues, "baseline_cues": result.cues, "timing_source": "existing_provider"})
                yield line({"type": "done", "chunks": 0})
                return
            phrases = speech_phrases(body.text)
            sample_offset = 0
            sequence = 0
            first_delivery: float | None = None
            seconds_per_char: float | None = None
            while phrases:
                buffered = max(0.0, sample_offset / 24000 - (time.monotonic() - first_delivery)) if first_delivery else 0.0
                batch = phrase_batch_size(phrases, buffered, seconds_per_char)
                phrase = "".join(phrases[:batch])
                phrases = phrases[batch:]
                started = time.monotonic()
                async with asyncio.timeout(90):
                    async with get_session_factory()() as session:
                        await check_usage_limit(session, org_id, len(phrase))
                        # PCM: the packet carries samples, not a file.
                        result, cached = await synthesize_cached(
                            session, body.provider, body.voice, body.locale, phrase,
                            org_id=org_id, pcm=True,
                        )
                        await record_synthesis(session, org_id, body.provider, len(phrase), cached, source="dashboard")
                packet = pcm_packet(result.audio, sequence, sample_offset, result.cues, result.cues)
                sample_offset += packet["sample_count"]
                elapsed = time.monotonic() - started
                # A cache hit is not evidence about inference speed.
                if not cached:
                    seconds_per_char = max(elapsed / max(1, len(phrase)), (seconds_per_char or 0) * 0.8)
                packet["generation_ms"] = round(elapsed * 1000)
                first_delivery = first_delivery or time.monotonic()
                sequence += 1
                yield line(packet)
            yield line({"type": "done", "chunks": sequence, "total_samples": sample_offset, "sample_rate": 24000})
        except asyncio.CancelledError:
            raise
        except Exception:
            # Broad on purpose: the headers are sent, so any failure is said
            # in the stream itself, where the client shows it.
            logger.exception("speech stream failed")
            yield line({"type": "error", "code": "speech_stream_failed",
                        "detail": "Speech preparation was interrupted. Please try again."})
        finally:
            release()

    return StreamingResponse(events(), media_type="application/x-ndjson", background=BackgroundTask(release),
                             headers={"Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no"})
