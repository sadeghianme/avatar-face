"""Starting a creation's job, and running it: the work each step does
(WORKS), with how it ended recorded on the row."""

from __future__ import annotations

import logging

from sqlalchemy import update

from app.core.errors import AppError, Conflict409
from app.db import execute_dml
from app.models import Creation, CreationStatus
from app.services.creations.adjust import run_adjust
from app.services.creations.detect import run_detect
from app.services.creations.finish import run_finish
from app.services.creations.generate import run_generate
from app.services.creations.ingest import run_background, run_ingest
from app.services.creations.records import error_record, job_record, write_job
from app.services.jobs import (
    FAILED,
    QUEUED,
    RUNNING,
    Job,
    runner,
)
from app.services.wizard import prepare_job

logger = logging.getLogger("liveface.creations")


async def start_job(
    db,
    creation: Creation,
    step: str,
    params: dict,
    values: dict | None = None,
    bump: bool = False,
) -> Job:
    """Accept a job for `creation` and launch it.

    Admission first (runner.reserve: 409, 429 or 503), then the queued state
    is written with the same revision condition every mutation uses, so a
    job is never accepted against a state that already changed. `values`
    rides along in that write (finish uses it for draft → finishing), and
    anything the caller added to `db` is committed with it.

    `bump`: `values` change the content (choosing an AI result, whose
    cut-out the job makes), so the revision moves on in the same write and
    the job belongs to the state after it. Either both happen or neither:
    a refused admission leaves the choice unmade.
    """
    revision = creation.revision + (1 if bump else 0)
    job = runner.reserve(creation.org_id, creation.id, step, revision)
    extra = {"revision": Creation.revision + 1} if bump else {}
    try:
        written = await execute_dml(
            db,
            update(Creation)
            .where(
                Creation.id == creation.id,
                Creation.org_id == creation.org_id,
                Creation.revision == creation.revision,
                Creation.status == CreationStatus.draft,
            )
            .values(job=job_record(job, QUEUED, params), **(values or {}), **extra),
        )
        if written != 1:
            await db.rollback()
            raise Conflict409("The creation changed; reload it", code="creation_changed")
        await db.commit()
    except BaseException:
        runner.release(job)
        raise
    launch(job, params)
    return job


def launch(job: Job, params: dict) -> None:
    runner.start(job, lambda j: run_job(j, params))


async def run_job(job: Job, params: dict) -> None:
    """Run a job's work and record how it ended. The work records success
    itself, in the same write as its result."""
    await write_job(job, RUNNING, params)
    try:
        await WORKS[job.step](job, params)
    except AppError as exc:
        logger.info("job %s (%s) failed: %s", job.id, job.step, exc.detail)
        await write_job(job, FAILED, params, error_record(exc.code, exc.detail))
    except Exception:
        # Broad on purpose: the job boundary. Whatever the work raised, the
        # row says the job failed, and the owner can retry it.
        logger.exception("job %s (%s) crashed", job.id, job.step)
        await write_job(
            job, FAILED, params, error_record("job_failed", "Something went wrong; try again")
        )


async def run_prepare(job: Job, params: dict) -> None:
    """The four-step wizard's step 3 (services.wizard.prepare_job)."""
    await prepare_job(job, params)


WORKS = {
    "ingest": run_ingest,
    "generate": run_generate,
    "background": run_background,
    "adjust": run_adjust,
    "detect": run_detect,
    "finish": run_finish,
    "prepare": run_prepare,
}
