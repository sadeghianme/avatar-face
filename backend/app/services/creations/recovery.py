"""Restart and expiry: creations no task is working on put back where the
owner can act, and idle drafts expired."""

from __future__ import annotations

import logging
from collections.abc import Callable
from typing import Any

from sqlalchemy import delete, or_, select, update

from app.db import execute_dml, get_session_factory
from app.models import Avatar, AvatarStatus, Creation, CreationStatus
from app.models.base import utcnow
from app.services.jobs import (
    ACTIVE_STATES,
    INTERRUPTED,
    runner,
)
from app.services.storage import get_storage
from app.services.creations.records import error_record
from app.services.creations.rules import (
    ENDED_RETENTION,
    IDLE_EXPIRY,
    avatar_prefix,
    creation_prefix,
)

logger = logging.getLogger("liveface.creations")


INTERRUPTED_ERROR = error_record(
    "interrupted", "This was interrupted by a server restart; try again"
)


async def recover_interrupted(db, running: Callable[[str], bool] = lambda _id: False) -> int:
    """Creations no task is working on any more, put where the owner can act.

    Two states need a live task to ever leave them: a job record left queued
    or running, and the `finishing` status. At startup no task is live (the
    previous process's died with it), so every such row is stranded. Later,
    `running` says which creations still have a task in this process, and a
    row in either state without one was stranded by a failure in the failure
    path (the undo of a finish, or the job's FAILED write, could not reach
    the database). Without this the wizard would wait forever.

    The job becomes interrupted and retryable (a job that did record its
    failure keeps that record). A creation caught finishing goes back to
    draft, and the avatar it was building (never published: the final
    commit publishes and finishes in one transaction) is removed with its
    files. Returns the number of creations recovered.
    """
    stranded = or_(
        Creation.job["state"].as_string().in_(sorted(ACTIVE_STATES)),
        Creation.status == CreationStatus.finishing,
    )
    rows = (await db.execute(select(Creation).where(stranded))).scalars().all()
    orphans: list[tuple[str, str]] = []
    recovered = 0
    for creation in rows:
        if running(creation.id):
            continue
        # Read before the update, which synchronises the loaded row with the
        # values it sets (avatar_id becomes None).
        org_id, avatar_id, status = creation.org_id, creation.avatar_id, creation.status
        record = creation.job or {}
        values: dict[str, Any] = {}
        # Only the state as read: a job accepted since then (a new record id,
        # a new status) is live and not this pass's to touch.
        where = [Creation.id == creation.id, Creation.status == status]
        if record.get("id"):
            where.append(Creation.job["id"].as_string() == record["id"])
        if record.get("state") in ACTIVE_STATES:
            values["job"] = {**record, "state": INTERRUPTED, "error": INTERRUPTED_ERROR}
        finishing = status == CreationStatus.finishing
        if finishing:
            values.update(status=CreationStatus.draft, avatar_id=None)
        if await execute_dml(db, update(Creation).where(*where).values(**values)) != 1:
            continue
        recovered += 1
        if finishing and avatar_id:
            await db.execute(
                delete(Avatar).where(
                    Avatar.id == avatar_id,
                    Avatar.org_id == org_id,
                    Avatar.status != AvatarStatus.ready,
                )
            )
            orphans.append((org_id, avatar_id))
    await db.commit()
    storage = get_storage()
    for org_id, avatar_id in orphans:
        await storage.delete_prefix(avatar_prefix(org_id, avatar_id))
    return recovered


async def recover_stranded() -> int:
    """recover_interrupted while this process runs: only creations with no
    task in the runner. The sweeper calls it on its timer."""
    async with get_session_factory()() as db:
        recovered = await recover_interrupted(
            db, running=lambda creation_id: runner.active_for(creation_id) is not None
        )
    if recovered:
        logger.warning("recovered %d stranded creation(s)", recovered)
    return recovered


async def expire_idle() -> int:
    """Expire drafts idle past IDLE_EXPIRY and delete their files; purge
    finished and expired rows past ENDED_RETENTION. The number expired.

    By rows, not by file age: a draft someone resumes today keeps images
    uploaded a week ago. A draft with a job running is never expired under it.
    """
    now = utcnow()
    storage = get_storage()
    expired: list[str] = []
    async with get_session_factory()() as db:
        idle = (
            await db.execute(
                select(Creation.id, Creation.org_id, Creation.job).where(
                    Creation.status == CreationStatus.draft,
                    Creation.updated_at < now - IDLE_EXPIRY,
                )
            )
        ).all()
        for creation_id, org_id, job in idle:
            if runner.active_for(creation_id) or (job or {}).get("state") in ACTIVE_STATES:
                continue
            changed = await execute_dml(
                db,
                update(Creation)
                .where(
                    Creation.id == creation_id,
                    Creation.status == CreationStatus.draft,
                    Creation.updated_at < now - IDLE_EXPIRY,
                )
                .values(status=CreationStatus.expired, steps=None, anchors=None),
            )
            if changed == 1:
                expired.append(creation_prefix(org_id, creation_id))
        ended = (
            await db.execute(
                select(Creation.id, Creation.org_id).where(
                    Creation.status.in_([CreationStatus.finished, CreationStatus.expired]),
                    Creation.updated_at < now - ENDED_RETENTION,
                )
            )
        ).all()
        if ended:
            await db.execute(delete(Creation).where(Creation.id.in_([row[0] for row in ended])))
        await db.commit()
    # Idempotent, so a finish that crashed before deleting its files is
    # cleaned up here too.
    for prefix in expired + [creation_prefix(org_id, cid) for cid, org_id in ended]:
        await storage.delete_prefix(prefix)
    if expired:
        logger.info("expired %d idle creation(s)", len(expired))
    return len(expired)
