"""Isolated speech experiment; stable synthesis and its cache stay unchanged."""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import time
from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel, Field
from starlette.background import BackgroundTask
from starlette.responses import StreamingResponse

from app.api.deps import DB, OrgMember
from app.core.errors import RateLimit429, Validation422
from app.db import get_session_factory
from app.schemas.tts import CueOut
from app.services.tts import lab_timing
from app.services.tts.registry import synthesize_cached
from app.services.tts.stream import pcm_packet, phrase_batch_size, speech_phrases
from app.services.usage import check_usage_limit, record_synthesis

router = APIRouter(prefix="/orgs/{org_id}/lab/lip-sync", tags=["lab"])
logger = logging.getLogger("liveface.lab.speech")
_streams: dict[str, object] = {}


class LabSpeechRequest(BaseModel):
    text: str = Field(min_length=1, max_length=600)
    provider: Literal["kokoro", "piper", "azure", "elevenlabs", "google", "openai", "offline"] = (
        "kokoro"
    )
    voice: str = Field(default="af_heart", max_length=200)
    locale: str = Field(default="en-US", max_length=30)


class LabSpeechResponse(BaseModel):
    audio_b64: str
    audio_mime: str
    duration_ms: int
    cues: list[CueOut]
    baseline_cues: list[CueOut]
    timing_source: Literal["native_phonemes", "existing_provider"]
    cached: bool


@router.post("/synthesize", response_model=LabSpeechResponse)
async def synthesize(body: LabSpeechRequest, ctx: OrgMember, db: DB) -> LabSpeechResponse:
    if not body.text.strip():
        raise Validation422("Enter some text", code="empty_text")
    await check_usage_limit(db, ctx.org.id, len(body.text))
    if body.provider == "kokoro" and lab_timing.configured():
        try:
            audio, duration, cues, baseline = await lab_timing.synthesize_native(
                body.text, body.voice
            )
        except Exception as error:
            # Broad on purpose: the lab model's runtime fails in its own
            # types, and every one of them is this 422.
            logger.exception("Native lip-sync synthesis failed")
            raise Validation422(
                "The lab model could not return valid phoneme timings. Check its model and runtime configuration.",
                code="native_timing_unavailable",
            ) from error
        mime, cached, source = "audio/wav", False, "native_phonemes"
    else:
        result, cached = await synthesize_cached(
            db, body.provider, body.voice, body.locale, body.text, org_id=ctx.org.id
        )
        audio, mime, duration = result.audio, result.audio_mime, result.duration_ms
        cues, baseline, source = result.cues, result.cues, "existing_provider"
    await record_synthesis(
        db, ctx.org.id, body.provider, len(body.text), cached, source="dashboard"
    )
    return LabSpeechResponse(
        audio_b64=base64.b64encode(audio).decode(),
        audio_mime=mime,
        duration_ms=duration,
        cues=[CueOut(**c) for c in cues],
        baseline_cues=[CueOut(**c) for c in baseline],
        timing_source=source,
        cached=cached,
    )


def _line(payload: dict) -> bytes:
    return (json.dumps(payload, separators=(",", ":"), ensure_ascii=False) + "\n").encode()


@router.post("/stream")
async def stream(body: LabSpeechRequest, ctx: OrgMember, db: DB):
    """Authenticated, cancellable NDJSON. Never retry after audio is delivered.

    Native Kokoro yields timed phrases. Other providers keep their complete
    recording path, explicitly labelled; no fabricated native alignment.
    """
    if not body.text.strip():
        raise Validation422("Enter some text", code="empty_text")
    org_id = ctx.org.id
    await check_usage_limit(db, org_id, len(body.text))
    if org_id in _streams or len(_streams) >= 4:
        raise RateLimit429(
            "Speech is already being prepared. Stop it or try again shortly.", code="speech_busy"
        )
    native = body.provider == "kokoro" and lab_timing.configured()
    # No request-scoped DB connection is held while inference/streaming runs.
    await db.rollback()
    ticket = object()
    _streams[org_id] = ticket

    def release():
        if _streams.get(org_id) is ticket:
            _streams.pop(org_id, None)

    async def events():
        try:
            yield _line(
                {
                    "type": "start",
                    "version": 1,
                    "mode": "native_phrases" if native else "buffered_provider",
                }
            )
            if not native:
                async with get_session_factory()() as session:
                    result, cached = await synthesize_cached(
                        session, body.provider, body.voice, body.locale, body.text, org_id=org_id
                    )
                    await record_synthesis(
                        session, org_id, body.provider, len(body.text), cached, source="dashboard"
                    )
                yield _line(
                    {
                        "type": "recording",
                        "audio_b64": base64.b64encode(result.audio).decode(),
                        "audio_mime": result.audio_mime,
                        "duration_ms": result.duration_ms,
                        "cues": result.cues,
                        "baseline_cues": result.cues,
                        "timing_source": "existing_provider",
                    }
                )
                yield _line({"type": "done", "chunks": 0})
                return
            sample_offset = 0
            phrases = speech_phrases(body.text)
            sequence = 0
            first_delivery: float | None = None
            seconds_per_char: float | None = None
            while phrases:
                buffered = (
                    max(0, sample_offset / 24000 - (time.monotonic() - first_delivery))
                    if first_delivery
                    else 0
                )
                batch_size = phrase_batch_size(phrases, buffered, seconds_per_char)
                phrase = "".join(phrases[:batch_size])
                phrases = phrases[batch_size:]
                started = time.monotonic()
                # Timeout also bounds time queued behind another inference.
                async with asyncio.timeout(90):
                    audio, _, cues, baseline = await lab_timing.synthesize_native(
                        phrase, body.voice
                    )
                packet = pcm_packet(audio, sequence, sample_offset, cues, baseline)
                async with get_session_factory()() as session:
                    await check_usage_limit(session, org_id, len(phrase))
                    await record_synthesis(
                        session, org_id, body.provider, len(phrase), False, source="dashboard"
                    )
                sample_offset += packet["sample_count"]
                elapsed = time.monotonic() - started
                # React immediately to slower inference, relax conservatively
                # after a cold first call. No client wall clock is trusted.
                seconds_per_char = max(elapsed / max(1, len(phrase)), (seconds_per_char or 0) * 0.8)
                packet["generation_ms"] = round(elapsed * 1000)
                first_delivery = first_delivery or time.monotonic()
                sequence += 1
                yield _line(packet)
            yield _line(
                {
                    "type": "done",
                    "chunks": sequence,
                    "total_samples": sample_offset,
                    "sample_rate": 24000,
                }
            )
        except asyncio.CancelledError:
            raise
        except Exception:
            # Broad on purpose: the headers are sent, so any failure is said
            # in the stream itself, where the client shows it.
            logger.exception("Lab speech stream failed")
            yield _line(
                {
                    "type": "error",
                    "code": "speech_stream_failed",
                    "detail": "Speech preparation was interrupted. Please try again. No automatic retry was made.",
                }
            )
        finally:
            release()

    return StreamingResponse(
        events(),
        media_type="application/x-ndjson",
        background=BackgroundTask(release),
        headers={"Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no"},
    )
