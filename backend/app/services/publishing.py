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
import re
from datetime import UTC, datetime

from app.services.storage import STORAGE_ERRORS

logger = logging.getLogger("liveface.publishing")

LAYER_NAMES = ("background", "body", "head")


def _ext(key: str, default: str) -> str:
    tail = key.rsplit("/", 1)[-1]
    return tail.rsplit(".", 1)[-1] if "." in tail else default


# Was appended to the quality note of a first build that did not publish
# itself; notes stored then still carry it until the owner publishes.
CONFIRM_BEFORE_PUBLISH = (
    "It is not live yet: check the points with “Mark the face”, then press Publish."
)


def confirmed(note: str | None) -> str | None:
    """The quality note once the owner has published: the reason stays, the
    instruction to publish goes. Only notes written before the instruction
    moved to the dashboard's Publish bar still carry it."""
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
    copy = _copier(storage, published_prefix(avatar.org_id, avatar.id, revision))

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

    from app.services.mouth import load as load_mouth
    from app.services.mouth_kit import without_ai_shapes
    from app.services.mouth_photo import without_ai_teeth

    face_type = getattr(avatar, "face_type", "human")
    mouth = load_mouth(getattr(avatar, "mouth_config", None))
    mouth_published = await publish_mouth(mouth, face_type, copy)

    # AI-made teeth are disclosed only while a visitor can see them: on the
    # photographic mouth, with the photo. The classic mouth (chosen in the
    # Mouth panel, or forced by a line switch) draws teeth of its own; the
    # draft keeps the photo and its `ai_edited` entry only so that switching
    # back brings both back. AI-made mouth shapes likewise: only on the
    # photographic mouth playing the avatar's own motion.
    ai_edited = getattr(avatar, "ai_edited", None) or None
    if not _shows_oral_photo(mouth_published):
        ai_edited = without_ai_teeth(ai_edited)
    if not _plays_own_motion(mouth_published):
        ai_edited = without_ai_shapes(ai_edited)

    # The scene (services.scene): by value, with its background picture
    # copied like the other files, only when it is shown.
    from app.services import scene as scene_service

    scene = scene_service.load(avatar)
    scene_published = None
    if scene is not None:
        scene_published = {**scene, "background": {k: v for k, v in scene["background"].items() if k != "image_key"}}
        if scene_service.shows_image(scene):
            copied = await copy(scene_service.image_key_of(scene), "scene", "webp")
            if copied:
                scene_published["background"]["image_key"] = copied
            else:
                scene_published["background"]["kind"] = "transparent"

    config = {
        "revision": revision,
        "framing": avatar.framing,
        "scene": scene_published,
        "face_type": face_type,
        "voice": getattr(avatar, "voice", None),
        "mouth": mouth_published,
        "image_key": image_key,
        "rig_key": rig_key,
        "thumbnail_key": thumbnail_key,
        "layer_keys": layer_keys or None,
        # What visitors are told about the picture: whether an AI made or
        # changed it ({mode, model}, or null), and which line it is. Only
        # snapshots published from here on carry it; older ones are served
        # as they were (principle 6: nothing changes until its owner
        # publishes).
        "disclosure": {
            "ai_edited": ai_edited,
            "line": face_type,
        },
        "published_at": datetime.now(UTC).isoformat(),
    }
    previous = config_of(avatar)
    avatar.published_config = json.dumps(config)

    # Only after the new snapshot is recorded: deleting first would leave a
    # window where the config points at files that no longer exist.
    await _prune(avatar, storage, keep_from=[config, previous])
    await _sweep_mouth_files(avatar, storage, mouth)
    await scene_service.sweep_files(avatar, storage, scene)
    logger.info("published avatar %s at revision %d", avatar.id, revision)
    return config


def _copier(storage, prefix: str):
    """`copy(source, name, default_ext)`: the file at `source` copied under
    `prefix` as `name` with the source's extension, and the copy's key;
    None for no file. How every published file is written."""

    async def copy(source: str | None, name: str, default_ext: str) -> str | None:
        if not source or not await storage.exists(source):
            return None
        target = f"{prefix}/{name}.{_ext(source, default_ext)}"
        data = await storage.get_bytes(source)
        await storage.put_bytes(target, data, _content_type(target))
        return target

    return copy


async def publish_mouth(mouth: dict | None, face_type: str, copy) -> dict | None:
    """The snapshot's `mouth` for the draft's (services.mouth.load): the
    settings by value, the optional teeth photo and the avatar's own motion
    by `copy` (a `_copier`) — same reason as everything else published, a
    later edit must not reach visitors. None is the classic mouth.

    A mouth this face type may not use publishes as the classic one (None),
    whatever route put it in the draft: the photographic mouth draws human
    teeth, and a visitor must never see them in a muzzle."""
    from app.services.mouth import renderer_allowed

    if not mouth or not renderer_allowed(mouth["renderer"], face_type):
        return None
    published = {"renderer": mouth["renderer"], "profile": mouth.get("profile") or {}}
    if mouth.get("character") is not None:
        # How the owner set the character mouth (services.mouth): carried
        # by value, like the fit, so a later edit reaches nobody unpublished.
        published["character"] = mouth["character"]
    oral_image = await copy(mouth.get("oral_image_key"), "mouth", "png")
    oral_rig = await copy(mouth.get("oral_rig_key"), "mouth-rig", "json")
    if oral_image and oral_rig:
        published.update(oral_image_key=oral_image, oral_rig_key=oral_rig)
    motion = await copy(mouth.get("motion_key"), "mouth-motion", "json")
    if motion:
        published["motion_key"] = motion
    if mouth.get("teeth") is not None:
        # Where the teeth photo came from (services.mouth_photo), kept so
        # Discard can put it back with the photo: without it, restored AI
        # teeth would read as the owner's upload. Owner-facing only:
        # _mouth_view never hands it to a visitor.
        published["teeth"] = mouth["teeth"]
    if mouth.get("kit") is not None:
        # What the motion is made of (services.mouth_kit), for Discard
        # likewise, and as owner-facing.
        published["kit"] = mouth["kit"]
    return published


async def republish_mouth(avatar, storage) -> dict | None:
    """Rewrite the live snapshot's `mouth` from the draft's, exactly as
    `publish` would write it, and nothing else: the revision, the files,
    the disclosure and the publish date stay, so an avatar in step with
    its snapshot stays in step, and one with unpublished edits keeps them
    unpublished. For a one-off migration of the mouth alone
    (scripts/migrate_classic_mouths.py), never for an owner's edit, which
    reaches visitors through Publish. Returns the new snapshot, or None
    for an avatar never published (nothing to rewrite).

    Files the draft mouth names are copied under the snapshot's own prefix,
    as `publish` copies them; the snapshot's line decides whether the mouth
    may be the photographic one, as it does for everything it serves."""
    config = config_of(avatar)
    if config is None:
        return None
    from app.services.mouth import load as load_mouth

    prefix = published_prefix(avatar.org_id, avatar.id, config.get("revision", 0))
    face_type = config.get("face_type") or getattr(avatar, "face_type", "human")
    mouth = load_mouth(getattr(avatar, "mouth_config", None))
    config["mouth"] = await publish_mouth(mouth, face_type, _copier(storage, prefix))
    avatar.published_config = json.dumps(config)
    return config


def _shows_oral_photo(mouth: dict | None) -> bool:
    return bool(
        mouth and mouth.get("renderer") == "continuous" and mouth.get("oral_image_key")
    )


def _plays_own_motion(mouth: dict | None) -> bool:
    return bool(mouth and mouth.get("renderer") == "continuous" and mouth.get("motion_key"))


def avatar_root(org_id: str, avatar_id: str) -> str:
    return f"orgs/{org_id}/avatars/{avatar_id}/"


async def _prune(avatar, storage, keep_from: list[dict | None]) -> None:
    """Delete every published revision but the ones still in use: the
    current one, which clients are served, and the previous one, which
    covers URLs already handed out and page loads in flight (`keep_from`).
    Older ones are dead weight.

    By listing what is there: revisions are the draft revisions published,
    with gaps between them (three edits, then a publish), so the numbers
    below the oldest kept say nothing about which exist, and one skipped
    once would stay for good."""
    keep = {c["revision"] for c in keep_from if c and "revision" in c}
    if not keep:
        return
    root = f"{avatar_root(avatar.org_id, avatar.id)}published/"
    try:
        names = await storage.list_names(root)
    except STORAGE_ERRORS:  # pruning is housekeeping, never fatal
        logger.exception("could not list %s", root)
        return
    for name in names:
        match = re.fullmatch(r"r(\d+)", name)
        if match is None or int(match.group(1)) in keep:
            continue
        try:
            await storage.delete_prefix(f"{root}{name}/")
        except STORAGE_ERRORS:
            logger.exception("could not prune %s%s", root, name)


# The draft's own mouth files (services.mouth: mouth-<stamp>.webp/.json and
# mouth-motion-<stamp>.json; older photos .png), beside the avatar's other
# files. The published copies are under published/, never these names.
_MOUTH_FILE = re.compile(r"mouth-[A-Za-z0-9-]+\.(?:webp|png|json)")


def _mouth_keys(mouth: dict | None) -> set[str]:
    return {key for key in (
        (mouth or {}).get("oral_image_key"),
        (mouth or {}).get("oral_rig_key"),
        (mouth or {}).get("motion_key"),
    ) if key}


async def _sweep_mouth_files(avatar, storage, mouth: dict | None) -> None:
    """Delete the draft's mouth files the draft no longer names.

    Every edit that replaces one deletes the old one after its commit; a
    process that died in between (a restart mid-save) leaves it behind for
    good, since nothing names it any more. Publishing holds the avatar's edit
    lock, and every other writer of these files writes and commits under it
    too (or, finishing an avatar, is this very publish), so a file the
    draft does not name here is no one's."""
    root = avatar_root(avatar.org_id, avatar.id)
    named = _mouth_keys(mouth)
    try:
        names = await storage.list_names(root)
    except STORAGE_ERRORS:
        logger.exception("could not list %s", root)
        return
    for name in names:
        if _MOUTH_FILE.fullmatch(name) and f"{root}{name}" not in named:
            try:
                await storage.delete(f"{root}{name}")
            except STORAGE_ERRORS:
                logger.exception("could not delete %s%s", root, name)


async def discard_draft(avatar, storage) -> list[str] | None:
    """Put the draft back to what is published. None when the avatar was
    never published (nothing to go back to); otherwise the discarded
    draft's mouth files the restored draft does not name, to delete after
    the commit (nothing else names them: the undo history keeps pictures
    and rigs, never the mouth).

    The published copies are restored into fresh live keys rather than the
    originals being 'un-edited': the live keys may point at a crop or a
    cut-out that no longer has a corresponding source, and inventing one
    would be guesswork. Copying the published bytes forward is exact.
    """
    config = config_of(avatar)
    if config is None:
        return None
    from app.services.mouth import load as load_mouth

    discarded = _mouth_keys(load_mouth(getattr(avatar, "mouth_config", None)))

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
    # The mouth goes back too. Its photo and its motion are restored into
    # fresh draft keys so the draft never aliases the immutable published
    # copies.
    published_mouth = config.get("mouth")
    teeth = None
    kit = None
    if published_mouth:
        restored = {"renderer": published_mouth["renderer"], "profile": published_mouth.get("profile") or {}}
        oral_image = await restore(published_mouth.get("oral_image_key"), "mouth")
        oral_rig = await restore(published_mouth.get("oral_rig_key"), "mouth-rig")
        if oral_image and oral_rig:
            restored.update(oral_image_key=oral_image, oral_rig_key=oral_rig)
        teeth = _restored_teeth(published_mouth.get("teeth"), config, "oral_image_key" in restored)
        if teeth is not None:
            restored["teeth"] = teeth
        motion = await restore(published_mouth.get("motion_key"), "mouth-motion")
        if motion:
            restored["motion_key"] = motion
        kit = _restored_kit(published_mouth.get("kit"), motion is not None)
        if kit is not None:
            restored["kit"] = kit
        avatar.mouth_config = json.dumps(restored)
    else:
        avatar.mouth_config = None
    # Generating, uploading and removing a teeth photo, and making or
    # dropping the mouth shapes, all change the disclosure, so it goes back
    # with them.
    avatar.ai_edited = _restored_ai_edited(avatar, config, teeth, kit)
    avatar.has_layers = bool(layer_keys)
    avatar.framing = config.get("framing", avatar.framing)
    # The scene goes back too, its picture into a fresh draft key; a
    # snapshot from before scenes existed puts the draft back to none.
    from app.services import scene as scene_service

    discarded |= scene_service.keys(scene_service.load(avatar))
    published_scene = config.get("scene")
    if published_scene:
        restored_scene = {**published_scene, "background": {k: v for k, v in (published_scene.get("background") or {}).items() if k != "image_key"}}
        scene_image = await restore((published_scene.get("background") or {}).get("image_key"), "scene")
        if scene_image:
            restored_scene["background"]["image_key"] = scene_image
        elif restored_scene["background"].get("kind") == "image":
            restored_scene["background"]["kind"] = "transparent"
        avatar.scene_config = restored_scene
    else:
        avatar.scene_config = None
    if config.get("face_type"):
        avatar.face_type = config["face_type"]
    # Back in step with what is published.
    avatar.draft_revision = config.get("revision", 0)
    logger.info("discarded draft for avatar %s", avatar.id)
    restored_keys = _mouth_keys(load_mouth(avatar.mouth_config)) | scene_service.keys(scene_service.load(avatar))
    return sorted(discarded - restored_keys)


def _restored_teeth(published: dict | None, config: dict, has_photo: bool) -> dict | None:
    """The draft's teeth record after a Discard: the one published with the
    photo, or, for a snapshot published before that record was kept, what
    its disclosure says (AI teeth are always disclosed there; any other
    photo is the owner's). A record naming a photo that did not come back
    is dropped: it would describe teeth the draft does not have."""
    from app.services.mouth_photo import ai_teeth_record, upload_teeth_record

    if published is not None:
        return None if published.get("source") and not has_photo else published
    if not has_photo:
        return None
    ai_teeth = ((config.get("disclosure") or {}).get("ai_edited") or {}).get("teeth")
    return ai_teeth_record(ai_teeth.get("model")) if ai_teeth else upload_teeth_record()


def _restored_kit(published: dict | None, has_motion: bool) -> dict | None:
    """The draft's kit record after a Discard: the one published with the
    motion (or without one, for a kit that made no shape of its own: the
    bundled motion played for it). A record of a kit whose motion did not
    come back says so (dropped); a dropped one stays as it was."""
    if published is None:
        return None
    if has_motion or published.get("state") == "dropped" or not published.get("generated"):
        return published
    return {**published, "state": "dropped",
            "dropped": {"code": "motion_missing", "detail": "The mouth shapes' file is gone"}}


def _restored_ai_edited(
    avatar, config: dict, teeth: dict | None, kit: dict | None = None
) -> dict | None:
    """The draft's `ai_edited` after a Discard: what the snapshot disclosed,
    with the teeth entry exactly when the restored photo is AI-made, and
    the mouth-shapes entry exactly when the restored motion has shapes an
    AI made.

    Left as the discarded draft had it, AI teeth brought back by the Discard
    would go out unlabelled at the next Publish, or a label would stay for
    teeth that are gone (the shapes likewise). The entries are re-derived
    rather than copied because the published disclosure leaves them out
    while the classic mouth hides them, and the draft keeps them with the
    files."""
    from app.services.mouth_kit import with_ai_shapes, without_ai_shapes
    from app.services.mouth_photo import with_ai_teeth, without_ai_teeth

    disclosure = config.get("disclosure")
    if disclosure is not None:
        ai_edited = disclosure.get("ai_edited") or None
    else:
        # Published before the disclosure was recorded, when nothing after
        # finish changed `ai_edited`: the draft's own, less any teeth.
        ai_edited = getattr(avatar, "ai_edited", None) or None
    if teeth and teeth.get("source") == "ai":
        ai_edited = with_ai_teeth(ai_edited, teeth.get("model"))
    else:
        ai_edited = without_ai_teeth(ai_edited)
    if kit and kit.get("state") != "dropped" and kit.get("generated"):
        return with_ai_shapes(ai_edited, kit.get("model"), int(kit["generated"]))
    return without_ai_shapes(ai_edited)


def _content_type(key: str) -> str:
    ext = _ext(key, "")
    return {
        "png": "image/png",
        "jpg": "image/jpeg",
        "jpeg": "image/jpeg",
        "webp": "image/webp",
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
    from app.services import scene as scene_service

    return {
        "framing": config.get("framing", "face"),
        # Null for a snapshot from before scenes existed: the engine renders
        # by the framing, as it always did.
        "scene": await scene_service.visitor_view(config.get("scene"), storage),
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
        # Absent from snapshots published before disclosure existed.
        "disclosure": config.get("disclosure"),
    }


async def _mouth_view(mouth: dict | None, storage) -> dict | None:
    """What a visitor's engine needs: renderer, fit, presigned teeth (null:
    the standard teeth, which the engine loads beside the bundled motion),
    and the presigned motion (`motion_url`: the avatar's own performance
    manifest; null, the bundled Reference motion). The engine fetch()es the
    motion cross-origin from the customer's page, which the storage route
    allows (/storage/ is on main.PublicCorsMiddleware's public surface)."""
    if not mouth:
        return None
    from app.services.mouth import clean_character, motion_url, photo_urls

    if mouth.get("renderer") != "continuous":
        # The classic renderer, with the owner's character settings if they
        # set any: the engine applies them when the rig's profile has a
        # character mouth, and ignores them otherwise.
        character = clean_character(mouth.get("character"))
        return {"renderer": "classic", "character": character} if character else None

    return {
        "renderer": "continuous",
        "profile": mouth.get("profile") or {},
        "character": None,
        "oral": await photo_urls(mouth, storage),
        "motion_url": await motion_url(mouth, storage),
    }
