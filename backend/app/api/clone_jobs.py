"""The queue between the dashboard's recorder and the operator's Mac.

The user records a reference and submits lines in the UI; a worker with real
hardware (scripts/clone_worker.py) claims the job, renders, uploads through
the cloned-voices endpoints, and reports back. Everything here is org-scoped
dashboard auth — the worker authenticates exactly like a dashboard user,
because it is one: the operator's own token.
"""

from __future__ import annotations

import json
import logging

from fastapi import APIRouter, File, Form, UploadFile
from pydantic import BaseModel, Field

from app.api.deps import DB, OrgMember
from app.core.errors import NotFound404, Validation422
from app.services import clonejobs
from app.services.storage import get_storage

logger = logging.getLogger("liveface.clonejobs")
router = APIRouter(prefix="/orgs/{org_id}/clone-jobs", tags=["clone-jobs"])

MAX_REFERENCE_BYTES = 15 * 1024 * 1024
MAX_LINES = 100
MAX_LINE_CHARS = 500

# db dependency unused here but kept: OrgMember resolution needs the session.
_ = DB


class ProgressIn(BaseModel):
    done_lines: int = Field(ge=0, le=MAX_LINES)


class FailIn(BaseModel):
    error: str = Field(min_length=1, max_length=1000)


@router.post("", status_code=201)
async def create_job(
    ctx: OrgMember,
    name: str = Form(...),
    locale: str = Form("en-US"),
    lines: str = Form(...),  # JSON array of strings
    consent: bool = Form(False),
    reference: UploadFile = File(...),
) -> dict:
    """Queue a clone: reference recording + the lines to render.

    Consent is checked at the door as well as at upload time — refusing
    before any audio is stored beats storing a likeness and refusing later.
    """
    if not consent:
        raise Validation422(
            "Confirm this is your voice or you have the speaker's permission",
            code="consent_required",
        )
    if len(name) > 64 or ":" in name or "/" in name:
        raise Validation422("Voice name must be short and plain", code="bad_name")
    try:
        parsed = json.loads(lines)
        assert isinstance(parsed, list) and all(isinstance(l, str) for l in parsed)
    except Exception:
        raise Validation422("lines must be a JSON array of strings", code="bad_lines")
    cleaned = [line.strip() for line in parsed if line.strip()]
    if not cleaned:
        raise Validation422("At least one line is required", code="bad_lines")
    if len(cleaned) > MAX_LINES or any(len(l) > MAX_LINE_CHARS for l in cleaned):
        raise Validation422(
            f"At most {MAX_LINES} lines of {MAX_LINE_CHARS} characters", code="bad_lines"
        )

    data = await reference.read()
    if len(data) > MAX_REFERENCE_BYTES:
        raise Validation422("Reference audio exceeds 15MB", code="audio_too_large")
    if len(data) < 1000:
        raise Validation422("Reference audio is empty", code="audio_too_small")

    return await clonejobs.create_job(
        get_storage(), ctx.org.id, name=name, locale=locale, lines=cleaned, reference=data
    )


@router.get("")
async def list_jobs(ctx: OrgMember) -> list[dict]:
    return await clonejobs.list_jobs(get_storage(), ctx.org.id)


@router.post("/claim")
async def claim(ctx: OrgMember) -> dict:
    """Worker: take the oldest waiting job. 404 when the queue is empty —
    an empty queue is the steady state, not an error worth logging."""
    storage = get_storage()
    job = await clonejobs.claim_next(storage, ctx.org.id)
    if job is None:
        raise NotFound404("No jobs waiting", code="queue_empty")
    return {
        **job,
        "reference_url": await storage.presign_get(
            clonejobs.reference_key(ctx.org.id, job["id"])
        ),
    }


@router.post("/{job_id}/progress")
async def progress(job_id: str, body: ProgressIn, ctx: OrgMember) -> dict:
    job = await clonejobs.update_progress(get_storage(), ctx.org.id, job_id, body.done_lines)
    if job is None:
        raise NotFound404("No such job", code="job_not_found")
    return job


@router.post("/{job_id}/complete")
async def complete(job_id: str, ctx: OrgMember) -> dict:
    job = await clonejobs.finish_job(get_storage(), ctx.org.id, job_id)
    if job is None:
        raise NotFound404("No such job", code="job_not_found")
    logger.info("clone job %s completed for org %s", job_id, ctx.org.id)
    return job


@router.post("/{job_id}/fail")
async def fail(job_id: str, body: FailIn, ctx: OrgMember) -> dict:
    job = await clonejobs.finish_job(get_storage(), ctx.org.id, job_id, error=body.error)
    if job is None:
        raise NotFound404("No such job", code="job_not_found")
    return job


@router.delete("/{job_id}", status_code=204)
async def remove(job_id: str, ctx: OrgMember) -> None:
    if not await clonejobs.delete_job(get_storage(), ctx.org.id, job_id):
        raise NotFound404("No such job", code="job_not_found")
