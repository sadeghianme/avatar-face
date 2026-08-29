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
from app.core.errors import Conflict409, NotFound404
from app.models import Avatar, AvatarKind, AvatarStatus
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
    from sqlalchemy import select

    avatar = (
        await db.execute(
            select(Avatar).where(Avatar.id == avatar_id, Avatar.org_id == ctx.org.id)
        )
    ).scalar_one_or_none()
    if avatar is None:
        raise NotFound404("Avatar not found", code="avatar_not_found")
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

    Mirrors rig._mediapipe_landmarks rather than modifying it: changing the
    stable function's return shape for a lab would be exactly the coupling
    this file exists to avoid.
    """
    import io

    import numpy as np
    from PIL import Image

    from app.core.config import get_settings

    model_path = get_settings().rig_model_path
    if not model_path:
        raise RuntimeError("no landmarker model configured")

    import mediapipe as mp
    from mediapipe.tasks import python as mp_python
    from mediapipe.tasks.python import vision

    image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    options = vision.FaceLandmarkerOptions(
        base_options=mp_python.BaseOptions(model_asset_path=model_path),
        num_faces=1,
    )
    with vision.FaceLandmarker.create_from_options(options) as landmarker:
        result = landmarker.detect(
            mp.Image(image_format=mp.ImageFormat.SRGB, data=np.asarray(image))
        )
    if not result.face_landmarks:
        raise RuntimeError("no face detected")
    width = image.size[0]
    return [round(lm.z * width, 3) for lm in result.face_landmarks[0]]
