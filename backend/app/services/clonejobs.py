"""Voice-clone jobs: recorded in the browser, rendered on the operator's Mac.

Cloning needs Apple Silicon or a GPU, which the server does not have, so the
dashboard cannot do the work — but it can hold the queue. A job is the
reference recording plus the lines to render; a worker running where the
hardware is (scripts/clone_worker.py) claims jobs, renders them with
Chatterbox, uploads the audio through the cloned-voices endpoints, and marks
the job done. The user records, watches progress, and plays the result
without leaving the UI.

Jobs live in OBJECT STORAGE, not a database table, and that is a deliberate
dodge: a parallel work stream has an uncommitted migration in flight, and
chaining onto it (or beside it) either breaks production's migration chain
or creates two alembic heads. Jobs are transient progress artifacts — the
durable output is speech-cache rows written by the upload endpoint — so a
JSON document per job plus a per-org index is exactly enough, and nothing
about the schema is worth a migration hazard.

The index is read-modify-write without a lock. Fine here: jobs are created
and claimed by one operator's dashboard and one worker, not by concurrent
customers. If cloning ever becomes customer-facing, this moves to a table.
"""

from __future__ import annotations

import json
import time
from uuid import uuid4

STATUSES = ("pending", "processing", "done", "failed")
# A worker that claimed a job and died must not wedge it forever: past this,
# the job may be claimed again.
CLAIM_TIMEOUT_SECONDS = 15 * 60


def _index_key(org_id: str) -> str:
    return f"orgs/{org_id}/clone-jobs/index.json"


def _job_key(org_id: str, job_id: str) -> str:
    return f"orgs/{org_id}/clone-jobs/{job_id}/job.json"


def reference_key(org_id: str, job_id: str) -> str:
    return f"orgs/{org_id}/clone-jobs/{job_id}/reference.wav"


async def _read_index(storage, org_id: str) -> list[str]:
    if not await storage.exists(_index_key(org_id)):
        return []
    try:
        return json.loads(await storage.get_bytes(_index_key(org_id)))
    except Exception:
        return []


async def _write_index(storage, org_id: str, ids: list[str]) -> None:
    await storage.put_bytes(
        _index_key(org_id), json.dumps(ids).encode(), "application/json"
    )


async def _read_job(storage, org_id: str, job_id: str) -> dict | None:
    key = _job_key(org_id, job_id)
    if not await storage.exists(key):
        return None
    try:
        return json.loads(await storage.get_bytes(key))
    except Exception:
        return None


async def _write_job(storage, org_id: str, job: dict) -> None:
    await storage.put_bytes(
        _job_key(org_id, job["id"]), json.dumps(job).encode(), "application/json"
    )


async def create_job(
    storage, org_id: str, *, name: str, locale: str, lines: list[str], reference: bytes
) -> dict:
    job = {
        "id": uuid4().hex,
        "name": name,
        "locale": locale,
        "lines": lines,
        "status": "pending",
        "error": None,
        "done_lines": 0,
        "created_at": time.time(),
        "claimed_at": None,
        "finished_at": None,
    }
    await storage.put_bytes(reference_key(org_id, job["id"]), reference, "audio/wav")
    await _write_job(storage, org_id, job)
    ids = await _read_index(storage, org_id)
    await _write_index(storage, org_id, [job["id"], *ids])
    return job


async def list_jobs(storage, org_id: str) -> list[dict]:
    jobs = []
    for job_id in await _read_index(storage, org_id):
        job = await _read_job(storage, org_id, job_id)
        if job is not None:
            jobs.append(job)
    return jobs


async def get_job(storage, org_id: str, job_id: str) -> dict | None:
    return await _read_job(storage, org_id, job_id)


async def claim_next(storage, org_id: str) -> dict | None:
    """Oldest claimable job, marked processing. None when the queue is empty.

    A processing job whose claim has expired is claimable again — the worker
    that took it is presumed dead, and re-rendering a line is idempotent
    (uploads replace by cache key).
    """
    now = time.time()
    ids = await _read_index(storage, org_id)
    for job_id in reversed(ids):  # oldest first: index is newest-first
        job = await _read_job(storage, org_id, job_id)
        if job is None:
            continue
        expired = (
            job["status"] == "processing"
            and (now - (job["claimed_at"] or 0)) > CLAIM_TIMEOUT_SECONDS
        )
        if job["status"] == "pending" or expired:
            job["status"] = "processing"
            job["claimed_at"] = now
            job["error"] = None
            await _write_job(storage, org_id, job)
            return job
    return None


async def update_progress(storage, org_id: str, job_id: str, done_lines: int) -> dict | None:
    job = await _read_job(storage, org_id, job_id)
    if job is None:
        return None
    job["done_lines"] = done_lines
    job["claimed_at"] = time.time()  # progress renews the claim
    await _write_job(storage, org_id, job)
    return job


async def finish_job(
    storage, org_id: str, job_id: str, *, error: str | None = None
) -> dict | None:
    job = await _read_job(storage, org_id, job_id)
    if job is None:
        return None
    job["status"] = "failed" if error else "done"
    job["error"] = error
    job["finished_at"] = time.time()
    if not error:
        job["done_lines"] = len(job["lines"])
    await _write_job(storage, org_id, job)
    return job


async def delete_job(storage, org_id: str, job_id: str) -> bool:
    job = await _read_job(storage, org_id, job_id)
    if job is None:
        return False
    await storage.delete(_job_key(org_id, job_id))
    try:
        await storage.delete(reference_key(org_id, job_id))
    except Exception:
        pass
    ids = [i for i in await _read_index(storage, org_id) if i != job_id]
    await _write_index(storage, org_id, ids)
    return True
