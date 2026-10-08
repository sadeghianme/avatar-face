"""Undo.

One history instead of a reset button per feature. Each entry snapshots the
editable state *before* a change, so undo restores a known-good state rather
than trying to invert an operation — inverting a crop means knowing the
original size, inverting a background removal means keeping the old file, and
each new edit would add another special case.

The rig is copied rather than referenced, because operations like crop rewrite
rig.json in place: without a copy, undoing the image would leave landmarks in
cropped coordinates.
"""

from __future__ import annotations

import json
import logging
import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import Conflict409
from app.models import Avatar
from app.services import mouth_kit
from app.services.avatars.derived import rebuild_layers
from app.services.publishing import mark_dirty
from app.services.storage import STORAGE_ERRORS, Storage, get_storage

logger = logging.getLogger("liveface.avatars")

MAX_HISTORY = 12


async def snapshot(avatar: Avatar, storage: Storage, label: str) -> None:
    """Record the current state so the change about to happen can be undone."""
    entry = {
        "label": label,
        "image_key": avatar.image_key,
        "thumbnail_key": avatar.thumbnail_key,
        "original_image_key": avatar.original_image_key,
        "precrop_image_key": avatar.precrop_image_key,
        "framing": avatar.framing,
        "rig_snapshot_key": None,
    }
    if avatar.rig_key:
        key = f"orgs/{avatar.org_id}/avatars/{avatar.id}/history/{uuid.uuid4().hex}.json"
        try:
            await storage.put_bytes(
                key, await storage.get_bytes(avatar.rig_key), "application/json"
            )
            entry["rig_snapshot_key"] = key
        except STORAGE_ERRORS:
            # A missing rig must not block the edit; undo then restores the
            # image and leaves the rig, which is the lesser wrong.
            logger.exception("rig snapshot failed for avatar %s", avatar.id)

    try:
        history = json.loads(avatar.edit_history or "[]")
    except ValueError:
        history = []
    history.append(entry)
    avatar.edit_history = json.dumps(history[-MAX_HISTORY:])


async def undo(db: AsyncSession, avatar: Avatar) -> None:
    """Step back one edit — crop, background, framing, whatever it was
    (409 nothing_to_undo on an empty history). Committed."""
    try:
        history = json.loads(avatar.edit_history or "[]")
    except ValueError:
        history = []
    if not history:
        raise Conflict409("Nothing to undo", code="nothing_to_undo")

    entry = history.pop()
    storage = get_storage()

    avatar.image_key = entry.get("image_key")
    avatar.thumbnail_key = entry.get("thumbnail_key")
    avatar.original_image_key = entry.get("original_image_key")
    avatar.precrop_image_key = entry.get("precrop_image_key")
    if entry.get("framing"):
        avatar.framing = entry["framing"]

    snapshot_key = entry.get("rig_snapshot_key")
    stale: list[str] = []
    if snapshot_key and avatar.rig_key:
        before = restored = None
        try:
            before = json.loads(await storage.get_bytes(avatar.rig_key))
        except STORAGE_ERRORS:
            logger.exception("rig read failed for avatar %s", avatar.id)
        try:
            restored = await storage.get_bytes(snapshot_key)
            await storage.put_bytes(avatar.rig_key, restored, "application/json")
        except STORAGE_ERRORS:
            logger.exception("rig restore failed for avatar %s", avatar.id)
            restored = None
        if restored is not None:
            try:
                after = json.loads(restored)
            except ValueError:
                after = None
            # Undoing a crop puts the whole picture back, the same face
            # elsewhere in it (the mouth kit follows); undoing a background
            # change the same rig (it stays).
            stale = await mouth_kit.follow_rig(avatar, storage, before, after)

    avatar.edit_history = json.dumps(history)
    await rebuild_layers(avatar, storage)
    mark_dirty(avatar)
    await db.commit()
    for key in stale:
        await storage.delete(key)
