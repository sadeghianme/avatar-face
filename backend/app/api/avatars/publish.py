"""What visitors see: publishing the draft, discarding it, the share link."""

from __future__ import annotations

from app.api.avatars.routing import one_edit_at_a_time, router
from app.api.deps import DB, OrgMember
from app.models import Avatar
from app.schemas.avatar import AvatarOut
from app.services.avatars import lifecycle, repo


@router.post("/{avatar_id}/publish", response_model=AvatarOut)
@one_edit_at_a_time
async def publish_avatar(avatar_id: str, ctx: OrgMember, db: DB) -> Avatar:
    """Make the current draft what embedded sites and share links serve.

    Copies the draft's assets into an immutable snapshot rather than
    recording which keys were live — layer files are overwritten in place,
    so pointers would silently drift. See services/publishing.
    """
    avatar = await repo.require_in_org(db, ctx.org.id, avatar_id)
    await lifecycle.publish_draft(db, avatar)
    return avatar


@router.post("/{avatar_id}/discard-draft", response_model=AvatarOut)
@one_edit_at_a_time
async def discard_avatar_draft(avatar_id: str, ctx: OrgMember, db: DB) -> Avatar:
    """Throw the draft away and go back to what is published."""
    avatar = await repo.require_in_org(db, ctx.org.id, avatar_id)
    await lifecycle.discard(db, avatar)
    return avatar


@router.post("/{avatar_id}/share", response_model=AvatarOut)
async def enable_share(avatar_id: str, ctx: OrgMember, db: DB) -> Avatar:
    """Publish a public page for this avatar, at /s/<token>.

    Idempotent: an avatar that already has a link keeps it, so pressing the
    button twice cannot invalidate a link someone has already sent out.
    """
    avatar = await repo.require_in_org(db, ctx.org.id, avatar_id)
    await lifecycle.share(db, avatar)
    return avatar


@router.delete("/{avatar_id}/share", response_model=AvatarOut)
async def disable_share(avatar_id: str, ctx: OrgMember, db: DB) -> Avatar:
    """Revoke the public page. Every copy of the link stops working at once."""
    avatar = await repo.require_in_org(db, ctx.org.id, avatar_id)
    await lifecycle.unshare(db, avatar)
    return avatar
