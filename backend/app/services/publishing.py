"""Draft and published state for an avatar.

Until this existed, every edit was live the instant it was made: cropping a
photo changed what visitors to a customer's site saw before the owner had
looked at the result. Editing and shipping were the same action, which is
fine for a toy and wrong for something embedded on other people's pages.

Now the dashboard shows the DRAFT — the avatar as currently edited — and the
embed serves the PUBLISHED snapshot. Nothing an owner does reaches a
visitor until they press Publish.

Two decisions carry this module.

**Published assets are copies, not pointers.** The obvious design is to
record which storage keys were live at publish time. It does not work: layer
files are written to a fixed path and overwritten in place, so rebuilding
layers after a crop would silently change what published clients see while
the recorded keys stayed identical. Publishing therefore copies the assets
to `published/r<revision>/`, which nothing else writes to. That also makes
the embed independent of the undo stack, the candidate sweeper, and every
future edit.

**Difference is tracked by a counter, not by comparing keys.** Marking the
face rewrites rig.json in place; the key is unchanged and the content is
not. A monotonic `draft_revision`, bumped by every mutation that a visitor
could notice, is the only honest answer to "is there anything unpublished".
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone

logger = logging.getLogger("liveface.publishing")

# How many published revisions to keep. The current one is what clients are
# served; the previous one covers presigned URLs already handed out and
# in-flight page loads. Older ones are dead weight.
KEEP_REVISIONS = 2

LAYER_NAMES = ("background", "body", "head")


def _ext(key: str, default: str) -> str:
    tail = key.rsplit("/", 1)[-1]
    return tail.rsplit(".", 1)[-1] if "." in tail else default


# Appended to the quality note of a first build that did not publish itself
# (see rig.process_avatar), and taken off again when the owner publishes.
CONFIRM_BEFORE_PUBLISH = (
    "It is not live yet: check the points with “Mark the face”, then press Publish."
)


def awaiting_confirmation(note: str | None) -> str:
    return f"{note.rstrip('. ')}. {CONFIRM_BEFORE_PUBLISH}" if note else CONFIRM_BEFORE_PUBLISH


def confirmed(note: str | None) -> str | None:
    """The quality note once the owner has published: the reason stays, the
    instruction to publish goes."""
    if not note or not note.endswith(CONFIRM_BEFORE_PUBLISH):
        return note
    return note[: -len(CONFIRM_BEFORE_PUBLISH)].strip() or None


def published_prefix(org_id: str, avatar_id: str, revision: int) -> str:
    return f"orgs/{org_id}/avatars/{avatar_id}/published/r{revision}"


def config_of(avatar) -> dict | None:
    """The published snapshot, or None if this avatar has never been published."""
    raw = getattr(avatar, "published_config", None)
    if not raw:
        return None
    try:
        return json.loads(raw)
    except ValueError:
        logger.warning("avatar %s has unreadable published_config", avatar.id)
        return None


def has_unpublished_changes(avatar) -> bool:
    config = config_of(avatar)
    if config is None:
        return True
    return config.get("revision") != getattr(avatar, "draft_revision", 0)


def mark_dirty(avatar) -> None:
    """Record that the draft moved ahead of what was published.

    Called by every mutation a visitor could notice. Deliberately explicit at
    each call site rather than hooked onto the ORM: a change that does not
    affect what is rendered (renaming the avatar, toggling a share link)
    should NOT mark the draft dirty, and an automatic hook cannot tell the
    difference.
    """
    avatar.draft_revision = (getattr(avatar, "draft_revision", 0) or 0) + 1


async def publish(avatar, storage) -> dict:
    """Copy the current draft into an immutable published snapshot.

    Copies rather than references — see the module docstring. The config is
    written last, so a failure part way through leaves the previously
    published snapshot serving, not a half-built one.
    """
    revision = getattr(avatar, "draft_revision", 0) or 0
    prefix = published_prefix(avatar.org_id, avatar.id, revision)

    async def copy(source: str | None, name: str, default_ext: str) -> str | None:
        if not source or not await storage.exists(source):
            return None
        target = f"{prefix}/{name}.{_ext(source, default_ext)}"
        data = await storage.get_bytes(source)
        await storage.put_bytes(target, data, _content_type(target))
        return target

    image_key = await copy(avatar.image_key, "image", "png")
    if image_key is None:
        raise ValueError("avatar has no image to publish")
    rig_key = await copy(avatar.rig_key, "rig", "json")
    thumbnail_key = await copy(avatar.thumbnail_key, "thumb", "jpg")

    layer_keys: dict[str, str] = {}
    if getattr(avatar, "has_layers", False):
        from app.services.layers import layer_key

        for name in LAYER_NAMES:
            copied = await copy(
                layer_key(avatar.org_id, avatar.id, name),
                f"layer-{name}",
                "jpg" if name == "background" else "png",
            )
            if copied:
                layer_keys[name] = copied

    # The mouth: settings by value, the optional teeth photo by copy — same
    # reason as everything else here, a later edit must not reach visitors.
    from app.services.mouth import load as load_mouth, renderer_allowed

    face_type = getattr(avatar, "face_type", "human")
    mouth = load_mouth(getattr(avatar, "mouth_config", None))
    mouth_published = None
    # A mouth this face type may not use publishes as the classic one (None),
    # whatever route put it in the draft: the photographic mouth draws human
    # teeth, and a visitor must never see them in a muzzle.
    if mouth and renderer_allowed(mouth["renderer"], face_type):
        mouth_published = {"renderer": mouth["renderer"], "profile": mouth.get("profile") or {}}
        oral_image = await copy(mouth.get("oral_image_key"), "mouth", "png")
        oral_rig = await copy(mouth.get("oral_rig_key"), "mouth-rig", "json")
        if oral_image and oral_rig:
            mouth_published.update(oral_image_key=oral_image, oral_rig_key=oral_rig)

    config = {
        "revision": revision,
        "framing": avatar.framing,
        "face_type": face_type,
        "voice": getattr(avatar, "voice", None),
        "mouth": mouth_published,
        "image_key": image_key,
        "rig_key": rig_key,
        "thumbnail_key": thumbnail_key,
        "layer_keys": layer_keys or None,
        "published_at": datetime.now(timezone.utc).isoformat(),
    }
    previous = config_of(avatar)
    avatar.published_config = json.dumps(config)

    # Only after the new snapshot is recorded: deleting first would leave a
    # window where the config points at files that no longer exist.
    await _prune(avatar, storage, keep_from=[config, previous])
    logger.info("published avatar %s at revision %d", avatar.id, revision)
    return config


async def _prune(avatar, storage, keep_from: list[dict | None]) -> None:
    """Delete published revisions older than the ones still in use."""
    keep = {c["revision"] for c in keep_from if c and "revision" in c}
    if not keep:
        return
    oldest = min(keep)
    for revision in range(max(0, oldest - KEEP_REVISIONS), oldest):
        prefix = published_prefix(avatar.org_id, avatar.id, revision)
        for name in ("image", "rig", "thumb", "mouth", "mouth-rig", *[f"layer-{n}" for n in LAYER_NAMES]):
            for ext in ("png", "jpg", "json", "glb"):
                key = f"{prefix}/{name}.{ext}"
                try:
                    if await storage.exists(key):
                        await storage.delete(key)
                except Exception:  # pruning is housekeeping, never fatal
                    logger.exception("could not prune %s", key)


async def discard_draft(avatar, storage) -> bool:
    """Put the draft back to what is published. True if anything changed.

    The published copies are restored into fresh live keys rather than the
    originals being 'un-edited': the live keys may point at a crop or a
    cut-out that no longer has a corresponding source, and inventing one
    would be guesswork. Copying the published bytes forward is exact.
    """
    config = config_of(avatar)
    if config is None:
        return False

    from uuid import uuid4

    stamp = uuid4().hex[:8]
    base = f"orgs/{avatar.org_id}/avatars/{avatar.id}"

    async def restore(source: str | None, name: str) -> str | None:
        if not source or not await storage.exists(source):
            return None
        target = f"{base}/{name}-{stamp}.{_ext(source, 'png')}"
        await storage.put_bytes(target, await storage.get_bytes(source), _content_type(target))
        return target

    image_key = await restore(config.get("image_key"), "source")
    if image_key:
        avatar.image_key = image_key
    rig_restored = await restore(config.get("rig_key"), "rig")
    if rig_restored:
        avatar.rig_key = rig_restored
    thumb_restored = await restore(config.get("thumbnail_key"), "thumb")
    if thumb_restored:
        avatar.thumbnail_key = thumb_restored

    # Layers live at a fixed path, so they are restored in place, and a layer
    # the published version does not have is deleted: going back to a
    # cut-out must not keep the edited draft's backdrop behind it.
    from app.services.layers import layer_key

    layer_keys = config.get("layer_keys") or {}
    for name in LAYER_NAMES:
        target = layer_key(avatar.org_id, avatar.id, name)
        source = layer_keys.get(name)
        if source is None:
            await storage.delete(target)
        elif await storage.exists(source):
            await storage.put_bytes(target, await storage.get_bytes(source), _content_type(source))
    # The mouth goes back too. Its photo is restored into fresh draft keys
    # so the draft never aliases the immutable published copy.
    published_mouth = config.get("mouth")
    if published_mouth:
        restored = {"renderer": published_mouth["renderer"], "profile": published_mouth.get("profile") or {}}
        oral_image = await restore(published_mouth.get("oral_image_key"), "mouth")
        oral_rig = await restore(published_mouth.get("oral_rig_key"), "mouth-rig")
        if oral_image and oral_rig:
            restored.update(oral_image_key=oral_image, oral_rig_key=oral_rig)
        avatar.mouth_config = json.dumps(restored)
    else:
        avatar.mouth_config = None
    avatar.has_layers = bool(layer_keys)
    avatar.framing = config.get("framing", avatar.framing)
    if config.get("face_type"):
        avatar.face_type = config["face_type"]
    # Back in step with what is published.
    avatar.draft_revision = config.get("revision", 0)
    logger.info("discarded draft for avatar %s", avatar.id)
    return True


def _content_type(key: str) -> str:
    ext = _ext(key, "")
    return {
        "png": "image/png",
        "jpg": "image/jpeg",
        "jpeg": "image/jpeg",
        "json": "application/json",
        "glb": "model/gltf-binary",
    }.get(ext, "application/octet-stream")


async def published_view(avatar, storage) -> dict | None:
    """Presigned URLs for the published snapshot, or None if never published."""
    config = config_of(avatar)
    if config is None:
        return None
    image_url = await storage.presign_get(config["image_key"])
    layer_keys = config.get("layer_keys") or {}
    layer_urls = {
        name: await storage.presign_get(key) for name, key in layer_keys.items()
    }
    return {
        "framing": config.get("framing", "face"),
        "voice": config.get("voice"),
        "mouth": await _mouth_view(config.get("mouth"), storage),
        "rig_url": await storage.presign_get(config["rig_key"]) if config.get("rig_key") else "",
        "thumbnail_url": (
            await storage.presign_get(config["thumbnail_key"])
            if config.get("thumbnail_key")
            else ""
        ),
        "image_url": image_url,
        "layer_urls": layer_urls or None,
    }


async def _mouth_view(mouth: dict | None, storage) -> dict | None:
    """What a visitor's engine needs: renderer, fit, and presigned teeth."""
    if not mouth or mouth.get("renderer") != "continuous":
        return None
    from app.services.mouth import photo_urls

    return {
        "renderer": "continuous",
        "profile": mouth.get("profile") or {},
        "oral": await photo_urls(mouth, storage),
    }
