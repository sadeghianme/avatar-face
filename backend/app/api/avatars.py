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
from uuid import uuid4

from app.services.imagegen import STYLES as GEN_STYLES
from app.services.rig import process_avatar
from app.services.usage import check_image_limit, record_generated_avatar, record_generation
from app.services.rig_fit import PupilMarks, RegionMarks, apply_anchors, current_anchors
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
        await _snapshot(avatar, storage, "restore background")
        avatar.image_key = avatar.original_image_key
        avatar.original_image_key = None
        await _rebuild_thumbnail(avatar, storage)
        await _rebuild_layers(avatar, storage)
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

    await _snapshot(avatar, storage, "remove background")
    key = f"orgs/{avatar.org_id}/avatars/{avatar.id}/source-nobg.png"
    await storage.put_bytes(key, cut_out, "image/png")
    # The original is kept, not overwritten, so this is reversible.
    avatar.original_image_key = avatar.image_key
    avatar.image_key = key
    # The thumbnail is derived from the photo, so it has to follow it — and as
    # a JPEG it could not hold the transparency anyway, which is why the
    # dashboard grid kept showing the background after a successful removal.
    await _rebuild_thumbnail(avatar, storage)
    await _rebuild_layers(avatar, storage)
    await db.commit()
    return avatar


async def _rebuild_layers(avatar: Avatar, storage) -> None:
    """Re-derive the background/body/head layers from the current image.

    Called after anything that changes what image_key points at — crop,
    background toggle, undo — because layers cut from the old pixels would
    otherwise be composited over the new ones. Likewise never fatal; the
    embed falls back to the single-photo path when has_layers is False.
    """
    import json as _json

    from app.services.layers import store_layers

    avatar.has_layers = False
    if avatar.kind != AvatarKind.photo or not avatar.rig_key or not avatar.image_key:
        return
    try:
        rig = _json.loads(await storage.get_bytes(avatar.rig_key))
        if rig.get("face_box"):
            avatar.has_layers = await store_layers(
                avatar, storage, await storage.get_bytes(avatar.image_key), rig["face_box"]
            )
    except Exception:
        logger.exception("layer rebuild failed for avatar %s", avatar.id)


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

MAX_HISTORY = 12


async def _snapshot(avatar: Avatar, storage, label: str) -> None:
    """Record the current state so the change about to happen can be undone."""
    import json as _json
    import uuid as _uuid

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
        key = f"orgs/{avatar.org_id}/avatars/{avatar.id}/history/{_uuid.uuid4().hex}.json"
        try:
            await storage.put_bytes(
                key, await storage.get_bytes(avatar.rig_key), "application/json"
            )
            entry["rig_snapshot_key"] = key
        except Exception:
            # A missing rig must not block the edit; undo then restores the
            # image and leaves the rig, which is the lesser wrong.
            logger.exception("rig snapshot failed for avatar %s", avatar.id)

    try:
        history = _json.loads(avatar.edit_history or "[]")
    except ValueError:
        history = []
    history.append(entry)
    avatar.edit_history = _json.dumps(history[-MAX_HISTORY:])


@router.post("/{avatar_id}/undo", response_model=AvatarOut)
async def undo_edit(avatar_id: str, ctx: OrgMember, db: DB) -> Avatar:
    """Step back one edit — crop, background, framing, whatever it was."""
    import json as _json

    avatar = await _get_avatar(db, ctx.org.id, avatar_id)
    try:
        history = _json.loads(avatar.edit_history or "[]")
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

    snapshot = entry.get("rig_snapshot_key")
    if snapshot and avatar.rig_key:
        try:
            await storage.put_bytes(
                avatar.rig_key, await storage.get_bytes(snapshot), "application/json"
            )
        except Exception:
            logger.exception("rig restore failed for avatar %s", avatar.id)

    avatar.edit_history = _json.dumps(history)
    await _rebuild_layers(avatar, storage)
    await db.commit()
    return avatar


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
        await _snapshot(avatar, storage, "crop reset")
        avatar.image_key = avatar.precrop_image_key
        avatar.precrop_image_key = None
        await _rebuild_thumbnail(avatar, storage)
        await _rebuild_rig(avatar, storage)
        await _rebuild_layers(avatar, storage)
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

    await _snapshot(avatar, storage, "crop")
    key = f"orgs/{avatar.org_id}/avatars/{avatar.id}/source-crop.png"
    await storage.put_bytes(key, buffer.getvalue(), "image/png")
    # Only the first crop records the pre-crop image, so cropping twice still
    # resets all the way back rather than to the previous crop.
    if not avatar.precrop_image_key:
        avatar.precrop_image_key = avatar.image_key
    avatar.image_key = key

    await _translate_rig(avatar, storage, left, top, cropped.size, _json)
    await _rebuild_thumbnail(avatar, storage)
    await _rebuild_layers(avatar, storage)
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
    # Saved hand-placed marks live in image pixels too; without this a crop
    # would reopen the marking panel with every handle off by the crop origin.
    for region in (rig.get("user_anchors") or {}).values():
        for pt in region.values():
            if isinstance(pt, dict) and "x" in pt:
                pt["x"] -= left
                pt["y"] -= top
    await storage.put_bytes(avatar.rig_key, _json.dumps(rig).encode(), "application/json")


async def _rebuild_rig(avatar: Avatar, storage) -> None:
    """Re-detect after a reset, since the old rig is in cropped coordinates."""
    from app.services.rig import build_rig, landmarks_from_image

    if not avatar.rig_key or not avatar.image_key:
        return
    import json as _json

    try:
        points, blendshapes, size, _ = landmarks_from_image(await storage.get_bytes(avatar.image_key))
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

    def pupil(value) -> PupilMarks | None:
        if value is None:
            return None
        return PupilMarks(
            center=(value.center.x, value.center.y), rim=(value.rim.x, value.rim.y)
        )

    adjusted = apply_anchors(
        rig,
        head=marks(body.head),
        left_eye=marks(body.left_eye),
        right_eye=marks(body.right_eye),
        mouth=marks(body.mouth),
        left_pupil=pupil(body.left_pupil),
        right_pupil=pupil(body.right_pupil),
    )
    # The marks as placed, kept verbatim so reopening the panel shows the
    # user's own handles. The warped mesh's extremes are NOT that: regions
    # interact through the falloff (a mouth fix drags the chin, moving where
    # "head bottom" would be re-derived), so deriving loses the marking.
    adjusted["user_anchors"] = {
        **(rig.get("user_anchors") or {}),
        **{
            region: getattr(body, region).model_dump()
            for region in ("head", "left_eye", "right_eye", "mouth", "left_pupil", "right_pupil")
            if getattr(body, region) is not None
        },
    }

    if body.persist:
        await storage.put_bytes(
            avatar.rig_key, _json.dumps(adjusted).encode(), "application/json"
        )
    return RigFitResult(rig=adjusted, persisted=body.persist)


@router.post("/{avatar_id}/viseme-frames", response_model=AvatarOut)
async def build_viseme_frames(avatar_id: str, ctx: OrgMember, db: DB) -> Avatar:
    """Generate photographic mouth keyframes for this avatar.

    Opt-in and explicitly requested: it spends image-generation quota (one
    call per key shape) and takes about a minute, so it is never a side
    effect of uploading. Synchronous on purpose — the user pressed a button
    that costs money and should see the result, not a background job whose
    outcome they have to go looking for.
    """
    import json as _json

    from app.services.visemeframes import (
        KEY_VISEMES,
        VisemeFramesUnavailable,
        build_all,
        manifest_key,
    )

    avatar = await _get_avatar(db, ctx.org.id, avatar_id)
    if avatar.kind != AvatarKind.photo or not avatar.rig_key or not avatar.image_key:
        raise Conflict409("Only ready photo avatars can have mouth frames", code="not_a_photo")

    storage = get_storage()
    # Turning the feature back on after switching it off must not re-buy what
    # is already stored.
    existing = manifest_key(avatar.org_id, avatar.id)
    if await storage.exists(existing):
        avatar.viseme_frames = len(
            _json.loads(await storage.get_bytes(existing)).get("frames", [])
        )
        if avatar.viseme_frames:
            await db.commit()
            return avatar

    await check_image_limit(db, ctx.org.id, len(KEY_VISEMES))
    rig = _json.loads(await storage.get_bytes(avatar.rig_key))
    try:
        built = await build_all(
            avatar, storage, await storage.get_bytes(avatar.image_key), rig
        )
    except VisemeFramesUnavailable as exc:
        raise Conflict409(
            "No image provider is configured on this server",
            code="imagegen_unavailable",
        ) from exc

    # Metered per frame that was actually generated, not per frame kept: a
    # frame the provider produced and we then rejected still cost money.
    for _ in range(len(KEY_VISEMES)):
        await record_generation(db, ctx.org.id, "gemini")

    if not built:
        raise Conflict409(
            "No usable mouth frames came back. Try again, or use a photo where "
            "the face is larger and facing the camera.",
            code="no_usable_frames",
        )

    avatar.viseme_frames = built
    await db.commit()
    return avatar


@router.delete("/{avatar_id}/viseme-frames", response_model=AvatarOut)
async def clear_viseme_frames(avatar_id: str, ctx: OrgMember, db: DB) -> Avatar:
    """Go back to the geometric mouth.

    The stored frames are left in place: they are already paid for, and
    turning the feature back on should not spend the quota again.
    """
    avatar = await _get_avatar(db, ctx.org.id, avatar_id)
    avatar.viseme_frames = 0
    await db.commit()
    return avatar


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
    from app.api.embed import _layer_urls, _viseme_frames

    detail.layer_urls = await _layer_urls(avatar, storage)
    detail.viseme_frame_set = await _viseme_frames(avatar, storage)
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


class GenerateRequest(BaseModel):
    """Generate candidate avatar images.

    `source_avatar_id` starts from an existing avatar's photo (image-to-image);
    omitting it generates from scratch.
    """

    style: str = Field(default="photoreal")
    source_avatar_id: str | None = None
    count: int = Field(default=2, ge=1, le=4)
    note: str = Field(default="", max_length=300)


# Each attempt costs money and ~10s, so the ceiling is low. Two accepted
# candidates out of four tries is a normal outcome; zero means the source or
# the style is fighting the rig requirements, and more tries will not fix it.
MAX_GENERATION_ATTEMPTS = 6


@router.post("/generate")
async def generate_candidates(
    body: GenerateRequest, ctx: OrgMember, db: DB
) -> dict:
    """Generate images and keep only the ones the rig can actually use.

    A picture that looks right is not the same as one that works: rig.py falls
    back to a synthetic mesh when no face is found, so an unusable image would
    otherwise sail through and become a "ready" avatar whose mouth moves in
    the wrong place. Every candidate is put through detection here, and the
    rejected ones are reported rather than hidden — "the head is turned away"
    tells the user what to change; a silent retry does not.
    """
    from app.services.imagegen import ImageGenUnavailable, generate
    from app.services.riggable import check_image

    if body.style not in GEN_STYLES:
        raise Validation422(f"style must be one of {sorted(GEN_STYLES)}", code="unknown_style")

    storage = get_storage()
    source: bytes | None = None
    if body.source_avatar_id:
        origin = await _get_avatar(db, ctx.org.id, body.source_avatar_id)
        if origin.kind != AvatarKind.photo or not origin.image_key:
            raise Conflict409("The source avatar is not a photo", code="not_a_photo")
        source = await storage.get_bytes(origin.image_key)

    accepted: list[dict] = []
    rejected: list[str] = []
    attempts = 0
    while len(accepted) < body.count and attempts < MAX_GENERATION_ATTEMPTS:
        # Checked before every attempt, not once up front: the retry loop can
        # run several times per click, and a limit that only guards the first
        # one is not a limit.
        await check_image_limit(db, ctx.org.id)
        attempts += 1
        try:
            result = await generate(body.style, source, extra=body.note)
            # Recorded on success only — a request the provider rejected was
            # not billed, and counting it would spend the user's allowance on
            # our own errors.
            await record_generation(db, ctx.org.id, "gemini")
        except ImageGenUnavailable as exc:
            raise Conflict409(
                "Image generation is not configured on this server",
                code="imagegen_unavailable",
            ) from exc
        except Exception as exc:
            logger.exception("generation attempt failed")
            rejected.append(str(exc)[:120])
            continue

        verdict = check_image(result.image)
        if not verdict.ok:
            rejected.append(verdict.summary)
            continue

        # Candidates live outside any avatar until one is chosen, so an
        # abandoned generation leaves no half-made avatar in the list.
        key = f"orgs/{ctx.org.id}/candidates/{uuid4().hex}.png"
        await storage.put_bytes(key, result.image, "image/png")
        accepted.append(
            {
                "key": key,
                "url": await storage.presign_get(key),
                "face_fraction": round(verdict.face_fraction, 3),
            }
        )

    return {
        "candidates": accepted,
        "rejected": rejected,
        "attempts": attempts,
    }


class FromCandidateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    key: str


@router.post("/from-candidate", response_model=AvatarOut, status_code=201)
async def create_from_candidate(
    body: FromCandidateRequest, ctx: OrgMember, db: DB, background: BackgroundTasks
) -> Avatar:
    """Turn a chosen candidate into a real avatar."""
    storage = get_storage()
    # The key is client-supplied, so it is checked against this org's own
    # candidate prefix — otherwise it would read any object in storage.
    prefix = f"orgs/{ctx.org.id}/candidates/"
    if not body.key.startswith(prefix) or ".." in body.key:
        raise Validation422("Unknown candidate", code="unknown_candidate")
    if not await storage.exists(body.key):
        raise Validation422("That candidate has expired", code="unknown_candidate")

    avatar = Avatar(
        org_id=ctx.org.id,
        created_by_id=ctx.membership.user_id,
        name=body.name,
        kind=AvatarKind.photo,
        content_type="image/png",
    )
    db.add(avatar)
    await db.flush()
    avatar.image_key = f"orgs/{ctx.org.id}/avatars/{avatar.id}/source.png"
    await storage.put_bytes(avatar.image_key, await storage.get_bytes(body.key), "image/png")
    await db.commit()
    await record_generated_avatar(db, ctx.org.id, "gemini")
    background.add_task(process_avatar, avatar.id)
    return avatar
