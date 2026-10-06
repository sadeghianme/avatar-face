"""A kit stored on an avatar's draft, and the kit following the avatar's
later edits: the teeth changed, the marks moved, the picture cropped, the
face re-detected. None of these sends anything."""

from __future__ import annotations

import json
import logging
from uuid import uuid4

from sqlalchemy import select

from app.services import mouth, performance_kit
from app.services.jobs import run_cpu
from app.services.mouth_kit.calls import (
    FITTED_WITH_TEETH,
    FITTED_WITHOUT_TEETH,
    MOTION_TYPE,
    OWNER_PHOTO,
    REBASE_FAILED,
    TEETH_REMOVED,
    _note,
    _now,
    generated_count,
    kit_model,
)
from app.services.mouth_kit.records import (
    _standard_teeth,
    kit_record,
    teeth_reason,
    with_ai_shapes,
    without_ai_shapes,
)

logger = logging.getLogger("liveface.mouth_kit")


def _manifest_bytes(manifest: dict) -> bytes:
    return json.dumps(manifest, separators=(",", ":")).encode()


async def store(avatar, storage, result: performance_kit.KitResult, *, source: str) -> list[str]:
    """Make `result` the draft's mouth kit: its manifest the avatar's own
    motion when it has shapes of the person's own (none, and the bundled
    motion plays: this manifest would only be the Reference's shapes fitted
    by mouth width, which is what the bundled motion plays), its teeth fit
    the draft's, its teeth photo the avatar's when the embed would draw it
    and the owner has none of their own, and the disclosure to match. Every
    file is written before the row changes, so a failure leaves the draft
    as it was. The caller commits (and marks an edited draft dirty).
    Returns the keys replaced, to delete after the commit: the published
    snapshot has its own copies."""
    from app.core.errors import Validation422
    from app.schemas.avatar import MouthProfile
    from app.services import mouth_photo

    config = mouth.load(avatar.mouth_config) or {"renderer": "continuous", "profile": {}}
    teeth_record = config.get("teeth") or {}
    has_photo = bool(config.get("oral_image_key") and config.get("oral_rig_key"))
    # A photo from before the record existed is the owner's too.
    own_photo = has_photo and (teeth_record.get("source") or "upload") == "upload"
    model = kit_model(result)
    fitted = dict(result.profile)
    previous: list[str] = []
    ai_edited = avatar.ai_edited

    new_photo: tuple[str, str] | None = None
    reason = teeth_reason(result)
    if own_photo:
        reason = OWNER_PHOTO
    elif result.teeth_source is not None:
        try:
            photo, rig = await run_cpu(
                mouth_photo.admit_photo, result.teeth_source.png, result.teeth_source.rig
            )
        except Validation422 as exc:
            # Accepted as PNG, refused as the WebP visitors would get: on
            # the edge of the embed's limits. The profile was fitted for it,
            # so it is refitted for the teeth that will be drawn: the
            # standard ones.
            logger.info("mouth kit: the teeth photo was refused as WebP (%s)", exc.code)
            reason = _note("mouth_teeth_unclear", exc.detail)
            fitted = performance_kit.for_standard_teeth(fitted)
        else:
            new_photo = await mouth_photo.put_photo(avatar, storage, photo, rig)

    if new_photo is not None:
        previous += [k for k in (config.get("oral_image_key"), config.get("oral_rig_key")) if k]
        config.update(oral_image_key=new_photo[0], oral_rig_key=new_photo[1],
                      teeth=mouth_photo.ai_teeth_record(model))
        ai_edited = mouth_photo.with_ai_teeth(ai_edited, model)
        keys = FITTED_WITH_TEETH
    elif has_photo:
        # Teeth the kit does not replace keep their own fit.
        keys = FITTED_WITHOUT_TEETH
    else:
        config["teeth"] = mouth_photo.generic_teeth_record(
            _standard_teeth(reason or _note("teeth_failed", "The teeth could not be made")))
        keys = FITTED_WITH_TEETH
    # The fitted values the kit decides; everything else the owner set (or
    # the defaults, on a new avatar) stays. Held to the API's ranges like
    # any profile an owner saves: it is served to strangers.
    config["profile"] = MouthProfile.model_validate({
        **(config.get("profile") or {}),
        **{k: fitted[k] for k in keys},
    }).model_dump()

    generated = generated_count(result)
    if generated:
        key = mouth.motion_key(avatar.org_id, avatar.id, uuid4().hex[:8])
        await storage.put_bytes(key, _manifest_bytes(result.manifest), MOTION_TYPE)
        if config.get("motion_key"):
            previous.append(config["motion_key"])
        config["motion_key"] = key
        ai_edited = with_ai_shapes(ai_edited, model, generated)
    else:
        if config.get("motion_key"):
            previous.append(config.pop("motion_key"))
        ai_edited = without_ai_shapes(ai_edited)
    config["kit"] = kit_record(
        result, source=source, teeth={"used": new_photo is not None, "reason": reason},
        fitted={k: config["profile"][k] for k in keys},
    )
    avatar.mouth_config = json.dumps(config)
    avatar.ai_edited = ai_edited
    return previous


# --- Following the avatar's edits ------------------------------------------------------


def teeth_changed(avatar, reason: dict) -> None:
    """The teeth drawn are no longer the ones the kit fitted the profile
    for: the owner uploaded their own photo (OWNER_PHOTO) or removed the
    photo (TEETH_REMOVED: the standard teeth now). The teeth values the kit
    set are refitted for the teeth drawn now, unless the owner has moved
    them since: an upload's own defaults (its teeth at their photographed
    size, seated like any photo's), or the standard teeth's
    (performance_kit.for_standard_teeth: the Reference's own photo, seated
    and sized as the Reference's). A fit for teeth that are not drawn seats
    and sizes the ones that are wrongly. The record says its teeth photo is
    no longer the avatar's, and why. The shapes and the jaw range are
    untouched."""
    from app.schemas.avatar import MouthProfile

    config = mouth.load(avatar.mouth_config)
    kit = (config or {}).get("kit")
    if not config or not kit:
        return
    profile = dict(config.get("profile") or {})
    target = MouthProfile().model_dump()
    if reason["code"] == TEETH_REMOVED["code"]:
        target = performance_kit.for_standard_teeth(target)
    # A record from before `fitted` was kept: the values are the kit's.
    fitted = kit.get("fitted")
    for key in FITTED_WITH_TEETH:
        if fitted is None or key not in fitted or profile.get(key) == fitted[key]:
            profile[key] = target[key]
    config["profile"] = MouthProfile.model_validate(profile).model_dump()
    kit = {**kit, "fitted": {
        **(fitted or {}), **{k: config["profile"][k] for k in FITTED_WITH_TEETH}}}
    if (kit.get("teeth") or {}).get("used"):
        kit["teeth"] = {"used": False, "reason": reason}
    config["kit"] = kit
    avatar.mouth_config = json.dumps(config)


def drop(avatar, reason: dict) -> list[str]:
    """The draft's kit can no longer play on its face (its manifest could
    not follow the points): the motion goes (the engine plays the bundled
    Reference motion again), with the disclosure of its AI-made shapes, and
    the record says why (state "dropped"). The teeth photo and the profile
    stay. Returns the motion's key, to delete after the commit; nothing to
    do without one."""
    config = mouth.load(avatar.mouth_config)
    key = (config or {}).get("motion_key")
    if not config or not key:
        return []
    config.pop("motion_key")
    if config.get("kit"):
        config["kit"] = {**config["kit"], "state": "dropped", "dropped": reason}
    avatar.mouth_config = json.dumps(config)
    avatar.ai_edited = without_ai_shapes(avatar.ai_edited)
    return [key]


async def follow_points(avatar, storage, points, image_size=None) -> list[str]:
    """Move the draft's kit onto the face's points as they are now, with no
    AI call: points re-confirmed on the same picture (Mark the face's saved
    marks, a re-detection), or the picture moved under the same face (a
    crop, a crop reset, an undo of either: the same pixels, translated;
    `image_size` is then the new picture's). Every shape keeps its movement
    (performance_kit.rebase_manifest), and the manifest gets a fresh key.
    A kit that cannot follow is dropped rather than left on the old
    points. Returns the keys replaced, to delete after the commit."""
    config = mouth.load(avatar.mouth_config)
    key = (config or {}).get("motion_key")
    if not config or not key:
        return []
    size = tuple(int(v) for v in image_size) if image_size is not None else None
    try:
        manifest = json.loads(await storage.get_bytes(key))
        rebased = await run_cpu(performance_kit.rebase_manifest, manifest, points, None, size)
    except Exception:
        # Broad on purpose: storage, the manifest and its triangulation fail
        # in many types; a kit that cannot follow is dropped, not left wrong.
        logger.exception("the mouth kit of avatar %s could not follow its points", avatar.id)
        return drop(avatar, REBASE_FAILED)
    if rebased == manifest:
        return []
    new_key = mouth.motion_key(avatar.org_id, avatar.id, uuid4().hex[:8])
    await storage.put_bytes(new_key, _manifest_bytes(rebased), MOTION_TYPE)
    config["motion_key"] = new_key
    if config.get("kit"):
        config["kit"] = {**config["kit"], "rebased_at": _now()}
    avatar.mouth_config = json.dumps(config)
    return [key]


async def follow_rig(avatar, storage, before: dict | None, after: dict | None) -> list[str]:
    """After an edit put another rig in place under the same key (undo):
    the kit follows it. A rig of another size is the same face on a picture
    cropped or uncropped (every edit that snapshots a rig moves the face's
    pixels by a translation at most: a crop, its reset, a background);
    the same picture's rig with other points moves the kit likewise; the
    same rig changes nothing. Returns keys to delete after the commit."""
    if not before or not after:
        return []
    if list(before.get("image_size") or []) != list(after.get("image_size") or []):
        return await follow_points(avatar, storage, after["points"], after["image_size"])
    if before.get("points") != after.get("points"):
        return await follow_points(avatar, storage, after["points"])
    return []


async def follow_redetection(org_id: str, avatar_id: str, points) -> None:
    """follow_points for a job that rebuilt a rig of the same picture
    without the avatar's edit lock (Re-detect, a retry: rig.process_avatar,
    a request's background task).

    Under the lock, on the row as it is NOW, in a short transaction of its
    own: that job loaded its row when it started and commits it much later,
    and a mouth edit in between (the Mouth panel's kit storing its shapes
    and teeth, under the lock) would otherwise be overwritten with the kit
    it had read, its files deleted from under it. Whatever kit the row
    holds now follows the new points. The draft moved ahead of what is
    published (its rig changed), so it is marked so."""
    from app.db import get_session_factory
    from app.services.edit_locks import avatar_edits
    from app.services.publishing import mark_dirty
    from app.services.storage import get_storage

    storage = get_storage()
    stale: list[str] = []
    async with avatar_edits.hold(avatar_id):
        async with get_session_factory()() as db:
            avatar = await _load_avatar(db, org_id, avatar_id)
            if avatar is None:
                return
            stale = await follow_points(avatar, storage, points)
            if avatar.published_config:
                mark_dirty(avatar)
            await db.commit()
    for key in stale:
        await storage.delete(key)


async def _load_avatar(db, org_id: str, avatar_id: str):
    from app.models import Avatar

    return (
        await db.execute(select(Avatar).where(Avatar.id == avatar_id, Avatar.org_id == org_id))
    ).scalar_one_or_none()
