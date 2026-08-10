from __future__ import annotations

import logging
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, BackgroundTasks
from sqlalchemy import select

from pydantic import BaseModel, Field

from app.api.deps import DB, OrgMember
from app.core.config import get_settings
from app.core.errors import Conflict409, NotFound404, Validation422
from app.models import Avatar, AvatarKind, AvatarStatus
from app.schemas.avatar import (
    AvatarCreate,
    AvatarCreated,
    AvatarDetail,
    AvatarFromUrl,
    AvatarOut,
    AvatarUpdate,
    RigAdjust,
    RigFit,
    RigFitResult,
)
from app.services.rig import process_avatar
from app.services.rig_fit import RegionMarks, apply_anchors, current_anchors
from app.services.segment import SegmentationUnavailable, remove_background
from app.services.storage import get_storage

logger = logging.getLogger("liveface.avatars")
router = APIRouter(prefix="/orgs/{org_id}/avatars", tags=["avatars"])

GLB_CONTENT_TYPE = "model/gltf-binary"
MAX_MODEL_BYTES = 30 * 1024 * 1024


async def _get_avatar(db: DB, org_id: str, avatar_id: str) -> Avatar:
    avatar = (
        await db.execute(
            select(Avatar).where(Avatar.id == avatar_id, Avatar.org_id == org_id)
        )
    ).scalar_one_or_none()
    if avatar is None:
        raise NotFound404("Avatar not found", code="avatar_not_found")
    return avatar


@router.post("", response_model=AvatarCreated, status_code=201)
async def create_avatar(body: AvatarCreate, ctx: OrgMember, db: DB) -> AvatarCreated:
    settings = get_settings()
    is_model = body.content_type == GLB_CONTENT_TYPE
    if not is_model and body.content_type not in settings.allowed_image_types:
        raise Validation422(
            f"content_type must be one of {settings.allowed_image_types} or {GLB_CONTENT_TYPE}",
            code="unsupported_image_type",
        )
    avatar = Avatar(
        org_id=ctx.org.id,
        created_by_id=ctx.membership.user_id,
        name=body.name,
        kind=AvatarKind.model3d if is_model else AvatarKind.photo,
        content_type=body.content_type,
    )
    db.add(avatar)
    await db.flush()
    ext = "glb" if is_model else body.content_type.split("/")[-1].replace("jpeg", "jpg")
    avatar.image_key = f"orgs/{ctx.org.id}/avatars/{avatar.id}/source.{ext}"
    await db.commit()
    upload_url = await get_storage().presign_put(avatar.image_key, body.content_type)
    return AvatarCreated(avatar=AvatarOut.model_validate(avatar), upload_url=upload_url)


@router.post("/from-url", response_model=AvatarOut, status_code=201)
async def create_from_url(
    body: AvatarFromUrl, ctx: OrgMember, db: DB, background: BackgroundTasks
) -> Avatar:
    """Import a GLB avatar by URL (e.g. https://models.readyplayer.me/<id>.glb)."""
    allowed_hosts = {h.lower() for h in get_settings().model_url_hosts}
    parts = urlsplit(body.url)
    if parts.scheme != "https" or (parts.hostname or "").lower() not in allowed_hosts:
        raise Validation422(
            f"URL host must be one of {sorted(allowed_hosts)} (configurable via MODEL_URL_HOSTS)",
            code="model_host_not_allowed",
        )
    try:
        async with httpx.AsyncClient(timeout=60.0, follow_redirects=False) as client:
            response = await client.get(body.url)
            response.raise_for_status()
            data = response.content
    except httpx.HTTPError as exc:
        raise Validation422(f"Could not download model: {exc}", code="model_download_failed")
    if len(data) > MAX_MODEL_BYTES:
        raise Validation422("Model exceeds 30MB", code="model_too_large")

    name = body.name or (parts.path.rsplit("/", 1)[-1].removesuffix(".glb") or "3D avatar")[:64]
    avatar = Avatar(
        org_id=ctx.org.id,
        created_by_id=ctx.membership.user_id,
        name=name,
        kind=AvatarKind.model3d,
        content_type=GLB_CONTENT_TYPE,
    )
    db.add(avatar)
    await db.flush()
    avatar.image_key = f"orgs/{ctx.org.id}/avatars/{avatar.id}/source.glb"
    await get_storage().put_bytes(avatar.image_key, data, GLB_CONTENT_TYPE)
    await db.commit()
    background.add_task(process_avatar, avatar.id)
    return avatar


@router.get("", response_model=list[AvatarOut])
async def list_avatars(ctx: OrgMember, db: DB) -> list[Avatar]:
    return list(
        (
            await db.execute(
                select(Avatar)
                .where(Avatar.org_id == ctx.org.id)
                .order_by(Avatar.created_at.desc())
            )
        )
        .scalars()
        .all()
    )


@router.post("/{avatar_id}/uploaded", response_model=AvatarOut)
async def confirm_uploaded(
    avatar_id: str, ctx: OrgMember, db: DB, background: BackgroundTasks
) -> Avatar:
    avatar = await _get_avatar(db, ctx.org.id, avatar_id)
    if avatar.status not in (AvatarStatus.pending, AvatarStatus.failed):
        raise Conflict409("Avatar already processed", code="already_processed")
    if not avatar.image_key or not await get_storage().exists(avatar.image_key):
        raise Validation422("Image has not been uploaded yet", code="image_missing")
    background.add_task(process_avatar, avatar.id)
    return avatar


@router.post("/{avatar_id}/retry", response_model=AvatarOut)
async def retry_rig(
    avatar_id: str, ctx: OrgMember, db: DB, background: BackgroundTasks
) -> Avatar:
    """Re-enqueue the rig job (used by the stall-detection UI)."""
    avatar = await _get_avatar(db, ctx.org.id, avatar_id)
    if avatar.status == AvatarStatus.ready:
        raise Conflict409("Avatar is already ready", code="already_processed")
    if not avatar.image_key or not await get_storage().exists(avatar.image_key):
        raise Validation422("Image has not been uploaded yet", code="image_missing")
    avatar.status = AvatarStatus.pending
    avatar.error = None
    await db.commit()
    background.add_task(process_avatar, avatar.id)
    return avatar


@router.post("/{avatar_id}/generate-3d", response_model=AvatarOut, status_code=201)
async def generate_3d(
    avatar_id: str, ctx: OrgMember, db: DB, background: BackgroundTasks
) -> Avatar:
    """Build a talking 3D face GLB from a photo avatar (in-house, free):
    MediaPipe 3D landmarks + photo texture + procedural viseme/blink morphs.
    Creates a NEW avatar of kind=model3d."""
    from app.services.glb_builder import build_face_glb

    source = await _get_avatar(db, ctx.org.id, avatar_id)
    if source.kind != AvatarKind.photo:
        raise Validation422("Source avatar must be a photo", code="not_a_photo")
    if source.status != AvatarStatus.ready or not source.image_key:
        raise Conflict409("Source avatar is not ready", code="not_ready")

    image_bytes = await get_storage().get_bytes(source.image_key)
    try:
        glb = build_face_glb(image_bytes)
    except Exception as exc:
        raise Validation422(f"3D generation failed: {exc}", code="generation_failed")

    avatar = Avatar(
        org_id=ctx.org.id,
        created_by_id=ctx.membership.user_id,
        name=f"{source.name} 3D",
        kind=AvatarKind.model3d,
        content_type=GLB_CONTENT_TYPE,
    )
    db.add(avatar)
    await db.flush()
    avatar.image_key = f"orgs/{ctx.org.id}/avatars/{avatar.id}/source.glb"
    await get_storage().put_bytes(avatar.image_key, glb, GLB_CONTENT_TYPE)
    await db.commit()
    background.add_task(process_avatar, avatar.id)
    return avatar


@router.post("/{avatar_id}/rig-adjust", response_model=AvatarOut)
async def rig_adjust(avatar_id: str, body: RigAdjust, ctx: OrgMember, db: DB) -> Avatar:
    """Manual fit correction (the auto-detected landmarks can miss on
    stylized/rotated faces): translate+scale the mouth cluster and translate
    each eye cluster, then persist the rewritten rig JSON."""
    import json as _json

    avatar = await _get_avatar(db, ctx.org.id, avatar_id)
    if avatar.kind != AvatarKind.photo or avatar.status != AvatarStatus.ready or not avatar.rig_key:
        raise Conflict409("Avatar rig is not adjustable", code="not_adjustable")

    storage = get_storage()
    rig = _json.loads(await storage.get_bytes(avatar.rig_key))
    points = rig["points"]

    # Mouth: scale about its centroid, then translate.
    mouth_indices = set(rig.get("mouth_indices", []))
    if mouth_indices:
        mcx = sum(points[i][0] for i in mouth_indices) / len(mouth_indices)
        mcy = sum(points[i][1] for i in mouth_indices) / len(mouth_indices)
        for i in mouth_indices:
            points[i][0] = mcx + (points[i][0] - mcx) * body.mouth_scale + body.mouth_dx
            points[i][1] = mcy + (points[i][1] - mcy) * body.mouth_scale + body.mouth_dy

    # Eyes: translate lids + iris clusters together.
    left_eye = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160,
                161, 246, 468, 469, 470, 471, 472]
    right_eye = [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386,
                 387, 388, 466, 473, 474, 475, 476, 477]
    for cluster, dx, dy in (
        (left_eye, body.left_eye_dx, body.left_eye_dy),
        (right_eye, body.right_eye_dx, body.right_eye_dy),
    ):
        if dx or dy:
            for i in cluster:
                points[i][0] += dx
                points[i][1] += dy

    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    rig["face_box"] = [min(xs), min(ys), max(xs), max(ys)]
    await storage.put_bytes(avatar.rig_key, _json.dumps(rig).encode(), "application/json")
    return avatar


class BackgroundRequest(BaseModel):
    """True removes the background, false restores the original photo."""

    remove: bool = True


@router.patch("/{avatar_id}", response_model=AvatarOut)
async def update_avatar(
    avatar_id: str, body: AvatarUpdate, ctx: OrgMember, db: DB
) -> Avatar:
    """Change owner-editable settings.

    Framing lives here rather than on the embed snippet so that switching it
    reaches sites that already have the snippet pasted in — they re-read the
    avatar on every page load, so the change lands without anyone editing HTML.
    """
    avatar = await _get_avatar(db, ctx.org.id, avatar_id)
    if body.name is not None:
        avatar.name = body.name
    if body.framing is not None:
        avatar.framing = body.framing
    await db.commit()
    return avatar


@router.post("/{avatar_id}/background", response_model=AvatarOut)
async def set_background(
    avatar_id: str, body: BackgroundRequest, ctx: OrgMember, db: DB
) -> Avatar:
    """Cut the subject out of the photo, or put the original back.

    The rig is untouched on purpose. Removing a background does not move a
    single landmark — the face is in exactly the same place — so re-detecting
    would only risk a worse fit than the one already there, possibly one the
    user corrected by hand.
    """
    avatar = await _get_avatar(db, ctx.org.id, avatar_id)
    if avatar.kind != AvatarKind.photo or not avatar.image_key:
        raise Conflict409("Only photo avatars have a background", code="not_a_photo")

    storage = get_storage()

    if not body.remove:
        if not avatar.original_image_key:
            return avatar  # already the original; nothing to undo
        avatar.image_key = avatar.original_image_key
        avatar.original_image_key = None
        await _rebuild_thumbnail(avatar, storage)
        await db.commit()
        return avatar

    if avatar.original_image_key:
        return avatar  # already cut out

    try:
        cut_out = remove_background(await storage.get_bytes(avatar.image_key))
    except SegmentationUnavailable as exc:
        raise Conflict409(
            "Background removal is not configured on this server",
            code="segmentation_unavailable",
        ) from exc

    key = f"orgs/{avatar.org_id}/avatars/{avatar.id}/source-nobg.png"
    await storage.put_bytes(key, cut_out, "image/png")
    # The original is kept, not overwritten, so this is reversible.
    avatar.original_image_key = avatar.image_key
    avatar.image_key = key
    # The thumbnail is derived from the photo, so it has to follow it — and as
    # a JPEG it could not hold the transparency anyway, which is why the
    # dashboard grid kept showing the background after a successful removal.
    await _rebuild_thumbnail(avatar, storage)
    await db.commit()
    return avatar


async def _rebuild_thumbnail(avatar: Avatar, storage) -> None:
    """Regenerate the thumbnail from whatever image_key now points at."""
    from app.services.rig import make_thumbnail, write_thumbnail_key

    if not avatar.image_key:
        return
    try:
        thumb, thumb_type = make_thumbnail(await storage.get_bytes(avatar.image_key))
    except Exception:
        # A stale thumbnail is a cosmetic problem. Failing the request is not:
        # it would leave someone unable to restore their original photo
        # because the preview of it could not be regenerated.
        logger.exception("thumbnail rebuild failed for avatar %s", avatar.id)
        return
    key = write_thumbnail_key(avatar.org_id, avatar.id, thumb_type)
    await storage.put_bytes(key, thumb, thumb_type)
    avatar.thumbnail_key = key


class CropRequest(BaseModel):
    """A rectangle in fractions of the current image, or a reset."""

    x: float = Field(default=0.0, ge=0.0, le=1.0)
    y: float = Field(default=0.0, ge=0.0, le=1.0)
    width: float = Field(default=1.0, gt=0.0, le=1.0)
    height: float = Field(default=1.0, gt=0.0, le=1.0)
    reset: bool = False


# Below this the rig has too little face left to be worth keeping.
MIN_CROP_FRACTION = 0.15


@router.post("/{avatar_id}/crop", response_model=AvatarOut)
async def crop_avatar(
    avatar_id: str, body: CropRequest, ctx: OrgMember, db: DB
) -> Avatar:
    """Crop the photo, and move the rig with it.

    The rig is in image pixels, so cropping the image without translating the
    landmarks would leave every point offset by the crop origin — the mesh
    would sit beside the face instead of on it. Translating is exact and,
    unlike re-detecting, keeps any correction the user made by hand.
    """
    import json as _json

    avatar = await _get_avatar(db, ctx.org.id, avatar_id)
    if avatar.kind != AvatarKind.photo or not avatar.image_key:
        raise Conflict409("Only photo avatars can be cropped", code="not_a_photo")

    storage = get_storage()

    if body.reset:
        if not avatar.precrop_image_key:
            return avatar  # never cropped; nothing to undo
        avatar.image_key = avatar.precrop_image_key
        avatar.precrop_image_key = None
        await _rebuild_thumbnail(avatar, storage)
        await _rebuild_rig(avatar, storage)
        await db.commit()
        return avatar

    if body.x + body.width > 1.0 or body.y + body.height > 1.0:
        raise Validation422("Crop rectangle falls outside the image", code="crop_out_of_bounds")
    if body.width < MIN_CROP_FRACTION or body.height < MIN_CROP_FRACTION:
        raise Validation422(
            f"Crop must keep at least {int(MIN_CROP_FRACTION * 100)}% of each side",
            code="crop_too_small",
        )

    import io

    from PIL import Image

    source = Image.open(io.BytesIO(await storage.get_bytes(avatar.image_key)))
    # Preserve alpha: cropping a cut-out must not paste the background back.
    has_alpha = source.mode in ("RGBA", "LA") or "transparency" in source.info
    source = source.convert("RGBA" if has_alpha else "RGB")
    width, height = source.size

    left = int(round(body.x * width))
    top = int(round(body.y * height))
    right = int(round((body.x + body.width) * width))
    bottom = int(round((body.y + body.height) * height))
    cropped = source.crop((left, top, right, bottom))

    buffer = io.BytesIO()
    cropped.save(buffer, format="PNG", optimize=True)

    key = f"orgs/{avatar.org_id}/avatars/{avatar.id}/source-crop.png"
    await storage.put_bytes(key, buffer.getvalue(), "image/png")
    # Only the first crop records the pre-crop image, so cropping twice still
    # resets all the way back rather than to the previous crop.
    if not avatar.precrop_image_key:
        avatar.precrop_image_key = avatar.image_key
    avatar.image_key = key

    await _translate_rig(avatar, storage, left, top, cropped.size, _json)
    await _rebuild_thumbnail(avatar, storage)
    await db.commit()
    return avatar


async def _translate_rig(avatar: Avatar, storage, left: int, top: int, size, _json) -> None:
    """Shift every landmark by the crop origin and restate the image size."""
    if not avatar.rig_key:
        return
    rig = _json.loads(await storage.get_bytes(avatar.rig_key))
    rig["image_size"] = [size[0], size[1]]
    rig["points"] = [[p[0] - left, p[1] - top] for p in rig.get("points", [])]
    box = rig.get("face_box")
    if box and len(box) == 4:
        rig["face_box"] = [box[0] - left, box[1] - top, box[2] - left, box[3] - top]
    await storage.put_bytes(avatar.rig_key, _json.dumps(rig).encode(), "application/json")


async def _rebuild_rig(avatar: Avatar, storage) -> None:
    """Re-detect after a reset, since the old rig is in cropped coordinates."""
    from app.services.rig import build_rig, landmarks_from_image

    if not avatar.rig_key or not avatar.image_key:
        return
    import json as _json

    try:
        points, blendshapes, size = landmarks_from_image(await storage.get_bytes(avatar.image_key))
        rig = build_rig(points, size, blendshapes)
    except Exception:
        logger.exception("rig rebuild failed after crop reset for avatar %s", avatar.id)
        return
    await storage.put_bytes(avatar.rig_key, _json.dumps(rig).encode(), "application/json")


@router.get("/{avatar_id}/rig-anchors")
async def rig_anchors(avatar_id: str, ctx: OrgMember, db: DB) -> dict:
    """Where the detector currently believes each region's edges are.

    The fit UI opens with its handles already on these, so the user corrects a
    detection instead of marking a face from scratch — on a photo where the
    detection is good, that means dragging nothing.
    """
    import json as _json

    avatar = await _get_avatar(db, ctx.org.id, avatar_id)
    if not avatar.rig_key:
        raise Conflict409("Avatar has no rig", code="not_adjustable")
    rig = _json.loads(await get_storage().get_bytes(avatar.rig_key))
    return {"anchors": current_anchors(rig), "image_size": rig["image_size"]}


@router.post("/{avatar_id}/rig-fit", response_model=RigFitResult)
async def rig_fit(avatar_id: str, body: RigFit, ctx: OrgMember, db: DB) -> RigFitResult:
    """Rewrite the rig from hand-placed anchors.

    With `persist` false this computes the corrected rig and returns it
    without writing, so the client can render and speak with the exact object
    that a subsequent save would store — the preview cannot disagree with the
    result, because it IS the result.
    """
    import json as _json

    avatar = await _get_avatar(db, ctx.org.id, avatar_id)
    if avatar.kind != AvatarKind.photo or avatar.status != AvatarStatus.ready or not avatar.rig_key:
        raise Conflict409("Avatar rig is not adjustable", code="not_adjustable")

    storage = get_storage()
    rig = _json.loads(await storage.get_bytes(avatar.rig_key))

    def marks(value) -> RegionMarks | None:
        if value is None:
            return None
        return RegionMarks(
            left=(value.left.x, value.left.y),
            right=(value.right.x, value.right.y),
            top=(value.top.x, value.top.y),
            bottom=(value.bottom.x, value.bottom.y),
            center=(value.center.x, value.center.y) if value.center else None,
        )

    adjusted = apply_anchors(
        rig,
        head=marks(body.head),
        left_eye=marks(body.left_eye),
        right_eye=marks(body.right_eye),
        mouth=marks(body.mouth),
    )

    if body.persist:
        await storage.put_bytes(
            avatar.rig_key, _json.dumps(adjusted).encode(), "application/json"
        )
    return RigFitResult(rig=adjusted, persisted=body.persist)


@router.post("/{avatar_id}/rig-reset", response_model=AvatarOut)
async def rig_reset(
    avatar_id: str, ctx: OrgMember, db: DB, background: BackgroundTasks
) -> Avatar:
    """Throw away hand-placed anchors and re-detect from the original photo.

    Saving a correction overwrites the rig, so without this a bad marking is
    unrecoverable. The source image is still stored, so re-running the normal
    pipeline reproduces the original detection exactly.
    """
    avatar = await _get_avatar(db, ctx.org.id, avatar_id)
    if avatar.kind != AvatarKind.photo or not avatar.image_key:
        raise Conflict409("Avatar cannot be re-detected", code="not_adjustable")
    avatar.status = AvatarStatus.processing
    await db.commit()
    background.add_task(process_avatar, avatar.id)
    return avatar


@router.get("/{avatar_id}", response_model=AvatarDetail)
async def get_avatar_detail(avatar_id: str, ctx: OrgMember, db: DB) -> AvatarDetail:
    avatar = await _get_avatar(db, ctx.org.id, avatar_id)
    storage = get_storage()
    detail = AvatarDetail.model_validate(avatar)
    if avatar.image_key and await storage.exists(avatar.image_key):
        detail.image_url = await storage.presign_get(avatar.image_key)
        if avatar.kind == AvatarKind.model3d:
            detail.model_url = detail.image_url
    if avatar.rig_key:
        detail.rig_url = await storage.presign_get(avatar.rig_key)
    if avatar.thumbnail_key:
        detail.thumbnail_url = await storage.presign_get(avatar.thumbnail_key)
    return detail


@router.delete("/{avatar_id}", status_code=204)
async def delete_avatar(avatar_id: str, ctx: OrgMember, db: DB):
    avatar = await _get_avatar(db, ctx.org.id, avatar_id)
    storage = get_storage()
    for key in (avatar.image_key, avatar.rig_key, avatar.thumbnail_key):
        if key:
            await storage.delete(key)
    await db.delete(avatar)
    await db.commit()
