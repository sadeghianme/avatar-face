"""The owner's edits to an avatar's photographic mouth: their own teeth
photo put in or taken out, and the mouth kit (services.mouth_kit) started
from the avatar's picture. Draft edits: visitors get the new mouth, and the
disclosure of what AI made, when the owner publishes.
"""

from __future__ import annotations

import json

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import Conflict409, Validation422
from app.models import Avatar, AvatarKind, AvatarStatus, Organization
from app.services import mouth_kit
from app.services.publishing import mark_dirty
from app.services.storage import get_storage


def require_teeth_photo_allowed(avatar: Avatar) -> None:
    """A ready photo avatar on a line that may use the photographic mouth
    (409 not_a_photo, 422 mouth_not_for_face_type)."""
    from app.services.mouth import renderer_allowed

    if avatar.kind != AvatarKind.photo or avatar.status != AvatarStatus.ready:
        raise Conflict409("Only a ready photo avatar can take a mouth photo", code="not_a_photo")
    # The photo only feeds the photographic mouth, which this face may not use.
    if not renderer_allowed("continuous", avatar.face_type):
        raise Validation422(
            "The photographic mouth draws human teeth, so it is only for human faces",
            code="mouth_not_for_face_type",
        )


async def set_mouth_photo(db: AsyncSession, avatar: Avatar, photo: bytes, rig: dict) -> None:
    """The owner's own teeth photo (prepared and checked by
    mouth_photo.prepare_mouth_photo) in place of the standard teeth, or of
    teeth the AI made. Committed; the files it replaces are deleted after."""
    from app.services import mouth_photo

    storage = get_storage()
    previous = await mouth_photo.store(
        avatar, storage, photo, rig, mouth_photo.upload_teeth_record()
    )
    # The owner's own teeth replace any the AI made: the mouth is no longer
    # AI-made, and the disclosure stops saying so (from the next Publish).
    avatar.ai_edited = mouth_photo.without_ai_teeth(avatar.ai_edited)
    mouth_kit.teeth_changed(avatar, mouth_kit.OWNER_PHOTO)
    mark_dirty(avatar)
    await db.commit()
    for key in previous:
        await storage.delete(key)


async def remove_mouth_photo(db: AsyncSession, avatar: Avatar) -> None:
    """Back to the standard teeth (the Reference's own teeth photo, which
    every mouth without a photo of its own draws); nothing to do without a
    photo. Committed; the published snapshot keeps its own copy."""
    from app.services.mouth import load as load_mouth
    from app.services.mouth_photo import without_ai_teeth

    config = load_mouth(avatar.mouth_config)
    if not config or not config.get("oral_image_key"):
        return
    storage = get_storage()
    for name in ("oral_image_key", "oral_rig_key"):
        key = config.pop(name, None)
        if key:
            await storage.delete(key)
    config.pop("teeth", None)
    avatar.mouth_config = json.dumps(config)
    # Teeth the AI made are gone, and so is their disclosure (next Publish).
    avatar.ai_edited = without_ai_teeth(avatar.ai_edited)
    mouth_kit.teeth_changed(avatar, mouth_kit.TEETH_REMOVED)
    mark_dirty(avatar)
    await db.commit()


async def start_mouth_kit(
    db: AsyncSession, avatar: Avatar, org: Organization, user_id: str, consent_id: str | None
) -> dict:
    """Start the avatar's mouth-kit job (mouth_kit.start) on `user_id`'s
    third_party_ai consent; the job, as JobOut takes it.

    Refused like the teeth photo (require_teeth_photo_allowed), without the
    consent (403 consent_required) or with the organization's switch off
    (403 third_party_ai_disabled), with no image model configured (409
    imagegen_unavailable), past the monthly image limit (429), and when the
    avatar's picture is gone (409 source_gone).
    """
    from app.services import consent, imagegen
    from app.services.ai_models import PROVIDER
    from app.services.usage import check_image_limit

    require_teeth_photo_allowed(avatar)
    agreed = await consent.require(
        db, consent_id, org, user_id, consent.THIRD_PARTY_AI, PROVIDER
    )
    if not imagegen.configured():
        raise Conflict409("AI editing is not configured on this server", code="imagegen_unavailable")
    await check_image_limit(db, org.id)
    storage = get_storage()
    if (
        not avatar.image_key
        or not avatar.rig_key
        or not await storage.exists(avatar.image_key)
    ):
        raise Conflict409("The avatar's picture is gone", code="source_gone")
    return mouth_kit.start(avatar, agreed.id)
