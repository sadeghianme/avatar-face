"""Finishing: the job that builds the avatar from the confirmed marks and
publishes it, and its undo when anything fails."""

from __future__ import annotations

import asyncio
import io
import json
import logging
from uuid import uuid4

import numpy as np
from sqlalchemy import delete, select, update

from app.core.errors import Conflict409, Validation422
from app.db import execute_dml, get_session_factory
from app.models import Avatar, AvatarStatus, Creation, CreationStatus
from app.services.jobs import (
    DONE,
    Job,
    run_cpu,
)
from app.services.storage import get_storage
from app.services.creations.detect import anchors_are_current, fit_from_anchors
from app.services.creations.mouth import (
    PUBLISH_LABEL,
    PUBLISH_STANDARD_LABEL,
    _animal_character_mouth,
    _own_mouth,
)
from app.services.creations.records import job_record
from app.services.creations.rules import avatar_prefix, creation_prefix, rules_for
from app.services.creations.steps import (
    background_source,
    current_step,
    is_cutout_id,
    step_items,
)

logger = logging.getLogger("liveface.creations")


async def _finish(job: Job, params: dict) -> None:
    """Build the avatar from the confirmed marks, publish it, and let the
    creation go. Any failure puts the creation back to draft and removes
    the half-built avatar, so pressing Finish again starts clean.

    No database connection is held while the avatar is built: a person's
    mouth waits on the image model for up to minutes (services.mouth_kit),
    and the connection pool is shared with every customer's widget. The two
    rows are read, the build works on them detached, and what it changed
    is written in one short transaction at the end, which also finishes the
    creation. An avatar row deleted meanwhile fails that write (the UPDATE
    matches nothing) rather than being written again."""
    storage = get_storage()
    async with get_session_factory()() as db:
        creation = (
            await db.execute(
                select(Creation).where(
                    Creation.id == job.subject_id,
                    Creation.org_id == job.org_id,
                    Creation.status == CreationStatus.finishing,
                )
            )
        ).scalar_one_or_none()
        if creation is None:
            return
        avatar = (
            await db.execute(
                select(Avatar).where(
                    Avatar.id == creation.avatar_id, Avatar.org_id == creation.org_id
                )
            )
        ).scalar_one_or_none()
    org_id, creation_id, avatar_id = creation.org_id, creation.id, creation.avatar_id
    generated = (step_items(creation.steps).get("original") or {}).get("generated")
    try:
        if avatar is None:
            raise RuntimeError("the avatar being finished is gone")
        await _build_avatar(job, creation, avatar, params, storage)
        async with get_session_factory()() as db:
            # The build's changes, flushed onto the avatar's row as an
            # UPDATE of what was read (autoflush, before the statement below).
            db.add(avatar)
            finished = await execute_dml(
                db,
                update(Creation)
                .where(Creation.id == creation_id, Creation.status == CreationStatus.finishing)
                .values(
                    status=CreationStatus.finished,
                    job=job_record(job, DONE),
                    consent_ids=creation.consent_ids,
                ),
            )
            if finished != 1:
                raise RuntimeError("the creation left finishing while it was built")
            await db.commit()
    except Exception:
        await _undo_finish_retrying(org_id, creation_id, avatar_id)
        raise
    # The avatar has its own copies now. Deleted after the commit, so a crash
    # in between leaves files the retention sweep removes, never an avatar
    # pointing at nothing.
    await storage.delete_prefix(creation_prefix(org_id, creation_id))
    if generated:
        # A generated picture someone kept: what the usage page counts as a
        # generated avatar (attempts are counted as they are made).
        from app.services.usage import record_generated_avatar

        try:
            async with get_session_factory()() as db:
                await record_generated_avatar(db, org_id, generated.get("provider") or "gemini")
        except Exception:
            logger.exception("could not record the kept generation of %s", creation_id)


async def _build_avatar(
    job: Job, creation: Creation, avatar: Avatar, params: dict, storage
) -> None:
    from app.services.anchor_fit import fit_base_key, fit_base_record, write_fit_base
    from app.services.layers import store_layers
    from app.services.publishing import publish
    from app.services.rig import make_thumbnail, write_thumbnail_key

    face_type = creation.face_type
    steps = creation.steps
    items = step_items(steps)
    current = current_step(steps)
    anchors = creation.anchors
    # Re-checked here, not only at the request: a retry after a restart
    # runs on whatever the row holds now.
    if (
        not anchors
        or not anchors_are_current(creation)
        or anchors.get("id") != params.get("anchors_id")
    ):
        raise Conflict409(
            "The marks belong to another image; place them again", code="anchors_stale"
        )
    # Current anchors were made on this line, on the current image.
    assert face_type is not None and current is not None
    rig, problems = fit_from_anchors(anchors, params.get("marks"), face_type)
    if problems:
        raise Validation422(
            "These marks would distort the face: " + "; ".join(p.detail for p in problems),
            code="fit_invalid",
        )

    prefix = avatar_prefix(avatar.org_id, avatar.id)
    stamp = uuid4().hex[:8]
    job.report(0.1, "copying images")

    async def copy_step(step_id: str, name: str) -> tuple[str, bytes]:
        data = await storage.get_bytes(items[step_id]["key"])
        key = f"{prefix}{name}-{stamp}.png"
        await storage.put_bytes(key, data, "image/png")
        return key, data

    avatar.image_key, image = await copy_step(current, "source")
    behind = background_source(steps)
    if behind != current and behind in items:
        # The photo before its background came off, so the avatar page can
        # offer to put the background back, as for any other cut-out.
        if is_cutout_id(current):
            avatar.original_image_key, _ = await copy_step(behind, "source-original")
        else:
            # A touch-up of a cut-out: its new eyes and lips over the photo
            # it was cut from, so putting the background back keeps them.
            backdrop = await storage.get_bytes(items[behind]["key"])
            opaque = await run_cpu(_over, image, backdrop)
            if opaque is not None:
                key = f"{prefix}source-original-{stamp}.png"
                await storage.put_bytes(key, opaque, "image/png")
                avatar.original_image_key = key
    avatar.upload_image_key, _ = await copy_step("original", "upload")

    job.report(0.35, "building the rig")
    rig_key = f"{prefix}rig.json"
    await storage.put_bytes(rig_key, json.dumps(rig).encode(), "application/json")
    base = np.array(anchors["base"], dtype=np.float64)
    await write_fit_base(
        storage,
        fit_base_key(avatar.org_id, avatar.id),
        fit_base_record(base, rig, bool(anchors.get("detected"))),
    )
    thumb, thumb_type = await run_cpu(make_thumbnail, image)
    thumb_key = write_thumbnail_key(avatar.org_id, avatar.id, thumb_type)
    await storage.put_bytes(thumb_key, thumb, thumb_type)

    avatar.has_layers = False
    if rules_for(face_type).layers:
        job.report(0.55, "building layers")
        # Optional by contract, as in the first build: no layers is a
        # working single-photo avatar.
        avatar.has_layers = await store_layers(avatar, storage, image, rig["face_box"])

    mouth_made = await _own_mouth(job, creation, avatar, image, rig, storage)
    _animal_character_mouth(creation, avatar)

    warnings = (anchors.get("validation") or {}).get("warnings") or []
    avatar.rig_key = rig_key
    avatar.thumbnail_key = thumb_key
    avatar.content_type = "image/png"
    avatar.status = AvatarStatus.ready
    avatar.error = None
    avatar.quality_note = warnings[0]["detail"] if warnings else None
    # Step 5 lists the person's mouth before publishing: whether it was made
    # is said here, since the stages it saw do not tell (a kit that broke
    # after its fourth shape went straight to publishing).
    job.report(0.92, PUBLISH_LABEL if mouth_made is not False else PUBLISH_STANDARD_LABEL)
    await publish(avatar, storage)


def _over(cut_out: bytes, backdrop: bytes) -> bytes | None:
    """`cut_out` composited over `backdrop` (same size), as an opaque PNG;
    None when their sizes differ. CPU work."""
    from PIL import Image

    from app.services.photo_io import png_bytes

    with Image.open(io.BytesIO(cut_out)) as top, Image.open(io.BytesIO(backdrop)) as below:
        if top.size != below.size:
            return None
        merged = Image.alpha_composite(below.convert("RGBA"), top.convert("RGBA"))
        return png_bytes(merged.convert("RGB"))


async def _undo_finish(org_id: str, creation_id: str, avatar_id: str | None) -> None:
    """Back to a draft, without the avatar that was being built."""
    async with get_session_factory()() as db:
        if avatar_id:
            await db.execute(
                delete(Avatar).where(
                    Avatar.id == avatar_id,
                    Avatar.org_id == org_id,
                    Avatar.status != AvatarStatus.ready,
                )
            )
        await db.execute(
            update(Creation)
            .where(Creation.id == creation_id, Creation.status == CreationStatus.finishing)
            .values(status=CreationStatus.draft, avatar_id=None)
        )
        await db.commit()
    if avatar_id:
        await get_storage().delete_prefix(avatar_prefix(org_id, avatar_id))


# Waits between attempts to put a failed finish back to draft. What failed
# the finish is often what fails the undo (SQLite still locked after its busy
# timeout), and that clears in seconds.
UNDO_FINISH_BACKOFF_SECONDS = (1.0, 3.0)


async def _undo_finish_retrying(org_id: str, creation_id: str, avatar_id: str | None) -> None:
    """_undo_finish, tried again a couple of times before giving up.

    Given up, the creation stays `finishing` with no task working on it, and
    nothing the owner can press moves it (Finish answers with the avatar,
    Delete refuses). recover_stranded, on the sweeper's timer and at startup,
    is what puts it back then; retrying here keeps that the rare case rather
    than an hour-long spinner.
    """
    for delay in (*UNDO_FINISH_BACKOFF_SECONDS, None):
        try:
            await _undo_finish(org_id, creation_id, avatar_id)
            return
        except Exception:
            if delay is None:
                logger.exception(
                    "could not put creation %s back to draft; the sweeper will", creation_id
                )
                return
            logger.warning("undoing finish of creation %s failed; retrying", creation_id)
            await asyncio.sleep(delay)
