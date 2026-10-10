"""A kit stored on the avatar's draft, the owner's choice, and the kit
following the avatar's later edits. None of these sends anything; the
caller commits (and marks the draft dirty) and deletes the keys returned
after the commit."""

from __future__ import annotations

import json
import logging
from uuid import uuid4

from app.models import Avatar
from app.models.shapes import ExpressionConfig, ExpressionPicture
from app.services import disclosure
from app.services.expression_kit.build import ExpressionsResult
from app.services.expression_kit.constants import IMAGE_TYPE, MANIFEST_TYPE
from app.services.expression_kit.manifest import rebase
from app.services.expression_kit.records import Source, kit_record
from app.services.expressions import (
    file_keys,
    load,
    made_count,
    manifest_key,
    now,
    picture_key,
)
from app.services.jobs import run_cpu
from app.services.storage import Storage

logger = logging.getLogger("liveface.expression_kit")


def manifest_bytes(manifest: dict) -> bytes:
    return json.dumps(manifest, separators=(",", ":")).encode()


def disclose(avatar: Avatar, config: ExpressionConfig) -> None:
    """The draft's disclosure, in step with its pictures: disclosed while
    the owner has chosen them and some were made."""
    kit = config.get("kit")
    if config.get("ai") and made_count(kit):
        assert kit is not None  # made_count is 0 without one
        avatar.ai_edited = disclosure.with_ai_expressions(
            avatar.ai_edited, kit.get("model"), made_count(kit)
        )
    else:
        avatar.ai_edited = disclosure.without_ai_expressions(avatar.ai_edited)


async def store(
    avatar: Avatar,
    storage: Storage,
    result: ExpressionsResult,
    *,
    source: Source,
    picture: ExpressionPicture,
) -> list[str]:
    """Make `result` the draft's kit: its pictures and manifest written
    first (a failure leaves the draft as it was), then the record, the
    choice turned on (the owner asked for them, or published with them on),
    and the disclosure. A kit that made nothing is recorded too (the panel
    says why each failed) and names no files. Returns the previous kit's
    keys."""
    config = load(avatar) or {"ai": True}
    stamp = uuid4().hex[:8]
    image_keys: dict[str, str] = {}
    for name, made in result.made.items():
        key = picture_key(avatar.org_id, avatar.id, stamp, name)
        await storage.put_bytes(key, made.picture, IMAGE_TYPE)
        image_keys[name] = key
    new_manifest = None
    if result.manifest is not None and image_keys:
        new_manifest = manifest_key(avatar.org_id, avatar.id, stamp)
        await storage.put_bytes(new_manifest, manifest_bytes(result.manifest), MANIFEST_TYPE)
    previous = sorted(file_keys(config.get("kit")))
    config["kit"] = kit_record(
        result,
        source=source,
        picture=picture,
        image_keys=image_keys,
        manifest_key=new_manifest,
    )
    config["ai"] = True
    config["pending"] = None
    avatar.expression_config = config
    disclose(avatar, config)
    return previous


def choose(avatar: Avatar, ai: bool, consent_id: str | None = None) -> bool:
    """The owner's choice: AI pictures for the expressions or not, on
    `consent_id` (the third_party_ai consent they rely on, checked by the
    caller) when turned on. The pictures made stay either way (turning it
    back on needs no new call); visitors get them only while it is on.
    Returns whether visitors would see a change."""
    config = load(avatar) or {"ai": False}
    before = bool(config.get("ai"))
    config["ai"] = ai
    if ai and consent_id:
        config["consent_id"] = consent_id
    avatar.expression_config = config
    disclose(avatar, config)
    return before != ai and made_count(config.get("kit")) > 0


def remove(avatar: Avatar) -> list[str]:
    """The pictures removed from the draft, and the choice turned off (or
    the next publish would make them again). Returns the keys to delete."""
    config = load(avatar)
    if not config:
        return []
    previous = sorted(file_keys(config.get("kit")))
    config["kit"] = None
    config["ai"] = False
    config["pending"] = None
    avatar.expression_config = config
    disclose(avatar, config)
    return previous


def drop(avatar: Avatar) -> list[str]:
    """The kit can no longer play on its face (its manifest could not
    follow the points): its files go, the choice stays (the next publish
    makes them again for the picture as it is). Returns keys to delete."""
    config = load(avatar)
    if not config or not config.get("kit"):
        return []
    previous = sorted(file_keys(config.get("kit")))
    config["kit"] = None
    avatar.expression_config = config
    disclose(avatar, config)
    return previous


async def follow_points(avatar: Avatar, storage: Storage, points, image_size=None) -> list[str]:
    """The kit moved onto the face's points as they are now, with no AI
    call: points re-confirmed on the same picture, or the picture moved
    under the same face (a crop, its reset; `image_size` is then the new
    picture's, and the kit follows that picture). A kit that cannot follow
    is dropped. Returns the keys replaced, to delete after the commit."""
    config = load(avatar)
    kit = (config or {}).get("kit")
    if not config or not kit or not kit.get("manifest_key"):
        return []
    old_key = kit["manifest_key"]
    assert old_key is not None  # checked just above
    try:
        manifest = json.loads(await storage.get_bytes(old_key))
        rebased = await run_cpu(rebase, manifest, points, image_size)
    except Exception:
        # Broad on purpose: storage and the manifest fail in many types; a
        # kit that cannot follow is dropped, not left on the old points.
        logger.exception("the expressions of avatar %s could not follow its points", avatar.id)
        return drop(avatar)
    if rebased == manifest:
        return []
    new_key = manifest_key(avatar.org_id, avatar.id, uuid4().hex[:8])
    await storage.put_bytes(new_key, manifest_bytes(rebased), MANIFEST_TYPE)
    kit = dict(kit)
    kit["manifest_key"] = new_key
    kit["rebased_at"] = now()
    kit["picture"] = {
        "image_key": avatar.image_key,
        "image_size": list(rebased["image_size"]),
    }
    config["kit"] = kit  # type: ignore[typeddict-item]  # a copy of the record
    avatar.expression_config = config
    return [old_key]


async def follow_rig(
    avatar: Avatar, storage: Storage, before: dict | None, after: dict | None
) -> list[str]:
    """After an edit put another rig in place (undo), as the mouth kit's
    follow_rig: another size is the same face on a picture cropped or
    uncropped, other points on the same size the same picture re-marked."""
    if not before or not after:
        return []
    if list(before.get("image_size") or []) != list(after.get("image_size") or []):
        return await follow_points(avatar, storage, after["points"], after["image_size"])
    if before.get("points") != after.get("points"):
        return await follow_points(avatar, storage, after["points"])
    return []
