"""The owner's settings on an avatar's draft: its name, framing and scene,
voice, mouth renderer and character mouth, its line (face type), and the
picture shown behind a cut-out.

Framing lives here rather than on the embed snippet so that switching it
reaches sites that already have the snippet pasted in — they re-read the
avatar on every page load, so the change lands without anyone editing HTML
(once published).
"""

from __future__ import annotations

import json
from typing import cast

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import Conflict409, Validation422
from app.models import Avatar, AvatarKind
from app.models.shapes import ProfileValues
from app.schemas.avatar import AvatarUpdate
from app.services import scene as scene_service
from app.services.avatars.fitting import reprofile_visemes
from app.services.mouth import character_allowed, clean_character, renderer_allowed
from app.services.mouth import load as load_mouth
from app.services.publishing import mark_dirty
from app.services.storage import get_storage


async def update(db: AsyncSession, avatar: Avatar, body: AvatarUpdate) -> None:
    """Apply the owner-editable settings `body` names (None: unchanged).
    Committed."""
    face_type = body.face_type or avatar.face_type
    if body.mouth is not None and not renderer_allowed(body.mouth.renderer, face_type):
        raise Validation422(
            "The photographic mouth draws human teeth, so it is only for human faces",
            code="mouth_not_for_face_type",
        )
    if body.character is not None and not character_allowed(face_type):
        raise Validation422(
            "The character mouth is for animations and animals",
            code="character_not_for_face_type",
        )
    if body.name is not None:
        avatar.name = body.name
    if body.framing is not None:
        avatar.framing = body.framing
        # A client that still sets the framing moves the scene's zoom with
        # it, so the two never disagree about what visitors see.
        current_scene = scene_service.load(avatar)
        if current_scene is not None:
            avatar.scene_config = scene_service.with_zoom(
                current_scene, 0.0 if body.framing == "full" else 1.0
            )
    if body.scene is not None:
        current_scene = scene_service.effective(avatar)
        try:
            scene = scene_service.clean(
                body.scene.model_dump(), scene_service.image_key_of(current_scene)
            )
        except ValueError as exc:
            code = "scene_image_missing" if "uploaded" in str(exc) else "scene_invalid"
            raise Validation422(str(exc), code=code) from exc
        avatar.scene_config = scene
        # Kept in step for clients that read only the framing.
        avatar.framing = scene_service.framing_of(scene)
    if body.voice is not None:
        avatar.voice_config = json.dumps(body.voice.model_dump())
    if body.mouth is not None:
        # Renderer and fit change; the mouth photo is managed by its own
        # endpoints and carried over untouched.
        profile = cast(ProfileValues, body.mouth.profile.model_dump())
        current = load_mouth(avatar.mouth_config)
        if current is None:
            current = {"renderer": body.mouth.renderer, "profile": profile}
        else:
            current["renderer"], current["profile"] = body.mouth.renderer, profile
        avatar.mouth_config = json.dumps(current)
    if body.character is not None:
        # How the character mouth is set. The look itself (the new mouth or
        # the line's classic one) is the draft rig's render profile, moved
        # below; a rig fitted before the character mouth keeps its look until
        # its owner chooses it here or fits the face again.
        current = load_mouth(avatar.mouth_config) or {"renderer": "classic", "profile": {}}
        current["character"] = clean_character(body.character.model_dump())
        avatar.mouth_config = json.dumps(current)
    if (
        body.framing is not None
        or body.scene is not None
        or body.face_type is not None
        or body.voice is not None
        or body.mouth is not None
        or body.character is not None
    ):
        mark_dirty(avatar)
    if body.character is not None and not (
        body.face_type is not None and body.face_type != avatar.face_type
    ):
        await reprofile_visemes(avatar, visemes=False)
    if body.face_type is not None and body.face_type != avatar.face_type:
        avatar.face_type = body.face_type
        # Only the viseme table changes. Re-running detection would throw
        # away a hand-marked rig for a setting that has nothing to do with
        # where the landmarks are.
        await reprofile_visemes(avatar)
        # A face that is no longer human cannot keep human teeth; the fit
        # and any teeth photo stay, so switching back restores nothing lost
        # but the renderer choice.
        mouth = load_mouth(avatar.mouth_config)
        if mouth and not renderer_allowed(mouth["renderer"], avatar.face_type):
            mouth["renderer"] = "classic"
            avatar.mouth_config = json.dumps(mouth)
    await db.commit()


def require_scene(avatar: Avatar) -> None:
    """Only a photo avatar has a scene (409 not_a_photo); checked before the
    upload is read."""
    if avatar.kind != AvatarKind.photo:
        raise Conflict409("Only a photo avatar has a scene", code="not_a_photo")


async def set_scene_image(db: AsyncSession, avatar: Avatar, image: bytes) -> None:
    """Show `image` (checked by require_scene, prepared by
    scene.prepare_image) behind the avatar, under a fresh key. Committed;
    the picture it replaces is deleted after (the published snapshot keeps
    its own copy)."""
    storage = get_storage()
    previous = await scene_service.store_image(avatar, storage, image)
    avatar.framing = scene_service.framing_of(scene_service.effective(avatar))
    mark_dirty(avatar)
    await db.commit()
    for key in previous:
        await storage.delete(key)


async def remove_scene_image(db: AsyncSession, avatar: Avatar) -> None:
    """Nothing behind the avatar again (nothing to do without a picture).
    Committed; the published snapshot keeps its own copy until the next
    Publish."""
    if not scene_service.image_key_of(scene_service.load(avatar)):
        return
    storage = get_storage()
    previous = scene_service.without_image(avatar)
    mark_dirty(avatar)
    await db.commit()
    for key in previous:
        await storage.delete(key)
