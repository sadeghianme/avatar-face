"""Lab-only endpoints for the Photoface HD experiment.

SEPARATION CONTRACT, matching embed/src/lab/: this router exists so the lab
can be evaluated without touching anything stable. It writes nothing — no
storage objects, no rows, no mutation of the avatar. Deleting this file and
its registration line removes the experiment completely.

The one endpoint serves per-landmark depth. The stable pipeline runs
MediaPipe and keeps only x,y (build_rig drops z, correctly — the 2D engine
has no use for it). The lab's whole hypothesis is that the discarded z is
worth rendering, so it re-runs the landmarker on demand and returns z alone.
Recomputed per request rather than cached to disk: ~100ms of CPU against
zero persistent state, and a lab that leaves no residue is one that can be
judged and deleted freely.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter

from app.api.deps import DB, OrgMember
from app.core.errors import Conflict409
from app.models import AvatarKind, AvatarStatus
from app.services.avatars import repo as avatars
from app.services.storage import get_storage

logger = logging.getLogger("liveface.lab")
router = APIRouter(prefix="/orgs/{org_id}/lab", tags=["lab"])


@router.get("/avatars/{avatar_id}/depth")
async def landmark_depth(avatar_id: str, ctx: OrgMember, db: DB) -> dict:
    """478 per-landmark z values for the avatar's current photo.

    MediaPipe's convention: negative toward the camera, scaled like x.
    `detected: false` with an empty list is an answer, not an error — the
    lab falls back to its dome, exactly as it does for avatars whose photo
    the landmarker cannot read.
    """
    avatar = await avatars.require_in_org(db, ctx.org.id, avatar_id)
    if avatar.kind != AvatarKind.photo or avatar.status != AvatarStatus.ready or not avatar.image_key:
        raise Conflict409("Only ready photo avatars have depth", code="not_a_photo")

    image_bytes = await get_storage().get_bytes(avatar.image_key)
    try:
        z_values = _landmark_z(image_bytes)
    except Exception:
        logger.info("lab depth: landmarker found nothing for avatar %s", avatar_id)
        z_values = None
    return {"detected": z_values is not None, "z": z_values or []}


def _landmark_z(image_bytes: bytes) -> list[float]:
    """The z column the stable pipeline discards.

    Read from the shared landmarker (services.landmarks) rather than a
    second one: the stable function's return shape stays untouched, and the
    lab does not pay a model load per request.
    """
    import io

    from PIL import Image

    from app.services.landmarks import detect

    found = detect(Image.open(io.BytesIO(image_bytes)))
    if found is None:
        raise RuntimeError("no face detected")
    return [round(float(z), 3) for z in found.z]
