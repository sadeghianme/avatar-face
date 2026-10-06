"""Creation rows, as the owner's requests read and change them.

Every query filters on the creation id AND the org from the path, so another
org's creation id is simply not found. A content change is one conditional
UPDATE on the revision the request read (the first rule in the package
docstring): a concurrent change wins, and this one is refused.
"""

from __future__ import annotations

import logging

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import Conflict409, NotFound404
from app.db import execute_dml
from app.models import Creation, CreationStatus
from app.services.creations import rules
from app.services.creations.rules import creation_prefix
from app.services.storage import STORAGE_ERRORS, get_storage

logger = logging.getLogger("liveface.creations")


async def get(db: AsyncSession, org_id: str, creation_id: str) -> Creation:
    """The org's creation as stored now (404 creation_not_found)."""
    creation = (
        await db.execute(
            select(Creation)
            .where(Creation.id == creation_id, Creation.org_id == org_id)
            # Always the row as stored: updates here are statements, not
            # attribute edits, and the identity map would otherwise answer
            # with what this session saw before them.
            .execution_options(populate_existing=True)
        )
    ).scalar_one_or_none()
    if creation is None:
        raise NotFound404("Creation not found", code="creation_not_found")
    return creation


async def reloaded(db: AsyncSession, creation: Creation) -> Creation:
    """`creation` read again, after a change."""
    return await get(db, creation.org_id, creation.id)


async def update_content(db: AsyncSession, creation: Creation, **values) -> None:
    """A content change: bumps the revision, and applies only to the state
    the caller read. A concurrent change wins; this one is refused."""
    written = await execute_dml(
        db,
        update(Creation)
        .where(
            Creation.id == creation.id,
            Creation.org_id == creation.org_id,
            Creation.revision == creation.revision,
            Creation.status == CreationStatus.draft,
        )
        .values(**values, revision=Creation.revision + 1),
    )
    if written != 1:
        await db.rollback()
        raise Conflict409("The creation changed; reload it", code="creation_changed")
    await db.commit()


async def check_draft_limit(db: AsyncSession, org_id: str) -> None:
    """Refuse a new creation past the org's draft limit (409 too_many_drafts)."""
    # A soft limit: two requests racing past it make eleven, which is fine.
    drafts = (
        await db.execute(
            select(func.count())
            .select_from(Creation)
            .where(Creation.org_id == org_id, Creation.status == CreationStatus.draft)
        )
    ).scalar_one()
    if drafts >= rules.MAX_DRAFTS_PER_ORG:
        raise Conflict409(
            f"You have {drafts} unfinished avatars; finish or delete one first",
            code="too_many_drafts",
        )


async def recent(
    db: AsyncSession, org_id: str, status: CreationStatus | None, limit: int
) -> list[Creation]:
    """The org's creations (with `status`, if given), newest activity first."""
    query = select(Creation).where(Creation.org_id == org_id)
    if status is not None:
        query = query.where(Creation.status == status)
    rows = (
        await db.execute(query.order_by(Creation.updated_at.desc()).limit(limit))
    ).scalars().all()
    return list(rows)


async def delete(db: AsyncSession, creation: Creation) -> None:
    """Delete the creation and its files now (409 creation_finishing while
    its avatar is being built). A job still running for it finds the row
    gone and throws its result away.

    Files first: the row is the only thing that leads anyone (the owner, the
    expiry sweep) back to them. Deleted after the row, a failed delete would
    orphan the photos for good, the raw upload with its EXIF included; this
    way it fails the request with the row intact, and pressing Delete again
    (or expiry) finishes the job.
    """
    if creation.status == CreationStatus.finishing:
        raise Conflict409(
            "The avatar is being built from this; wait a moment", code="creation_finishing"
        )
    storage = get_storage()
    creation_id = creation.id
    prefix = creation_prefix(creation.org_id, creation_id)
    await storage.delete_prefix(prefix)
    await db.delete(creation)
    await db.commit()
    # Once more, for a job that stored its result between the first pass and
    # the commit. A job storing after the commit finds no row and deletes its
    # own file, so this pass is tidying only; a failure here is not the
    # owner's problem.
    try:
        await storage.delete_prefix(prefix)
    except STORAGE_ERRORS:
        logger.exception("second file pass failed for deleted creation %s", creation_id)
