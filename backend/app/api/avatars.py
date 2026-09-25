from __future__ import annotations

import functools
import logging
from collections.abc import Awaitable, Callable
from typing import Any, TypeVar
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, BackgroundTasks, UploadFile
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
    FitReason,
    RigFit,
    RigFitResult,
)
from uuid import uuid4

from app.services.rig import process_avatar
from app.services.anchor_fit import (
    NUM_POINTS,
    fit_base_key,
    fit_base_points,
    fit_base_record,
    fit_rig,
    marks_from_dict,
    marks_from_mesh,
    marks_mouth_as_line,
    marks_to_dict,
    merge,
    move_fit_base,
    read_fit_base,
    render_profile_for,
    saved_marks,
    with_head_outline,
    write_fit_base,
)
from app.services.segment import SegmentationUnavailable, remove_background
from app.services.edit_locks import avatar_edits
from app.services.publishing import confirmed, discard_draft, mark_dirty, publish
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


R = TypeVar("R")


def _one_edit_at_a_time(route: Callable[..., Awaitable[R]]) -> Callable[..., Awaitable[R]]:
    """Run a route that edits an avatar's draft with that avatar's edit lock
    held (services.edit_locks), taken before the route reads the row.

    These routes rewrite files in place and commit the row last, awaiting
    in between (seconds, for the layer build), so two of them interleaving
    on one avatar mix one's committed row with the other's rewritten files:
    two overlapping crops cut the image once and move the rig twice. Reads
    that only present the draft (GET) are not held; a publish is, since it
    snapshots the draft's files.
    """

    @functools.wraps(route)
    async def locked(**kwargs: Any) -> R:
        # FastAPI passes every parameter by name, and reads the signature
        # (dependencies included) from `route` through functools.wraps.
        async with avatar_edits.hold(kwargs["avatar_id"]):
            return await route(**kwargs)

    return locked


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
        face_type=body.face_type,
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


@router.post("/avaturn-session")
async def avaturn_session(ctx: OrgMember) -> dict:
    """An Avaturn editor URL for this user to build a 3D avatar in.

    The token never leaves the server; the browser only ever sees the
    session URL, which is scoped to one throwaway Avaturn user.
    """
    from app.services.avaturn import AvaturnUnavailable, new_session

    try:
        return await new_session()
    except AvaturnUnavailable as exc:
        raise Conflict409(
            "No 3D avatar provider is configured on this server",
            code="avaturn_unavailable",
        ) from exc


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


class BackgroundRequest(BaseModel):
    """True removes the background, false restores the original photo."""

    remove: bool = True


@router.patch("/{avatar_id}", response_model=AvatarOut)
@_one_edit_at_a_time
async def update_avatar(
    avatar_id: str, body: AvatarUpdate, ctx: OrgMember, db: DB
) -> Avatar:
    """Change owner-editable settings.

    Framing lives here rather than on the embed snippet so that switching it
    reaches sites that already have the snippet pasted in — they re-read the
    avatar on every page load, so the change lands without anyone editing HTML.
    """
    from app.services.mouth import load as load_mouth, renderer_allowed

    avatar = await _get_avatar(db, ctx.org.id, avatar_id)
    face_type = body.face_type or avatar.face_type
    if body.mouth is not None and not renderer_allowed(body.mouth.renderer, face_type):
        raise Validation422(
            "The photographic mouth draws human teeth, so it is only for human faces",
            code="mouth_not_for_face_type",
        )
    if body.name is not None:
        avatar.name = body.name
    if body.framing is not None:
        avatar.framing = body.framing
    if body.voice is not None:
        import json as _json

        avatar.voice_config = _json.dumps(body.voice.model_dump())
    if body.mouth is not None:
        import json as _json

        # Renderer and fit change; the mouth photo is managed by its own
        # endpoints and carried over untouched.
        current = load_mouth(avatar.mouth_config) or {}
        current.update(renderer=body.mouth.renderer, profile=body.mouth.profile.model_dump())
        avatar.mouth_config = _json.dumps(current)
    if (
        body.framing is not None
        or body.face_type is not None
        or body.voice is not None
        or body.mouth is not None
    ):
        mark_dirty(avatar)
    if body.face_type is not None and body.face_type != avatar.face_type:
        avatar.face_type = body.face_type
        # Only the viseme table changes. Re-running detection would throw
        # away a hand-marked rig for a setting that has nothing to do with
        # where the landmarks are.
        await _reprofile_visemes(avatar)
        # A face that is no longer human cannot keep human teeth; the fit
        # and any teeth photo stay, so switching back restores nothing lost
        # but the renderer choice.
        mouth = load_mouth(avatar.mouth_config)
        if mouth and not renderer_allowed(mouth["renderer"], avatar.face_type):
            import json as _json

            mouth["renderer"] = "classic"
            avatar.mouth_config = _json.dumps(mouth)
    await db.commit()
    return avatar


async def _reprofile_visemes(avatar: Avatar) -> None:
    """Swap the stored rig's viseme table and render profile to match the
    avatar's face type. The draft only: visitors see it once published."""
    import json as _json

    from app.services.rig import VISEME_BLENDSHAPES, VISEME_PROFILES

    if not avatar.rig_key or avatar.kind != AvatarKind.photo:
        return
    storage = get_storage()
    try:
        rig = _json.loads(await storage.get_bytes(avatar.rig_key))
        rig["visemes"] = VISEME_PROFILES.get(avatar.face_type, VISEME_BLENDSHAPES)
        # A face that stops being an animal must get its incisors back, and
        # one that becomes an animal loses them, as a fit would have done.
        profile = render_profile_for(avatar.face_type)
        if profile:
            rig["render_profile"] = profile
        else:
            rig.pop("render_profile", None)
        await storage.put_bytes(
            avatar.rig_key, _json.dumps(rig).encode(), "application/json"
        )
    except Exception:
        logger.exception("viseme reprofile failed for avatar %s", avatar.id)


@router.post("/{avatar_id}/background", response_model=AvatarOut)
@_one_edit_at_a_time
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
        mark_dirty(avatar)
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
    mark_dirty(avatar)
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
@_one_edit_at_a_time
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
    mark_dirty(avatar)
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
@_one_edit_at_a_time
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
        # Either may be the crop as cut: a background removed after
        # cropping replaces image_key and keeps the crop as the original.
        cropped_keys = [k for k in (avatar.image_key, avatar.original_image_key) if k]
        avatar.image_key = avatar.precrop_image_key
        avatar.precrop_image_key = None
        await _rebuild_thumbnail(avatar, storage)
        await _uncrop_rig(avatar, storage, cropped_keys)
        await _rebuild_layers(avatar, storage)
        mark_dirty(avatar)
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

    from app.services.photo_io import has_alpha, png_bytes

    source = Image.open(io.BytesIO(await storage.get_bytes(avatar.image_key)))
    # Preserve alpha: cropping a cut-out must not paste the background back.
    source = source.convert("RGBA" if has_alpha(source) else "RGB")
    width, height = source.size

    left = int(round(body.x * width))
    top = int(round(body.y * height))
    right = int(round((body.x + body.width) * width))
    bottom = int(round((body.y + body.height) * height))
    cropped = source.crop((left, top, right, bottom))

    await _snapshot(avatar, storage, "crop")
    key = f"orgs/{avatar.org_id}/avatars/{avatar.id}/source-crop.png"
    await storage.put_bytes(key, png_bytes(cropped), "image/png")
    first_crop = not avatar.precrop_image_key
    # Only the first crop records the pre-crop image, so cropping twice still
    # resets all the way back rather than to the previous crop.
    if first_crop:
        avatar.precrop_image_key = avatar.image_key
    avatar.image_key = key

    if avatar.rig_key:
        rig = _json.loads(await storage.get_bytes(avatar.rig_key))
        # Where this crop sits in the pre-crop photo, accumulated over
        # repeated crops, so a reset can move the rig back exactly instead
        # of re-detecting (which loses hand marks and, for an undetectable
        # face, the whole fit). A rig cropped before this was recorded has
        # no origin to add to; it stays without one and reset falls back.
        origin = [0, 0] if first_crop else rig.get("crop_origin")
        base_key = fit_base_key(avatar.org_id, avatar.id)
        base = await read_fit_base(storage, base_key)
        base_follows = fit_base_points(base, rig) is not None
        rig = _move_rig(rig, left, top, cropped.size)
        if origin is not None:
            rig["crop_origin"] = [origin[0] + left, origin[1] + top]
        await storage.put_bytes(avatar.rig_key, _json.dumps(rig).encode(), "application/json")
        # The fit base moves with its rig, so marks saved after the crop are
        # fitted from the same mesh as before it. One that already did not
        # match is left to be rebuilt when next needed.
        if base_follows:
            await write_fit_base(storage, base_key, move_fit_base(base, left, top, rig))
    await _rebuild_thumbnail(avatar, storage)
    await _rebuild_layers(avatar, storage)
    mark_dirty(avatar)
    await db.commit()
    return avatar


def _move_rig(rig: dict, left: float, top: float, size: tuple[int, int]) -> dict:
    """The rig for an image whose top-left sits at (left, top) of the
    current one — a crop, or with a negative origin, the crop undone."""
    moved = dict(rig)
    moved["image_size"] = [size[0], size[1]]
    moved["points"] = [[p[0] - left, p[1] - top] for p in rig.get("points", [])]
    box = rig.get("face_box")
    if box and len(box) == 4:
        moved["face_box"] = [box[0] - left, box[1] - top, box[2] - left, box[3] - top]
    # Saved hand-placed marks live in image pixels too; without this a crop
    # would reopen the marking panel with every handle off by the crop origin.
    if rig.get("user_anchors"):
        moved["user_anchors"] = _move_anchors(rig["user_anchors"], left, top)
    return moved


def _move_anchors(anchors, left: float, top: float):
    """Every {x, y} in a marking, wherever it sits: region edges, pupils,
    the mouth line's list, the chin. Anything else (the source) is kept."""
    if isinstance(anchors, dict):
        if "x" in anchors and "y" in anchors:
            return {**anchors, "x": anchors["x"] - left, "y": anchors["y"] - top}
        return {key: _move_anchors(value, left, top) for key, value in anchors.items()}
    if isinstance(anchors, list):
        return [_move_anchors(value, left, top) for value in anchors]
    return anchors


async def _uncrop_rig(avatar: Avatar, storage, cropped_keys: list[str]) -> None:
    """Put the rig back into the pre-crop photo's coordinates.

    A translation, not a re-detection: the rig keeps its viseme table, its
    hand-placed marks and, for a face no detector finds, the fit the owner
    made by hand. Rigs cropped before the origin was recorded get it from
    the pixels — a crop is an exact sub-rectangle of the photo it was cut
    from — and only when that fails is the face detected again.
    """
    import io
    import json as _json

    from PIL import Image

    if not avatar.rig_key or not avatar.image_key:
        return
    rig = _json.loads(await storage.get_bytes(avatar.rig_key))
    base_key = fit_base_key(avatar.org_id, avatar.id)
    base = await read_fit_base(storage, base_key)
    base_follows = fit_base_points(base, rig) is not None
    precrop_bytes = await storage.get_bytes(avatar.image_key)
    precrop = Image.open(io.BytesIO(precrop_bytes))

    origin = rig.get("crop_origin")
    if origin is None:
        for key in cropped_keys:
            try:
                cropped = Image.open(io.BytesIO(await storage.get_bytes(key)))
            except Exception:
                continue
            origin = _locate_crop(precrop, cropped)
            if origin is not None:
                break

    if origin is not None:
        restored = _move_rig(rig, -origin[0], -origin[1], precrop.size)
        restored.pop("crop_origin", None)
        base = move_fit_base(base, -origin[0], -origin[1], restored) if base_follows else None
    else:
        redetected = _redetect_rig(avatar, precrop_bytes, rig)
        if redetected is None:
            return
        restored, base = redetected
    await storage.put_bytes(avatar.rig_key, _json.dumps(restored).encode(), "application/json")
    if base is not None:
        await write_fit_base(storage, base_key, base)


def _locate_crop(outer, inner) -> tuple[int, int] | None:
    """Where `inner` sits in `outer` pixel for pixel, or None when it does
    not sit anywhere exactly once (not a crop of it, or a flat image where
    every position matches and the origin is unknowable)."""
    import numpy as np

    from app.services.photo_io import scrub_transparent

    # Compared as scrubbed RGBA: an older cut-out still holds colour under
    # alpha 0, and cropping it now blanks that colour.
    big = np.ascontiguousarray(np.asarray(scrub_transparent(outer))).view(np.uint32)[:, :, 0]
    small = np.ascontiguousarray(np.asarray(scrub_transparent(inner))).view(np.uint32)[:, :, 0]
    (height, width), (h, w) = big.shape, small.shape
    if h > height or w > width:
        return None
    span_y, span_x = height - h + 1, width - w + 1
    # Narrow the candidate origins with a spread of probe pixels, then check
    # the few survivors in full.
    candidates = np.ones((span_y, span_x), dtype=bool)
    for py in np.linspace(0, h - 1, 5).astype(int):
        for px in np.linspace(0, w - 1, 5).astype(int):
            candidates &= big[py : py + span_y, px : px + span_x] == small[py, px]
    found = [
        (int(x), int(y))
        for y, x in np.argwhere(candidates)[:8]
        if np.array_equal(big[y : y + h, x : x + w], small)
    ]
    return found[0] if len(found) == 1 else None


def _redetect_rig(
    avatar: Avatar, image_bytes: bytes, previous: dict
) -> tuple[dict, dict] | None:
    """Last resort for a crop reset with no recoverable origin: the rig and
    its fit base, built as a first build would build them.

    Detection runs with the avatar's face type so the rig keeps its viseme
    table and an undetected animal its template. Hand marks cannot follow:
    they are in the cropped photo's coordinates and nothing says where that
    crop was.
    """
    from app.services.rig import build_rig, fit_base_mesh, landmarks_from_image, starting_mesh

    try:
        points, blendshapes, size, detected = landmarks_from_image(image_bytes)
    except Exception:
        logger.exception("rig rebuild failed after crop reset for avatar %s", avatar.id)
        return None
    if previous.get("user_anchors"):
        logger.warning(
            "crop reset for avatar %s: crop origin unknown, hand marks dropped", avatar.id
        )
    rig = build_rig(
        starting_mesh(points, size, detected, avatar.face_type), size, blendshapes,
        face_type=avatar.face_type,
    )
    return rig, fit_base_record(fit_base_mesh(points, size, detected), rig, detected)


def _clamped(value, width: float, height: float):
    """A marking with every point pulled inside the image."""
    if isinstance(value, dict):
        if "x" in value and "y" in value:
            x, y = min(max(value["x"], 0), width), min(max(value["y"], 0), height)
            return {**value, "x": x, "y": y}
        return {key: _clamped(v, width, height) for key, v in value.items()}
    if isinstance(value, list):
        return [_clamped(v, width, height) for v in value]
    return value


@router.get("/{avatar_id}/rig-anchors")
async def rig_anchors(avatar_id: str, ctx: OrgMember, db: DB) -> dict:
    """Where each handle of the avatar's line opens.

    On the owner's saved marks where there are some, returned as placed (the
    fitted mesh only passes near a mark, it is not where the handle was
    dropped). Anything never marked opens on the landmark it attaches to, in
    the mesh those saved marks make from the base — so a good detection
    means dragging nothing, and an eye left unmarked sits where the fit put
    it; a head saved with four points opens with its outline diagonals on
    the fitted mesh. Always in the line's scheme: an animal marked before
    mouth lines existed opens with a mouth line. Clamped to the image,
    because a later crop can leave a saved mark outside it, where no handle
    could be dragged from.
    """
    import json as _json

    import numpy as np

    avatar = await _get_avatar(db, ctx.org.id, avatar_id)
    if avatar.kind != AvatarKind.photo or not avatar.rig_key or not avatar.image_key:
        raise Conflict409("Avatar has no rig", code="not_adjustable")
    storage = get_storage()
    rig = _json.loads(await storage.get_bytes(avatar.rig_key))
    if len(rig.get("points") or []) != NUM_POINTS:
        raise Conflict409("Avatar rig is not adjustable", code="not_adjustable")
    base, rig_on_base = await _fit_base(avatar, storage, rig)
    saved = saved_marks(rig, avatar.face_type, rig_on_base)
    fitted, _ = fit_rig(rig, base, saved, avatar.face_type)
    # A head saved before it had diagonals opens with them where its fit put
    # them, so all eight handles are there, and the panel, which sends a head
    # it did not touch without them, saves it exactly as it was.
    points = np.array(fitted["points"], dtype=float)
    marks = with_head_outline(merge(marks_from_mesh(points, avatar.face_type), saved), points)
    width, height = rig["image_size"]
    return {
        "anchors": _clamped(marks_to_dict(marks), width, height),
        "image_size": rig["image_size"],
    }


async def _fit_base(avatar: Avatar, storage, rig: dict):
    """The mesh this rig's fits start from — the detection, else the
    template — and whether the rig's own points number their landmarks as
    it does (see anchor_fit.saved_marks): true of a detection, which the rig
    was built on, and of a rig that is its own base.

    Normally the stored base. A rig without one (built before bases were
    kept) or whose base belongs to another frame (an undo or a discarded
    draft put back an older rig) gets it rebuilt the way a first build makes
    it — detection, else the template — which is deterministic, and stored.
    """
    import numpy as np
    from starlette.concurrency import run_in_threadpool

    from app.services.rig import fit_base_mesh, landmarks_from_image

    key = fit_base_key(avatar.org_id, avatar.id)
    stored = await read_fit_base(storage, key)
    points = fit_base_points(stored, rig)
    if points is not None:
        return points, bool(stored.get("detected"))

    def detect(data: bytes):
        found, _, size, detected = landmarks_from_image(data)
        return fit_base_mesh(found, size, detected), size, detected

    image = await storage.get_bytes(avatar.image_key)
    found, size, detected = await run_in_threadpool(detect, image)
    if list(size) != list(rig["image_size"]):
        # The photo and the rig disagree on the frame; nothing rebuilt from
        # the photo would line up, so the rig's own mesh is the only base
        # (and old marks read off it leave it exactly as it is).
        logger.warning("fit base for avatar %s taken from its rig: frame mismatch", avatar.id)
        return np.array(rig["points"], dtype=float), True
    record = fit_base_record(found, rig, detected)
    await write_fit_base(storage, key, record)
    # As stored, not as computed: the next fit reads the stored copy, and the
    # same marks must give the same rig both times.
    return fit_base_points(record, rig), detected


def _marks_outside(body: RigFit, width: float, height: float) -> bool:
    """Whether any mark the client sent lies outside the image."""

    def points(value):
        if isinstance(value, dict):
            if "x" in value and "y" in value:
                yield value
            else:
                for v in value.values():
                    yield from points(v)
        elif isinstance(value, list):
            for v in value:
                yield from points(v)

    marks = body.model_dump(exclude={"persist"}, exclude_none=True)
    return any(not (0 <= p["x"] <= width and 0 <= p["y"] <= height) for p in points(marks))


@router.post("/{avatar_id}/rig-fit", response_model=RigFitResult)
@_one_edit_at_a_time
async def rig_fit(avatar_id: str, body: RigFit, ctx: OrgMember, db: DB) -> RigFitResult:
    """Rebuild the rig from hand-placed anchors (services.anchor_fit).

    With `persist` false this computes the fitted rig and returns it without
    writing, with the validator's reasons, so the client can render and speak
    with the exact object a save would store — the preview cannot disagree
    with the result, because it IS the result. With `persist` true a fit the
    validator rejects is refused (422, with the reasons) and nothing changes.
    """
    import json as _json

    avatar = await _get_avatar(db, ctx.org.id, avatar_id)
    if avatar.kind != AvatarKind.photo or avatar.status != AvatarStatus.ready or not avatar.rig_key:
        raise Conflict409("Avatar rig is not adjustable", code="not_adjustable")

    storage = get_storage()
    rig = _json.loads(await storage.get_bytes(avatar.rig_key))
    if len(rig.get("points") or []) != NUM_POINTS:
        raise Conflict409("Avatar rig is not adjustable", code="not_adjustable")
    face_type = avatar.face_type
    as_line = body.mouth_line is not None or body.chin is not None
    if as_line and not marks_mouth_as_line(face_type):
        raise Validation422(
            "A human mouth is marked by its edges, not as a line with a chin",
            code="mouth_line_not_for_face_type",
        )
    width, height = rig["image_size"]
    if _marks_outside(body, width, height):
        raise Validation422("Every mark must be inside the image", code="mark_outside_image")

    base, rig_on_base = await _fit_base(avatar, storage, rig)
    # Merged over what was saved before, and always fitted from the base:
    # the same marks give the same rig however often they are saved.
    marks = merge(
        saved_marks(rig, face_type, rig_on_base),
        marks_from_dict(body.model_dump(exclude={"persist"}, exclude_none=True), face_type),
    )
    adjusted, problems = fit_rig(rig, base, marks, face_type)
    reasons = [FitReason(code=p.code, detail=p.detail, count=p.count) for p in problems]

    if body.persist:
        if reasons:
            raise Validation422(
                "These marks would distort the face: " + "; ".join(r.detail for r in reasons),
                code="fit_invalid",
                extra={"reasons": [r.model_dump() for r in reasons]},
            )
        await storage.put_bytes(
            avatar.rig_key, _json.dumps(adjusted).encode(), "application/json"
        )
        mark_dirty(avatar)
        # Committed, or the dirty mark is lost with the session: the saved
        # marks would reach visitors silently on the next unrelated publish,
        # and the Publish bar would never say they were waiting.
        await db.commit()
    return RigFitResult(rig=adjusted, persisted=body.persist, reasons=reasons)


@router.post("/{avatar_id}/publish", response_model=AvatarOut)
@_one_edit_at_a_time
async def publish_avatar(avatar_id: str, ctx: OrgMember, db: DB) -> Avatar:
    """Make the current draft what embedded sites and share links serve.

    Copies the draft's assets into an immutable snapshot rather than
    recording which keys were live — layer files are overwritten in place,
    so pointers would silently drift. See services/publishing.
    """
    avatar = await _get_avatar(db, ctx.org.id, avatar_id)
    if avatar.status != AvatarStatus.ready:
        raise Conflict409("Only a ready avatar can be published", code="not_ready")
    try:
        await publish(avatar, get_storage())
    except ValueError as exc:
        raise Conflict409(str(exc), code="nothing_to_publish") from exc
    # Publishing is the confirmation a held-back first build was waiting
    # for; the note keeps its reason and loses the instruction.
    avatar.quality_note = confirmed(avatar.quality_note)
    await db.commit()
    return avatar


@router.post("/{avatar_id}/discard-draft", response_model=AvatarOut)
@_one_edit_at_a_time
async def discard_avatar_draft(avatar_id: str, ctx: OrgMember, db: DB) -> Avatar:
    """Throw the draft away and go back to what is published."""
    avatar = await _get_avatar(db, ctx.org.id, avatar_id)
    if not await discard_draft(avatar, get_storage()):
        raise Conflict409(
            "This avatar has never been published, so there is nothing to go back to",
            code="never_published",
        )
    await db.commit()
    return avatar


@router.post("/{avatar_id}/share", response_model=AvatarOut)
async def enable_share(avatar_id: str, ctx: OrgMember, db: DB) -> Avatar:
    """Publish a public page for this avatar, at /s/<token>.

    Idempotent: an avatar that already has a link keeps it, so pressing the
    button twice cannot invalidate a link someone has already sent out.
    """
    avatar = await _get_avatar(db, ctx.org.id, avatar_id)
    if avatar.status != AvatarStatus.ready:
        raise Conflict409("Only a ready avatar can be shared", code="not_ready")
    if not avatar.share_token:
        avatar.share_token = uuid4().hex
        await db.commit()
    return avatar


@router.delete("/{avatar_id}/share", response_model=AvatarOut)
async def disable_share(avatar_id: str, ctx: OrgMember, db: DB) -> Avatar:
    """Revoke the public page. Every copy of the link stops working at once."""
    avatar = await _get_avatar(db, ctx.org.id, avatar_id)
    avatar.share_token = None
    await db.commit()
    return avatar


@router.post("/{avatar_id}/rig-reset", response_model=AvatarOut)
@_one_edit_at_a_time
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
    from app.api.embed import _layer_urls

    detail.layer_urls = await _layer_urls(avatar, storage)
    from app.services.mouth import load as load_mouth, photo_urls

    detail.mouth_photo = await photo_urls(load_mouth(avatar.mouth_config), storage)
    return detail


@router.post("/{avatar_id}/mouth-photo", response_model=AvatarOut)
@_one_edit_at_a_time
async def upload_mouth_photo(avatar_id: str, file: UploadFile, ctx: OrgMember, db: DB) -> Avatar:
    """A second photo of the same person with teeth showing.

    It supplies THEIR enamel to the continuous mouth instead of fitted
    geometry. Validated exactly as in the lab it graduated from: a real
    detected face, large enough, mouth actually open. A draft edit like any
    other — visitors see it only after Publish.
    """
    import json as _json

    from starlette.concurrency import run_in_threadpool

    from app.services.mouth import load as load_mouth, oral_keys, renderer_allowed
    from app.services.portrait_photo import MAX_BYTES, prepare_photo

    avatar = await _get_avatar(db, ctx.org.id, avatar_id)
    if avatar.kind != AvatarKind.photo or avatar.status != AvatarStatus.ready:
        raise Conflict409("Only a ready photo avatar can take a mouth photo", code="not_a_photo")
    # The photo only feeds the photographic mouth, which this face may not use.
    if not renderer_allowed("continuous", avatar.face_type):
        raise Validation422(
            "The photographic mouth draws human teeth, so it is only for human faces",
            code="mouth_not_for_face_type",
        )
    if file.content_type not in get_settings().allowed_image_types:
        raise Validation422("Choose a JPEG, PNG or WebP photo", code="unsupported_image_type")
    data = await file.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise Validation422("Photo must be 15 MB or smaller", code="image_too_large")
    photo, rig, _note = await run_in_threadpool(prepare_photo, data, "mouth")

    storage = get_storage()
    config = load_mouth(avatar.mouth_config) or {"renderer": "continuous", "profile": {}}
    previous = (config.get("oral_image_key"), config.get("oral_rig_key"))
    # Fresh keys per upload: the published snapshot may still point at
    # copies of the old ones, and browsers cache presigned URLs by path.
    image_key, rig_key = oral_keys(ctx.org.id, avatar.id, uuid4().hex[:8])
    await storage.put_bytes(image_key, photo, "image/png")
    await storage.put_bytes(rig_key, _json.dumps(rig).encode(), "application/json")
    config.update(oral_image_key=image_key, oral_rig_key=rig_key)
    avatar.mouth_config = _json.dumps(config)
    mark_dirty(avatar)
    await db.commit()
    for key in previous:
        if key:
            await storage.delete(key)
    return avatar


@router.delete("/{avatar_id}/mouth-photo", response_model=AvatarOut)
@_one_edit_at_a_time
async def remove_mouth_photo(avatar_id: str, ctx: OrgMember, db: DB) -> Avatar:
    """Back to fitted teeth. The published snapshot keeps its own copy."""
    import json as _json

    from app.services.mouth import load as load_mouth

    avatar = await _get_avatar(db, ctx.org.id, avatar_id)
    config = load_mouth(avatar.mouth_config)
    if not config or not config.get("oral_image_key"):
        return avatar
    storage = get_storage()
    for name in ("oral_image_key", "oral_rig_key"):
        key = config.pop(name, None)
        if key:
            await storage.delete(key)
    avatar.mouth_config = _json.dumps(config)
    mark_dirty(avatar)
    await db.commit()
    return avatar


@router.delete("/{avatar_id}", status_code=204)
@_one_edit_at_a_time
async def delete_avatar(avatar_id: str, ctx: OrgMember, db: DB):
    """Delete the avatar and every file it owns.

    By prefix, not by a list of keys: an avatar accumulates files no column
    points at any more — the pre-crop and pre-cut-out photos, undo history,
    layers, every published revision — and a hand-kept list is exactly what
    left the published copies of "deleted" avatars in storage.
    """
    avatar = await _get_avatar(db, ctx.org.id, avatar_id)
    await get_storage().delete_prefix(f"orgs/{avatar.org_id}/avatars/{avatar.id}/")
    await db.delete(avatar)
    await db.commit()
