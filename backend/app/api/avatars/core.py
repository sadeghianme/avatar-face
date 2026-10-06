"""Avatars: making them, listing them, their settings, the rig job, delete."""

from __future__ import annotations

from fastapi import BackgroundTasks

from app.api.avatars.routing import one_edit_at_a_time, router, sign_motion
from app.api.deps import DB, OrgMember
from app.core.errors import Conflict409
from app.models import Avatar, AvatarKind
from app.schemas.avatar import (
    AvatarCreate,
    AvatarCreated,
    AvatarDetail,
    AvatarFromUrl,
    AvatarOut,
    AvatarUpdate,
)
from app.services import scene as scene_service
from app.services.avatars import lifecycle, repo, settings, sources
from app.services.rig import process_avatar
from app.services.storage import get_storage


@router.post("", response_model=AvatarCreated, status_code=201)
async def create_avatar(body: AvatarCreate, ctx: OrgMember, db: DB) -> AvatarCreated:
    avatar, upload_url = await sources.create_for_upload(
        db, ctx.org.id, ctx.membership.user_id, body.name, body.content_type, body.face_type
    )
    return AvatarCreated(avatar=AvatarOut.model_validate(avatar), upload_url=upload_url)


@router.post("/from-url", response_model=AvatarOut, status_code=201)
async def create_from_url(
    body: AvatarFromUrl, ctx: OrgMember, db: DB, background: BackgroundTasks
) -> Avatar:
    """Import a GLB avatar by URL (e.g. https://models.readyplayer.me/<id>.glb)."""
    avatar = await sources.import_model(
        db, ctx.org.id, ctx.membership.user_id, body.url, body.name
    )
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
    return await repo.list_in_org(db, ctx.org.id)


@router.post("/{avatar_id}/uploaded", response_model=AvatarOut)
async def confirm_uploaded(
    avatar_id: str, ctx: OrgMember, db: DB, background: BackgroundTasks
) -> Avatar:
    avatar = await repo.require_in_org(db, ctx.org.id, avatar_id)
    await lifecycle.check_uploaded(avatar)
    background.add_task(process_avatar, avatar.id)
    return avatar


@router.post("/{avatar_id}/retry", response_model=AvatarOut)
async def retry_rig(
    avatar_id: str, ctx: OrgMember, db: DB, background: BackgroundTasks
) -> Avatar:
    """Re-enqueue the rig job (used by the stall-detection UI). Not for an
    avatar the creation wizard is still preparing (409 avatar_preparing):
    its finish job builds it, and there is nothing of it to retry yet."""
    avatar = await repo.require_in_org(db, ctx.org.id, avatar_id)
    await lifecycle.retry(db, avatar)
    background.add_task(process_avatar, avatar.id)
    return avatar


@router.patch("/{avatar_id}", response_model=AvatarOut)
@one_edit_at_a_time
async def update_avatar(
    avatar_id: str, body: AvatarUpdate, ctx: OrgMember, db: DB
) -> Avatar:
    """Change owner-editable settings.

    Framing lives here rather than on the embed snippet so that switching it
    reaches sites that already have the snippet pasted in — they re-read the
    avatar on every page load, so the change lands without anyone editing HTML.
    """
    avatar = await repo.require_in_org(db, ctx.org.id, avatar_id)
    await settings.update(db, avatar, body)
    return avatar


@router.post("/{avatar_id}/rig-reset", response_model=AvatarOut)
@one_edit_at_a_time
async def rig_reset(
    avatar_id: str, ctx: OrgMember, db: DB, background: BackgroundTasks
) -> Avatar:
    """Throw away hand-placed anchors and re-detect from the original photo.

    Saving a correction overwrites the rig, so without this a bad marking is
    unrecoverable. The source image is still stored, so re-running the normal
    pipeline reproduces the original detection exactly.
    """
    avatar = await repo.require_in_org(db, ctx.org.id, avatar_id)
    await lifecycle.redetect(db, avatar)
    background.add_task(process_avatar, avatar.id)
    return avatar


@router.get("/{avatar_id}", response_model=AvatarDetail)
async def get_avatar_detail(avatar_id: str, ctx: OrgMember, db: DB) -> AvatarDetail:
    from app.services.layers import draft_layer_urls
    from app.services.mouth import load as load_mouth
    from app.services.mouth import photo_urls

    avatar = await repo.require_in_org(db, ctx.org.id, avatar_id)
    storage = get_storage()
    # Before the model reads `mouth`: the detail is built here, not by the
    # route class.
    await sign_motion(avatar)
    detail = AvatarDetail.model_validate(avatar)
    detail.preparing_creation_id = await repo.preparing_creation(db, avatar)
    if avatar.image_key and await storage.exists(avatar.image_key):
        detail.image_url = await storage.presign_get(avatar.image_key)
        if avatar.kind == AvatarKind.model3d:
            detail.model_url = detail.image_url
    if avatar.rig_key:
        detail.rig_url = await storage.presign_get(avatar.rig_key)
    if avatar.thumbnail_key:
        detail.thumbnail_url = await storage.presign_get(avatar.thumbnail_key)
    detail.layer_urls = await draft_layer_urls(avatar, storage)
    detail.mouth_photo = await photo_urls(load_mouth(avatar.mouth_config), storage)
    scene_image = scene_service.image_key_of(scene_service.load(avatar))
    if scene_image and await storage.exists(scene_image):
        detail.scene_image_url = await storage.presign_get(scene_image)
    return detail


@router.delete("/{avatar_id}", status_code=204)
@one_edit_at_a_time
async def delete_avatar(avatar_id: str, ctx: OrgMember, db: DB):
    """Delete the avatar and every file it owns.

    By prefix, not by a list of keys: an avatar accumulates files no column
    points at any more — the pre-crop and pre-cut-out photos, undo history,
    layers, every published revision — and a hand-kept list is exactly what
    left the published copies of "deleted" avatars in storage.
    """
    avatar = await repo.require_in_org(db, ctx.org.id, avatar_id)
    await repo.delete(db, avatar)
