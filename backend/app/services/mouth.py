"""The avatar's mouth settings: which renderer, how it is fitted, and the
optional photo of the person's own teeth.

Stored as one JSON blob on the avatar (`mouth_config`). The storage keys in
it are internal; `public_view` is what leaves the server.
"""

from __future__ import annotations

import json

RENDERERS = ("classic", "continuous")


def load(raw: str | None) -> dict | None:
    try:
        value = json.loads(raw) if raw else None
    except ValueError:
        return None
    return value if isinstance(value, dict) and value.get("renderer") in RENDERERS else None


def public_view(raw: str | None) -> dict | None:
    config = load(raw)
    if config is None:
        return None
    return {
        "renderer": config["renderer"],
        "profile": config.get("profile") or {},
        "has_oral_photo": bool(config.get("oral_image_key") and config.get("oral_rig_key")),
    }


def oral_keys(org_id: str, avatar_id: str, stamp: str) -> tuple[str, str]:
    base = f"orgs/{org_id}/avatars/{avatar_id}/mouth-{stamp}"
    return f"{base}.png", f"{base}.json"


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
