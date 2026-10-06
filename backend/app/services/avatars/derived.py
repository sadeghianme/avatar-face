"""Files derived from an avatar's picture: its thumbnail and its layers.

Rebuilt after anything that changes what image_key points at (a crop, the
background toggled, an undo), because files cut from the old pixels would
otherwise be shown over the new ones. Neither is ever fatal: a stale
thumbnail is cosmetic, and without layers the embed renders the single
photo.
"""

from __future__ import annotations

import json
import logging

from app.models import Avatar, AvatarKind
from app.services.jobs import run_cpu

logger = logging.getLogger("liveface.avatars")


async def rebuild_layers(avatar: Avatar, storage) -> None:
    """Re-derive the background/body/head layers from the current image.

    Called after anything that changes what image_key points at — crop,
    background toggle, undo — because layers cut from the old pixels would
    otherwise be composited over the new ones. Likewise never fatal; the
    embed falls back to the single-photo path when has_layers is False.
    """
    from app.services.layers import store_layers

    avatar.has_layers = False
    if avatar.kind != AvatarKind.photo or not avatar.rig_key or not avatar.image_key:
        return
    try:
        rig = json.loads(await storage.get_bytes(avatar.rig_key))
        if rig.get("face_box"):
            avatar.has_layers = await store_layers(
                avatar, storage, await storage.get_bytes(avatar.image_key), rig["face_box"]
            )
    except Exception:
        # Broad on purpose: segmentation, matting and storage, all optional
        # by contract; without layers the embed draws the single photo.
        logger.exception("layer rebuild failed for avatar %s", avatar.id)


async def rebuild_thumbnail(avatar: Avatar, storage) -> None:
    """Regenerate the thumbnail from whatever image_key now points at."""
    from app.services.rig import make_thumbnail, write_thumbnail_key

    if not avatar.image_key:
        return
    try:
        # Decode, resize, encode: the CPU thread's work.
        thumb, thumb_type = await run_cpu(make_thumbnail, await storage.get_bytes(avatar.image_key))
    except Exception:
        # Broad on purpose: decoding and resizing any picture. A stale
        # thumbnail is a cosmetic problem. Failing the request is not: it
        # would leave someone unable to restore their original photo
        # because the preview of it could not be regenerated.
        logger.exception("thumbnail rebuild failed for avatar %s", avatar.id)
        return
    key = write_thumbnail_key(avatar.org_id, avatar.id, thumb_type)
    await storage.put_bytes(key, thumb, thumb_type)
    avatar.thumbnail_key = key
