"""An avatar's way through processing, publishing and sharing: the state
changes the owner asks for, each refused where it does not apply.

Building the rig itself is a background task (services.rig.process_avatar)
the route schedules once these say it may run.
"""

from __future__ import annotations

from uuid import uuid4

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import Conflict409, Validation422
from app.models import Avatar, AvatarKind, AvatarStatus
from app.services.avatars.repo import preparing_creation
from app.services.publishing import confirmed, discard_draft, publish
from app.services.storage import get_storage


async def _require_source(avatar: Avatar) -> None:
    if not avatar.image_key or not await get_storage().exists(avatar.image_key):
        raise Validation422("Image has not been uploaded yet", code="image_missing")


async def check_uploaded(avatar: Avatar) -> None:
    """May the rig job run on the file the client says it uploaded? Not
    twice (409 already_processed), and not before it is there (422)."""
    if avatar.status not in (AvatarStatus.pending, AvatarStatus.failed):
        raise Conflict409("Avatar already processed", code="already_processed")
    await _require_source(avatar)


async def retry(db: AsyncSession, avatar: Avatar) -> None:
    """Put an avatar whose rig job stalled or failed back to pending, for
    the job to run again. Not for an avatar the creation wizard is still
    preparing (409 avatar_preparing): its finish job builds it, and there
    is nothing of it to retry yet. Committed."""
    if avatar.status == AvatarStatus.ready:
        raise Conflict409("Avatar is already ready", code="already_processed")
    if await preparing_creation(db, avatar) is not None:
        raise Conflict409(
            "This avatar is still being prepared from its photo; it opens when it is ready",
            code="avatar_preparing",
        )
    await _require_source(avatar)
    avatar.status = AvatarStatus.pending
    avatar.error = None
    await db.commit()


async def redetect(db: AsyncSession, avatar: Avatar) -> None:
    """Mark a photo avatar for detection from its photo again (the rig job
    then throws the hand-placed anchors away). Committed."""
    if avatar.kind != AvatarKind.photo or not avatar.image_key:
        raise Conflict409("Avatar cannot be re-detected", code="not_adjustable")
    avatar.status = AvatarStatus.processing
    await db.commit()


async def publish_draft(db: AsyncSession, avatar: Avatar) -> None:
    """Make the current draft what embedded sites and share links serve.

    Copies the draft's assets into an immutable snapshot rather than
    recording which keys were live — layer files are overwritten in place,
    so pointers would silently drift. See services/publishing. Committed.
    """
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


async def discard(db: AsyncSession, avatar: Avatar) -> None:
    """Throw the draft away and go back to what is published (409
    never_published when nothing ever was). Committed."""
    storage = get_storage()
    discarded = await discard_draft(avatar, storage)
    if discarded is None:
        raise Conflict409(
            "This avatar has never been published, so there is nothing to go back to",
            code="never_published",
        )
    await db.commit()
    # The discarded draft's mouth files, which nothing names any more.
    for key in discarded:
        await storage.delete(key)


async def share(db: AsyncSession, avatar: Avatar) -> None:
    """Give a ready avatar a public page, at /s/<token>.

    Idempotent: an avatar that already has a link keeps it, so pressing the
    button twice cannot invalidate a link someone has already sent out.
    """
    if avatar.status != AvatarStatus.ready:
        raise Conflict409("Only a ready avatar can be shared", code="not_ready")
    if not avatar.share_token:
        avatar.share_token = uuid4().hex
        await db.commit()


async def unshare(db: AsyncSession, avatar: Avatar) -> None:
    """Revoke the public page. Every copy of the link stops working at once."""
    avatar.share_token = None
    await db.commit()
