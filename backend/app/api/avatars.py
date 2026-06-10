from __future__ import annotations

from fastapi import APIRouter, BackgroundTasks
from sqlalchemy import select

from app.api.deps import DB, OrgMember
from app.core.config import get_settings
from app.core.errors import Conflict409, NotFound404, Validation422
from app.models import Avatar, AvatarStatus
from app.schemas.avatar import AvatarCreate, AvatarCreated, AvatarDetail, AvatarOut
from app.services.rig import process_avatar
from app.services.storage import get_storage

router = APIRouter(prefix="/orgs/{org_id}/avatars", tags=["avatars"])


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
    if body.content_type not in settings.allowed_image_types:
        raise Validation422(
            f"content_type must be one of {settings.allowed_image_types}",
            code="unsupported_image_type",
        )
    avatar = Avatar(
        org_id=ctx.org.id,
        created_by_id=ctx.membership.user_id,
        name=body.name,
        content_type=body.content_type,
    )
    db.add(avatar)
    await db.flush()
    ext = body.content_type.split("/")[-1].replace("jpeg", "jpg")
    avatar.image_key = f"orgs/{ctx.org.id}/avatars/{avatar.id}/source.{ext}"
    await db.commit()
    upload_url = await get_storage().presign_put(avatar.image_key, body.content_type)
    return AvatarCreated(avatar=AvatarOut.model_validate(avatar), upload_url=upload_url)


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


@router.get("/{avatar_id}", response_model=AvatarDetail)
async def get_avatar_detail(avatar_id: str, ctx: OrgMember, db: DB) -> AvatarDetail:
    avatar = await _get_avatar(db, ctx.org.id, avatar_id)
    storage = get_storage()
    detail = AvatarDetail.model_validate(avatar)
    if avatar.image_key and await storage.exists(avatar.image_key):
        detail.image_url = await storage.presign_get(avatar.image_key)
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
