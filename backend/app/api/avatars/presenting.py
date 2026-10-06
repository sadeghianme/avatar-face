"""What the owner API says about an avatar: AvatarOut, and the detail page's
AvatarDetail, built from the row and the services that own each part.

The row is the model's business; how it is shown is the API's. The mouth
and the scene without their storage keys (services.mouth, services.scene),
whether the draft is ahead of what visitors are served (services.
publishing), the voice decoded, what an undo would reverse: all derived
here. They used to be properties on the model, which made app.models import
the services that import app.models.
"""

from __future__ import annotations

import json

from app.models import Avatar
from app.schemas.avatar import AvatarOut
from app.services import mouth as mouth_service
from app.services import publishing
from app.services import scene as scene_service
from app.services.avatars.fitting import rig_profile
from app.services.mouth_kit import public_kit
from app.services.storage import get_storage


def _json(raw: str | None, default):
    try:
        return json.loads(raw) if raw else default
    except ValueError:
        return default


def undo_label(avatar: Avatar) -> str | None:
    """What an undo would reverse, or None when there is nothing to undo.

    Exposed rather than the raw history so the button can name the change
    instead of saying "undo" and hoping the user remembers.
    """
    history = _json(avatar.edit_history, [])
    return history[-1].get("label") if history else None


def mouth_view(raw: str | None, motion_url: str | None = None) -> dict | None:
    """What the dashboard is told (never the storage keys). `teeth` says
    where the mouth photo came from, or why a new avatar has none
    (services.mouth_photo): {source: "ai" | "upload" | null, note}.
    `motion_url` is the draft motion's presigned URL, which the caller signs
    (`signed_view`); `kit` the summary of the
    mouth kit (services.mouth_kit.public_kit), or null."""
    config = mouth_service.load(raw)
    if config is None:
        return None
    teeth = config.get("teeth") or {}
    has_photo = bool(config.get("oral_image_key") and config.get("oral_rig_key"))
    return {
        "renderer": config["renderer"],
        "profile": config.get("profile") or {},
        "character": mouth_service.clean_character(config.get("character")),
        "has_oral_photo": has_photo,
        "teeth": {
            # An upload from before the record existed is still an upload.
            "source": teeth.get("source") or ("upload" if has_photo else None),
            "note": teeth.get("note"),
        },
        "motion_url": motion_url if config.get("motion_key") else None,
        "kit": public_kit(config.get("kit")),
    }


def avatar_out[S: AvatarOut](
    avatar: Avatar,
    motion_url: str | None = None,
    render_profile: str | None = None,
    schema: type[S] = AvatarOut,
) -> S:
    """The owner's view of `avatar`, as `schema` (AvatarOut or a subclass).

    `motion_url` is the draft motion's presigned URL and `render_profile`
    the draft rig's profile, both of which need storage (`signed_view`);
    without them the mouth has no motion_url and the profile is null, as on
    the avatar list.
    """
    published = publishing.config_of(avatar)
    return schema.model_validate(avatar).model_copy(
        update={
            "undo_label": undo_label(avatar),
            "voice": avatar.voice,
            "mouth": mouth_view(avatar.mouth_config, motion_url),
            "render_profile": render_profile,
            "scene": scene_service.public_view(avatar.scene_config),
            # Draft ahead of the snapshot: the dashboard's Publish bar.
            "unpublished": publishing.has_unpublished_changes(avatar),
            # Is a snapshot served? What embed and share gate on; not the
            # same as having a date (migration 020's snapshots have none).
            "published": published is not None,
            "published_at": (published or {}).get("published_at"),
        }
    )


async def signed_view[S: AvatarOut](avatar: Avatar, schema: type[S] = AvatarOut) -> S:
    """`avatar_out` with the draft motion signed, and the draft rig's
    profile for the lines that have a choice of look (cartoon, animal).

    Every route that answers with one avatar answers with this: a route that
    changed something else (a slider, a rename) must not answer with a mouth
    without its motion, or a dashboard merging that answer would preview the
    bundled motion while visitors get the avatar's own.
    """
    motion_url = await mouth_service.motion_url(
        mouth_service.load(avatar.mouth_config), get_storage()
    )
    profile = await rig_profile(avatar) if avatar.face_type in ("cartoon", "animal") else None
    return avatar_out(avatar, motion_url, profile, schema)
