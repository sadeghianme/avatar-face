"""The avatar's AI kits following its face: the mouth kit
(services.mouth_kit) and the expression pictures (services.expression_kit),
both moved onto the points as they are now after an edit, with no AI call.
One call per edit for both, so an edit that moves the face cannot leave one
of them on the old points."""

from __future__ import annotations

from app.db import get_session_factory
from app.models import Avatar
from app.services import expression_kit, mouth_kit
from app.services.edit_locks import avatar_edits
from app.services.mouth_kit.storing import load_avatar
from app.services.publishing import mark_dirty
from app.services.storage import Storage, get_storage


async def follow_points(avatar: Avatar, storage: Storage, points, image_size=None) -> list[str]:
    """Both kits onto `points` (mouth_kit.follow_points, expression_kit
    .follow_points). Returns the keys replaced, to delete after the commit."""
    stale = await mouth_kit.follow_points(avatar, storage, points, image_size)
    return stale + await expression_kit.follow_points(avatar, storage, points, image_size)


async def follow_rig(
    avatar: Avatar, storage: Storage, before: dict | None, after: dict | None
) -> list[str]:
    """Both kits after an edit put another rig in place (undo)."""
    stale = await mouth_kit.follow_rig(avatar, storage, before, after)
    return stale + await expression_kit.follow_rig(avatar, storage, before, after)


async def follow_redetection(org_id: str, avatar_id: str, points) -> None:
    """follow_points for a job that rebuilt a rig of the same picture
    without the avatar's edit lock (mouth_kit.follow_redetection, for both
    kits): under the lock, on the row as it is now, committed on its own."""
    storage = get_storage()
    stale: list[str] = []
    async with avatar_edits.hold(avatar_id), get_session_factory()() as db:
        avatar = await load_avatar(db, org_id, avatar_id)
        if avatar is None:
            return
        stale = await follow_points(avatar, storage, points)
        if avatar.published_config:
            mark_dirty(avatar)
        await db.commit()
    for key in stale:
        await storage.delete(key)
