"""The expression pictures' job: made for an avatar now (the panel's Make,
or a publish with AI expressions on and none for its picture), followed by
the panel until it ends (the last end of each avatar is kept here, in this
process)."""

from __future__ import annotations

import json
import logging
from collections import OrderedDict

from app.core.errors import AppError, Conflict409, Forbidden403
from app.db import get_session_factory
from app.services import imagegen
from app.services.consent import ai_switched_off
from app.services.expression_kit.batch import BatchError
from app.services.expression_kit.batching import submit_for_avatar
from app.services.expression_kit.build import build_expressions
from app.services.expression_kit.constants import CONCURRENCY, EXPRESSIONS, EXPRESSIONS_CALL
from app.services.expression_kit.records import Source
from app.services.expression_kit.saving import (
    Origin,
    load_avatar,
    record_consent,
    require_person,
    save,
)
from app.services.jobs import DONE, FAILED, QUEUED, Job, runner
from app.services.mouth_kit import CallGuard
from app.services.performance_kit import KitFailed, KitUnavailable
from app.services.storage import get_storage
from app.services.usage import check_image_limit

logger = logging.getLogger("liveface.expression_kit")

JOB_STEP = "expression_kit"
MAKING_LABEL = "making the expressions"
SAVE_LABEL = "saving"
BATCH_LABEL = "sending the batch"
ended: OrderedDict[str, dict] = OrderedDict()
ENDED_KEPT = 256

# A failure asking again would repeat, until something changes.
NOT_RETRYABLE = frozenset(
    {
        "third_party_ai_disabled",
        "imagegen_unavailable",
        "landmarks_unavailable",
        "not_a_photo",
        "not_a_person",
        "source_gone",
        "avatar_not_found",
        "image_limit_reached",
    }
)


def job_out(job: Job, state: str, error: dict | None = None) -> dict:
    """A job as JobOut shows it (schemas.job)."""
    active = state not in (DONE, FAILED)
    return {
        "id": job.id,
        "step": JOB_STEP,
        "state": state,
        "error": error,
        "started_at": job.started_at,
        "progress": job.progress() if active else None,
        "retryable": state == FAILED and (error or {}).get("code") not in NOT_RETRYABLE,
    }


def job_view(avatar_id: str) -> dict | None:
    """The avatar's expressions job: live while queued or running, then how
    it ended, or None when this process ran none for it."""
    live = runner.active_for(avatar_id)
    if live is not None and live.step == JOB_STEP:
        return job_out(live, live.state)
    return ended.get(avatar_id)


def record_end(job: Job, state: str, error: dict | None = None) -> None:
    ended[job.subject_id] = job_out(job, state, error)
    ended.move_to_end(job.subject_id)
    while len(ended) > ENDED_KEPT:
        ended.popitem(last=False)


def start(
    avatar,
    consent_id: str,
    source: Source = "panel",
    revision: int | None = None,
    delivery: str = "now",
) -> dict:
    """Admit and launch the avatar's expressions job (runner.reserve: 409,
    429 or 503 as for any job) on `consent_id` (checked by the caller). A
    publish's job (`revision`) completes that publish when it ends; with
    `delivery` "batch" the job only sends the batch (batching). Returns its
    JobOut."""
    if runner.active_for(avatar.id) is not None:
        raise Conflict409(
            "Something is already being made for this avatar; wait for it to finish",
            code="expressions_in_progress",
        )
    job = runner.reserve(avatar.org_id, avatar.id, JOB_STEP, 0)
    params = {
        "consent_id": consent_id,
        "source": source,
        "revision": revision,
        "delivery": delivery,
    }
    ended.pop(avatar.id, None)
    runner.start(job, lambda j: run_job(j, params))
    return job_out(job, QUEUED)


async def run_job(job: Job, params: dict) -> None:
    try:
        await make_for_avatar(job, params)
    except AppError as exc:
        logger.info("expressions %s for avatar %s failed: %s", job.id, job.subject_id, exc.detail)
        record_end(job, FAILED, {"code": exc.code, "detail": exc.detail})
    except Exception:
        # Broad on purpose: the job boundary; the panel is told it failed.
        logger.exception("expressions %s for avatar %s crashed", job.id, job.subject_id)
        record_end(job, FAILED, {"code": "job_failed", "detail": "Something went wrong; try again"})
    else:
        record_end(job, DONE)


async def make_for_avatar(job: Job, params: dict) -> None:
    """The five pictures of the avatar's picture as it is now, through a
    CallGuard (the switch and the limit read again before each call, the
    consent recorded before the first picture leaves, each billed call
    metered as "expressions"), saved on the avatar (saving.save)."""
    org_id, avatar_id, consent_id = job.org_id, job.subject_id, params["consent_id"]
    if params.get("delivery") == "batch":
        job.report(0.2, BATCH_LABEL)
        try:
            await submit_for_avatar(org_id, avatar_id, consent_id, params.get("revision"))
        except BatchError as exc:
            raise AppError(str(exc), code="batch_refused") from exc
        job.report(1.0, BATCH_LABEL)
        return
    storage = get_storage()
    async with get_session_factory()() as db:
        avatar = await load_avatar(db, org_id, avatar_id)
        require_person(avatar)
        assert avatar is not None  # require_person refuses None
        image_key, rig_key = avatar.image_key, avatar.rig_key
        assert image_key is not None and rig_key is not None  # require_person checked both
        if await ai_switched_off(org_id):
            raise Forbidden403(
                "Your organization turned off third-party AI, so nothing was sent",
                code="third_party_ai_disabled",
            )
        if not imagegen.configured():
            raise Conflict409(
                "AI editing is not configured on this server", code="imagegen_unavailable"
            )
        await check_image_limit(db, org_id)
    if not await storage.exists(image_key) or not await storage.exists(rig_key):
        raise Conflict409("The avatar's picture is gone", code="source_gone")
    picture = await storage.get_bytes(image_key)
    points = json.loads(await storage.get_bytes(rig_key)).get("points")

    async def sending() -> None:
        await record_consent(org_id, avatar_id, consent_id)

    total = len(EXPRESSIONS)
    job.report(0.05, MAKING_LABEL, count=(0, total))

    def progress(fraction: float, message: str, done: int, count: int) -> None:
        job.report(0.05 + 0.85 * fraction, MAKING_LABEL, count=(done, count))

    guard = CallGuard(org_id, sending, call=EXPRESSIONS_CALL)
    try:
        async with runner.outside_slot(job):
            result = await build_expressions(
                picture,
                points,
                guard,
                concurrency=CONCURRENCY,
                bound_calls=False,
                on_progress=progress,
            )
    except KitUnavailable as exc:
        raise Conflict409(exc.detail, code=exc.code) from exc
    except KitFailed as exc:
        raise AppError(
            "The expression pictures could not be finished; try again", code="expressions_failed"
        ) from exc
    job.report(0.92, SAVE_LABEL)
    origin = Origin(org_id, avatar_id, points, params["source"], params.get("revision"))
    await save(origin, result)
    job.report(1.0, SAVE_LABEL)
