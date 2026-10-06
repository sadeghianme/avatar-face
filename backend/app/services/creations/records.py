"""What a creation's row keeps of its jobs, and the writes a job makes:
its state transitions, its result (only onto the state it was computed
from: the module docstring of services.creations), and the AI budget."""

from __future__ import annotations

import copy
import logging
from collections.abc import Callable

from sqlalchemy import select, update

from app.core.errors import AppError, Forbidden403
from app.db import execute_dml, get_session_factory
from app.models import Creation, CreationStatus
from app.services.consent import ai_switched_off
from app.services.jobs import (
    DONE,
    FAILED,
    INTERRUPTED,
    Job,
)
from app.services.storage import get_storage

logger = logging.getLogger("liveface.creations")


def error_record(code: str, detail: str) -> dict:
    return {"code": code, "detail": detail}


# A retry would fail the same way: the file, the marks or the line is the
# problem, and only the owner can change it.
NOT_RETRYABLE = frozenset(
    {
        "unreadable_image", "image_too_large", "anchors_stale", "fit_invalid",
        # AI: a refusal is never asked again, and a photo the touch-up
        # cannot use stays unusable.
        "safety_refused", "face_turned", "no_face_for_touchup", "landmarks_unavailable",
        "imagegen_unavailable", "source_gone",
        # The organization turned third-party AI off while the job waited.
        "third_party_ai_disabled",
    }
)


def retryable(record: dict) -> bool:
    """Would POST /retry run this job record's job again? A failed or
    interrupted one, unless it failed in a way a retry would repeat."""
    return (
        record["state"] in (FAILED, INTERRUPTED)
        and (record.get("error") or {}).get("code") not in NOT_RETRYABLE
    )


def job_record(
    job: Job, state: str, params: dict | None = None, error: dict | None = None
) -> dict:
    """What the row keeps of a job: its state transitions, and the
    parameters a retry needs while it may still be retried."""
    record = {
        "id": job.id,
        "step": job.step,
        "state": state,
        "error": error,
        "started_at": job.started_at,
    }
    if state != DONE:
        record["params"] = params or {}
    return record


async def write_job(job: Job, state: str, params: dict, error: dict | None = None) -> None:
    """A state transition. Never touches the revision: a job must not
    invalidate its own result by reporting that it runs."""
    async with get_session_factory()() as db:
        await db.execute(
            update(Creation)
            .where(Creation.id == job.subject_id, Creation.org_id == job.org_id)
            .values(job=job_record(job, state, params, error))
        )
        await db.commit()


SUPERSEDED = error_record(
    "superseded", "The creation changed while this was running, so its result was discarded"
)


async def store_result(job: Job, params: dict, values: dict, new_keys: list[str]) -> bool:
    """Store a job's result if the creation is still the one it started
    from; otherwise delete what the job wrote and say so. See the module
    docstring for why the revision decides."""
    async with get_session_factory()() as db:
        stored = await execute_dml(
            db,
            update(Creation)
            .where(
                Creation.id == job.subject_id,
                Creation.org_id == job.org_id,
                Creation.revision == job.revision,
                Creation.status == CreationStatus.draft,
            )
            .values(**values, revision=Creation.revision + 1, job=job_record(job, DONE)),
        )
        await db.commit()
    if stored == 1:
        return True
    storage = get_storage()
    for key in new_keys:
        await storage.delete(key)
    await write_job(job, FAILED, params, SUPERSEDED)
    logger.info("job %s (%s) discarded: creation %s changed", job.id, job.step, job.subject_id)
    return False


def ai_usage_of(creation: Creation) -> dict:
    """A copy of the creation's AI budget and cache, with every field."""
    usage = copy.deepcopy(creation.ai_usage or {})
    usage.setdefault("adjust_rounds", 0)
    usage.setdefault("detections", 0)
    usage.setdefault("next_adjusted", 0)
    usage.setdefault("vision_cache", [])
    # The four-step wizard's AI runs on step 3 (services.wizard).
    usage.setdefault("prepare_rounds", 0)
    # "Remove this change" redos that gave their try back (services.wizard).
    usage.setdefault("free_clears", 0)
    return usage


async def update_ai_usage(job: Job, change: Callable[[dict], None]) -> None:
    """Apply `change` to the stored AI usage, outside the revision rule.

    The budget and the cache record money already spent, which stays spent
    whether or not the job's image result is kept; tying them to the
    revision would let a reframe mid-call refund a paid request, or lose a
    paid answer. Safe without a condition because the only other writer is
    job admission, which cannot happen while this job is active.
    """
    async with get_session_factory()() as db:
        row = (
            await db.execute(
                select(Creation).where(
                    Creation.id == job.subject_id, Creation.org_id == job.org_id
                )
            )
        ).scalar_one_or_none()
        if row is None:
            return
        usage = ai_usage_of(row)
        change(usage)
        await db.execute(
            update(Creation)
            .where(Creation.id == job.subject_id, Creation.org_id == job.org_id)
            .values(ai_usage=usage)
        )
        await db.commit()


async def ai_switched_off_now(org_id: str) -> bool:
    """Has the organization turned third-party AI off since the job was
    admitted?

    Admission checks the switch, but a job can wait in the queue for
    minutes and an adjust round makes two calls 90 s apart: an owner who
    turns AI off (after a complaint, say) means no pixel leaves from then
    on, not from the next request. So it is read again before every
    provider call, next to the image limit.
    """
    return await ai_switched_off(org_id)


def ai_disabled_error() -> AppError:
    return Forbidden403(
        "Your organization turned off third-party AI, so nothing was sent",
        code="third_party_ai_disabled",
    )


async def load_creation(job: Job) -> Creation | None:
    async with get_session_factory()() as db:
        return (
            await db.execute(
                select(Creation).where(
                    Creation.id == job.subject_id, Creation.org_id == job.org_id
                )
            )
        ).scalar_one_or_none()
