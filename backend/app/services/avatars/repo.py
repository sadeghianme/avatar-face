"""Avatar rows: finding them, making them, deleting them.

Every lookup on behalf of a member filters on the org from the path as well
as the id, so another org's avatar id is simply not found; the public
lookups (an embed key's org, a share token) resolve to their own avatar
only.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import NotFound404
from app.models import Avatar, AvatarStatus, Creation, CreationStatus
from app.services.storage import get_storage


async def get_in_org(db: AsyncSession, org_id: str, avatar_id: str) -> Avatar | None:
    return (
        await db.execute(select(Avatar).where(Avatar.id == avatar_id, Avatar.org_id == org_id))
    ).scalar_one_or_none()


async def require_in_org(db: AsyncSession, org_id: str, avatar_id: str) -> Avatar:
    """The org's avatar, or 404 avatar_not_found."""
    avatar = await get_in_org(db, org_id, avatar_id)
    if avatar is None:
        raise NotFound404("Avatar not found", code="avatar_not_found")
    return avatar


async def list_in_org(db: AsyncSession, org_id: str) -> list[Avatar]:
    """Newest first."""
    return list(
        (
            await db.execute(
                select(Avatar).where(Avatar.org_id == org_id).order_by(Avatar.created_at.desc())
            )
        )
        .scalars()
        .all()
    )


async def by_share_token(db: AsyncSession, token: str) -> Avatar | None:
    return (
        await db.execute(select(Avatar).where(Avatar.share_token == token))
    ).scalar_one_or_none()


def source_key(org_id: str, avatar_id: str, ext: str) -> str:
    return f"orgs/{org_id}/avatars/{avatar_id}/source.{ext}"


async def create_with_source(
    db: AsyncSession, ext: str, data: bytes | None = None, **fields: Any
) -> tuple[Avatar, str]:
    """A new avatar row made of `fields`, committed, and the key of its
    source file (source.<ext> under the avatar). With `data`, that file is
    stored first, as `content_type`; without, the client uploads it."""
    avatar = Avatar(**fields)
    db.add(avatar)
    await db.flush()
    image_key = source_key(avatar.org_id, avatar.id, ext)
    avatar.image_key = image_key
    if data is not None:
        await get_storage().put_bytes(image_key, data, avatar.content_type)
    await db.commit()
    return avatar, image_key


async def preparing_creation(db: AsyncSession, avatar: Avatar) -> str | None:
    """The creation whose finish is building `avatar` (the wizard's step 5,
    "Preparing your avatar"), while it does; else None. Its row exists from
    the moment Finish is pressed, listed as processing, with no picture
    until the finish commits."""
    if avatar.status == AvatarStatus.ready:
        return None
    return (
        await db.execute(
            select(Creation.id).where(
                Creation.org_id == avatar.org_id,
                Creation.avatar_id == avatar.id,
                Creation.status == CreationStatus.finishing,
            )
        )
    ).scalar_one_or_none()


async def delete(db: AsyncSession, avatar: Avatar) -> None:
    """Delete the avatar and every file it owns.

    By prefix, not by a list of keys: an avatar accumulates files no column
    points at any more — the pre-crop and pre-cut-out photos, undo history,
    layers, every published revision — and a hand-kept list is exactly what
    left the published copies of "deleted" avatars in storage.
    """
    await get_storage().delete_prefix(f"orgs/{avatar.org_id}/avatars/{avatar.id}/")
    await db.delete(avatar)
    await db.commit()
