"""The avatar's mouth settings: which renderer, how it is fitted, the
optional photo of the person's own teeth, and the avatar's own motion.

Stored as one JSON blob on the avatar (`mouth_config`). The storage keys in
it are internal; `public_view` is what the owner's dashboard is told, and
publishing's `_mouth_view` what a visitor's engine gets.

The keys, all fresh per file (the published snapshot may still point at
copies of the old ones, and browsers cache presigned URLs by path):
`oral_image_key` and `oral_rig_key` (the teeth photo and its landmarks,
services.mouth_photo), and `motion_key` (the performance manifest made
from the avatar's own photo, services.mouth_kit). Records beside them:
`teeth` (where the teeth came from, or why there are none) and `kit` (what
the mouth kit is made of), both owner-facing only.
"""

from __future__ import annotations

import json

RENDERERS = ("classic", "continuous")

# The photographic ("continuous") mouth paints human enamel and lips. On an
# animal or a drawn character that is a person's teeth in the wrong face.
CONTINUOUS_FACE_TYPES = ("human",)


def renderer_allowed(renderer: str, face_type: str) -> bool:
    return renderer != "continuous" or face_type in CONTINUOUS_FACE_TYPES


def load(raw: str | None) -> dict | None:
    try:
        value = json.loads(raw) if raw else None
    except ValueError:
        return None
    return value if isinstance(value, dict) and value.get("renderer") in RENDERERS else None


def public_view(raw: str | None, motion_url: str | None = None) -> dict | None:
    """What the dashboard is told (never the storage keys). `teeth` says
    where the mouth photo came from, or why a new avatar has none
    (services.mouth_photo): {source: "ai" | "upload" | null, note}.
    `motion_url` is the draft motion's presigned URL, which the caller signs
    (`motion_url` below: this is synchronous); `kit` the summary of the
    mouth kit (services.mouth_kit.public_kit), or null."""
    from app.services.mouth_kit import public_kit

    config = load(raw)
    if config is None:
        return None
    teeth = config.get("teeth") or {}
    has_photo = bool(config.get("oral_image_key") and config.get("oral_rig_key"))
    return {
        "renderer": config["renderer"],
        "profile": config.get("profile") or {},
        "has_oral_photo": has_photo,
        "teeth": {
            # An upload from before the record existed is still an upload.
            "source": teeth.get("source") or ("upload" if has_photo else None),
            "note": teeth.get("note"),
        },
        "motion_url": motion_url if config.get("motion_key") else None,
        "kit": public_kit(config.get("kit")),
    }


def oral_keys(org_id: str, avatar_id: str, stamp: str) -> tuple[str, str]:
    # WebP (services.mouth_photo.MOUTH_PHOTO_TYPE). Photos stored as PNG
    # before keep their keys; everything downstream reads the extension.
    base = f"orgs/{org_id}/avatars/{avatar_id}/mouth-{stamp}"
    return f"{base}.webp", f"{base}.json"


def motion_key(org_id: str, avatar_id: str, stamp: str) -> str:
    """The avatar's own motion manifest, beside its teeth photo."""
    return f"orgs/{org_id}/avatars/{avatar_id}/mouth-motion-{stamp}.json"


async def photo_urls(config: dict | None, storage) -> dict | None:
    """Presigned URLs for the mouth photo and its rig, if both still exist."""
    if not config:
        return None
    image_key, rig_key = config.get("oral_image_key"), config.get("oral_rig_key")
    if not image_key or not rig_key:
        return None
    if not (await storage.exists(image_key) and await storage.exists(rig_key)):
        return None
    return {
        "image_url": await storage.presign_get(image_key),
        "rig_url": await storage.presign_get(rig_key),
    }


async def motion_url(config: dict | None, storage) -> str | None:
    """The presigned URL of the motion manifest, if it still exists. None
    means the engine plays the bundled Reference motion, as it always did."""
    key = (config or {}).get("motion_key")
    if not key or not await storage.exists(key):
        return None
    return await storage.presign_get(key)
