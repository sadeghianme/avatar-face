"""The avatar's picture: background, crop, undo, and the scene behind it."""

from __future__ import annotations

from fastapi import UploadFile
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from app.api.avatars.routing import one_edit_at_a_time, router
from app.api.deps import DB, OrgMember
from app.core.config import get_settings
from app.core.errors import Validation422
from app.models import Avatar
from app.schemas.avatar import AvatarOut
from app.services import scene as scene_service
from app.services.avatars import history, photo, repo, settings
from app.services.portrait_photo import MAX_BYTES


class BackgroundRequest(BaseModel):
    """True removes the background, false restores the original photo."""

    remove: bool = True


class CropRequest(BaseModel):
    """A rectangle in fractions of the current image, or a reset."""

    x: float = Field(default=0.0, ge=0.0, le=1.0)
    y: float = Field(default=0.0, ge=0.0, le=1.0)
    width: float = Field(default=1.0, gt=0.0, le=1.0)
    height: float = Field(default=1.0, gt=0.0, le=1.0)
    reset: bool = False


@router.post("/{avatar_id}/background", response_model=AvatarOut)
@one_edit_at_a_time
async def set_background(
    avatar_id: str, body: BackgroundRequest, ctx: OrgMember, db: DB
) -> Avatar:
    """Cut the subject out of the photo, or put the original back.

    The rig is untouched on purpose. Removing a background does not move a
    single landmark — the face is in exactly the same place — so re-detecting
    would only risk a worse fit than the one already there, possibly one the
    user corrected by hand. The mouth kit stays for the same reason: its
    shapes are the face's movements, and a cut-out moves no pixel of the
    face.
    """
    avatar = await repo.require_in_org(db, ctx.org.id, avatar_id)
    await photo.set_background(db, avatar, body.remove)
    return avatar


@router.post("/{avatar_id}/undo", response_model=AvatarOut)
@one_edit_at_a_time
async def undo_edit(avatar_id: str, ctx: OrgMember, db: DB) -> Avatar:
    """Step back one edit — crop, background, framing, whatever it was."""
    avatar = await repo.require_in_org(db, ctx.org.id, avatar_id)
    await history.undo(db, avatar)
    return avatar


@router.post("/{avatar_id}/crop", response_model=AvatarOut)
@one_edit_at_a_time
async def crop_avatar(
    avatar_id: str, body: CropRequest, ctx: OrgMember, db: DB
) -> Avatar:
    """Crop the photo, and move the rig with it.

    The rig is in image pixels, so cropping the image without translating the
    landmarks would leave every point offset by the crop origin — the mesh
    would sit beside the face instead of on it. Translating is exact and,
    unlike re-detecting, keeps any correction the user made by hand.
    """
    avatar = await repo.require_in_org(db, ctx.org.id, avatar_id)
    await photo.crop(db, avatar, body.x, body.y, body.width, body.height, body.reset)
    return avatar


@router.post("/{avatar_id}/scene-image", response_model=AvatarOut)
@one_edit_at_a_time
async def upload_scene_image(avatar_id: str, file: UploadFile, ctx: OrgMember, db: DB) -> Avatar:
    """A picture to show behind a cut-out (services.scene): validated,
    re-encoded and stored under a fresh key, and shown from now on. A draft
    edit like any other — visitors see it only after Publish. An opaque
    picture may have one too (the dashboard says it will not show until the
    background is removed)."""
    avatar = await repo.require_in_org(db, ctx.org.id, avatar_id)
    settings.require_scene(avatar)
    if file.content_type not in get_settings().allowed_image_types:
        raise Validation422("Choose a JPEG, PNG or WebP picture", code="unsupported_image_type")
    data = await file.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise Validation422("Picture must be 15 MB or smaller", code="image_too_large")
    image = await run_in_threadpool(scene_service.prepare_image, data)
    await settings.set_scene_image(db, avatar, image)
    return avatar


@router.delete("/{avatar_id}/scene-image", response_model=AvatarOut)
@one_edit_at_a_time
async def remove_scene_image(avatar_id: str, ctx: OrgMember, db: DB) -> Avatar:
    """Drop the background picture: nothing behind the avatar again. The
    published snapshot keeps its own copy until the next Publish."""
    avatar = await repo.require_in_org(db, ctx.org.id, avatar_id)
    await settings.remove_scene_image(db, avatar)
    return avatar
