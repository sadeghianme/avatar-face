"""The avatar's AI expression pictures as stored, published and shown:
`Avatar.expression_config` read, its files named, copied at Publish, put
back by Discard, and seen by the owner and by visitors.

A leaf, as services.mouth is for the mouth: publishing and the avatar's
views read it, and services.expression_kit (which makes the pictures, and
depends on publishing to complete a publish) builds on it.

`expression_config` is {ai, consent_id, consent_user_id, delivery, kit,
pending}: the owner's choice to have AI pictures, the third_party_ai
consent it relies on and whose it is, how a publish makes missing ones
(now or as a batch), the kit made (ExpressionKitRecord: per expression, its
picture or why not; the manifest; the picture of the avatar it was made
on), and a batch on its way. Visitors get the pictures while the choice is
on and some were made (`shows`); the kit stays when it is turned off, so
turning it back on needs no new call.
"""

from __future__ import annotations

import copy
import json
import logging
import re
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Any

from app.models.shapes import (
    AiEdited,
    ExpressionConfig,
    ExpressionKitRecord,
    ExpressionPicture,
    PublishedExpressions,
)
from app.services import disclosure
from app.services.storage import STORAGE_ERRORS, Storage

logger = logging.getLogger("liveface.expressions")

EXPRESSION_NAMES = ("happy", "surprised", "concerned", "thinking", "serious")
# The draft's own files, beside the avatar's other files: the pictures
# (expr-<stamp>-<name>.webp) and the manifest (expr-<stamp>.json; after a
# Discard expr-manifest-<stamp>.json). Published copies are under
# published/, never these names.
EXPR_FILE = re.compile(r"expr-[A-Za-z0-9-]+\.(?:webp|json)")

Copy = Callable[[str | None, str, str], Awaitable[str | None]]
Restore = Callable[[str | None, str], Awaitable[str | None]]


def now() -> str:
    return datetime.now(UTC).isoformat()


def picture_key(org_id: str, avatar_id: str, stamp: str, name: str) -> str:
    return f"orgs/{org_id}/avatars/{avatar_id}/expr-{stamp}-{name}.webp"


def manifest_key(org_id: str, avatar_id: str, stamp: str) -> str:
    return f"orgs/{org_id}/avatars/{avatar_id}/expr-{stamp}.json"


def load(avatar: Any) -> ExpressionConfig | None:
    """The avatar's expression_config, a copy (JSON columns are replaced,
    never mutated), or None."""
    config = getattr(avatar, "expression_config", None)
    if not isinstance(config, dict):
        return None
    loaded: ExpressionConfig = copy.deepcopy(config)  # type: ignore[assignment]  # the column's shape
    return loaded


def picture_of(avatar: Any, image_size) -> ExpressionPicture:
    """The picture a kit is made on: the avatar's, at its size."""
    return {"image_key": avatar.image_key, "image_size": [int(v) for v in image_size]}


def made_count(kit: ExpressionKitRecord | None) -> int:
    return int(kit.get("made", 0)) if kit else 0


def wants_kit(config: ExpressionConfig | None) -> bool:
    """Has the owner asked for AI expressions, with none made yet and none
    on its way? (A kit follows every later edit of the face, a crop, new
    marks, a cut-out, so a kit once made is the avatar's for good; one that
    could not follow is dropped, and is wanted again.)"""
    if not config or not config.get("ai") or config.get("pending"):
        return False
    return config.get("kit") is None


def file_keys(kit: ExpressionKitRecord | None) -> set[str]:
    """Every draft file a kit names: its manifest and its pictures."""
    if not kit:
        return set()
    keys = {image for shot in kit["shots"].values() if (image := shot.get("image_key"))}
    if manifest := kit.get("manifest_key"):
        keys.add(manifest)
    return keys


def keys(config: ExpressionConfig | None) -> set[str]:
    """The draft files the config names."""
    return file_keys((config or {}).get("kit"))


def shows(config: ExpressionConfig | None) -> bool:
    """Do visitors get the AI pictures: chosen, and some made?"""
    kit = (config or {}).get("kit")
    return bool(config and config.get("ai") and kit and kit.get("manifest_key") and kit["made"])


# --- Views ---------------------------------------------------------------------------


def public_kit(kit: ExpressionKitRecord | None) -> dict | None:
    """The kit as the owner's panel shows it: per expression, made or why
    not; never the storage keys."""
    if not kit:
        return None
    return {
        "id": kit["id"],
        "made_at": kit["made_at"],
        "source": kit["source"],
        "model": kit.get("model"),
        "made": kit["made"],
        "calls": kit["calls"],
        "shots": {
            name: {
                "status": shot["status"],
                "outcome": shot["outcome"],
                "reason": shot.get("reason"),
                "smile": bool(shot.get("smile")),
            }
            for name, shot in kit["shots"].items()
            if name in EXPRESSION_NAMES
        },
    }


async def owner_view(avatar: Any, storage: Storage, job: dict | None = None) -> dict:
    """The draft's expressions as the dashboard shows them: the choice, the
    kit, presigned pictures and manifest for the preview, a batch on its
    way, and the job."""
    config = load(avatar) or {"ai": False}
    kit = config.get("kit")
    pictures: dict[str, str] = {}
    manifest_url = None
    if kit:
        for name, shot in kit["shots"].items():
            if image := shot.get("image_key"):
                pictures[name] = await storage.presign_get(image)
        if manifest := kit.get("manifest_key"):
            manifest_url = await storage.presign_get(manifest)
    return {
        "ai": bool(config.get("ai")),
        "delivery": config.get("delivery") or "now",
        "kit": public_kit(kit),
        "pending": bool(config.get("pending")),
        "manifest_url": manifest_url,
        "picture_urls": pictures,
        "job": job,
    }


async def visitor_view(published: PublishedExpressions | None, storage: Storage) -> dict | None:
    """What a visitor's engine needs of the published pictures: the manifest
    and each picture, presigned (fetched cross-origin, as the mouth's)."""
    if not published:
        return None
    return {
        "manifest_url": await storage.presign_get(published["manifest_key"]),
        "image_urls": {
            name: await storage.presign_get(key) for name, key in published["image_keys"].items()
        },
    }


# --- Publishing ----------------------------------------------------------------------


async def publish_expressions(avatar: Any, copy_file: Copy) -> PublishedExpressions | None:
    """The snapshot's `expressions` for the draft's: the manifest and each
    picture copied by `copy_file` (publishing.copier), with the kit's record
    (owner-facing, for Discard); None while the owner has not chosen them,
    none were made, or the manifest is gone."""
    config = load(avatar)
    kit = (config or {}).get("kit")
    if not shows(config) or not kit:
        return None
    manifest = await copy_file(kit.get("manifest_key"), "expressions", "json")
    if manifest is None:
        return None
    images: dict[str, str] = {}
    for name, shot in kit["shots"].items():
        if image := shot.get("image_key"):
            copied = await copy_file(image, f"expr-{name}", "webp")
            if copied:
                images[name] = copied
    if not images:
        return None
    return {"manifest_key": manifest, "image_keys": images, "kit": kit}


def published_disclosure(
    ai_edited: AiEdited | None, published: PublishedExpressions | None
) -> AiEdited | None:
    """The disclosure as published: the expressions entry only while the
    snapshot shows AI pictures (the draft keeps it with the pictures, so
    turning them back on brings both back)."""
    if published:
        model = published["kit"].get("model")
        return disclosure.with_ai_expressions(ai_edited, model, len(published["image_keys"]))
    return disclosure.without_ai_expressions(ai_edited)


async def restore(
    published: PublishedExpressions | None,
    draft: ExpressionConfig | None,
    restore_file: Restore,
) -> ExpressionConfig | None:
    """The draft's expressions after a Discard: the published kit, its files
    restored into fresh draft keys (`restore_file(source, name)`), and the
    choice as published (on when it shipped pictures). The consent and the
    delivery stay as the draft had them: they are the owner's settings,
    not the face's."""
    restored: ExpressionConfig = {"ai": published is not None, "kit": None, "pending": None}
    for keep in ("consent_id", "consent_user_id", "delivery"):
        if draft and keep in draft:
            restored[keep] = draft[keep]  # type: ignore[literal-required]
    if published is None:
        return restored if draft else None
    kit: ExpressionKitRecord = json.loads(json.dumps(published["kit"]))
    manifest = await restore_file(published["manifest_key"], "expr-manifest")
    if manifest is None:
        return restored
    kit["manifest_key"] = manifest
    for name, shot in kit["shots"].items():
        source = published["image_keys"].get(name)
        image = await restore_file(source, f"expr-{name}") if source else None
        if image:
            shot["image_key"] = image
        else:
            shot.pop("image_key", None)
    restored["kit"] = kit
    return restored


async def sweep_files(root: str, storage: Storage, config: ExpressionConfig | None) -> None:
    """Delete the draft's expression files under the avatar's `root` that
    the draft no longer names (as publishing sweeps the mouth's: a process
    that died between a save and its deletes leaves them behind for good)."""
    named = keys(config)
    try:
        names = await storage.list_names(root)
    except STORAGE_ERRORS:
        logger.exception("could not list %s", root)
        return
    for name in names:
        if EXPR_FILE.fullmatch(name) and f"{root}{name}" not in named:
            try:
                await storage.delete(f"{root}{name}")
            except STORAGE_ERRORS:
                logger.exception("could not delete %s%s", root, name)
