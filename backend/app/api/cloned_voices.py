"""Upload audio rendered by a cloned voice elsewhere.

Cloning runs on the operator's own hardware — a laptop with Apple Silicon or
a GPU box — because it is several times slower than real time and cannot sit
inside a request. What arrives here is the finished audio for lines that were
known in advance.

Each upload becomes a speech-cache row, which is what makes this a few
endpoints instead of a subsystem: playback, metering and the embed path
already treat a cache hit as the normal case.
"""

from __future__ import annotations

import io
import wave

from fastapi import APIRouter, File, Form, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import Row

from app.api.deps import DB, OrgMember
from app.core.errors import Validation422
from app.services.tts import cloned

router = APIRouter(prefix="/orgs/{org_id}/cloned-voices", tags=["cloned-voices"])

MAX_AUDIO_BYTES = 10 * 1024 * 1024
MAX_TEXT_CHARS = 1000


class ClonedLine(BaseModel):
    text: str = Field(min_length=1, max_length=MAX_TEXT_CHARS)
    locale: str = Field(default="en-US", max_length=16)


class ClonedVoiceOut(BaseModel):
    voice: str
    label: str
    lines: int
    total_ms: int
    # The locale its lines were rendered in, so the picker can set all three
    # of provider/voice/locale from one selection.
    locale: str = "en-US"


def _wav_facts(data: bytes) -> tuple[int, int]:
    """(duration_ms, sample_rate). Rejects anything that is not a real WAV.

    Parsed rather than trusted: the duration drives the viseme track, so a
    wrong number is a mouth that stops moving while the voice keeps talking.
    """
    try:
        with wave.open(io.BytesIO(data)) as handle:
            frames, rate = handle.getnframes(), handle.getframerate()
    except (wave.Error, EOFError) as exc:
        raise Validation422(
            f"Audio must be a WAV file ({exc})", code="not_a_wav"
        ) from exc
    if not rate:
        raise Validation422("WAV has no sample rate", code="not_a_wav")
    return int(frames * 1000 / rate), rate


@router.get("", response_model=list[ClonedVoiceOut])
async def list_cloned_voices(ctx: OrgMember, db: DB) -> list[ClonedVoiceOut]:
    """Voices this org has uploaded, with how much is rendered for each."""
    return [_voice_out(row.voice, row) for row in await cloned.voice_summaries(db, ctx.org.id)]


@router.post("/{name}/lines", response_model=ClonedVoiceOut)
async def upload_line(
    name: str,
    ctx: OrgMember,
    db: DB,
    text: str = Form(...),
    locale: str = Form("en-US"),
    consent: bool = Form(False),
    audio: UploadFile = File(...),
) -> ClonedVoiceOut:
    """Store one rendered line for a cloned voice.

    `consent` is required and recorded per upload rather than once per voice.
    A cloned voice is someone's likeness; the attestation should sit against
    the act that publishes it, and a per-voice flag set months earlier by a
    different team member is not an attestation of anything.
    """
    if not consent:
        raise Validation422(
            "Confirm you own this voice or have the speaker's permission",
            code="consent_required",
        )
    if len(name) > 64 or ":" in name:
        raise Validation422("Voice name must be short and contain no colon", code="bad_name")

    data = await audio.read()
    if len(data) > MAX_AUDIO_BYTES:
        raise Validation422("Audio exceeds 10MB", code="audio_too_large")
    duration_ms, _ = _wav_facts(data)

    voice = await cloned.upload_line(db, ctx.org.id, name, locale, text, data, duration_ms)
    return _voice_out(voice, await cloned.voice_summary(db, voice))


@router.delete("/{name}", status_code=204)
async def delete_cloned_voice(name: str, ctx: OrgMember, db: DB) -> None:
    """Remove a cloned voice and every line rendered for it.

    A hard delete, not a flag: the whole point of a takedown path for a
    likeness is that the audio stops existing.
    """
    await cloned.delete_voice(db, ctx.org.id, name)


def _voice_out(voice: str, row: Row) -> ClonedVoiceOut:
    return ClonedVoiceOut(
        voice=voice,
        label=voice.partition(":")[2],
        lines=row.lines,
        total_ms=int(row.total_ms or 0),
        locale=row.locale or "en-US",
    )
