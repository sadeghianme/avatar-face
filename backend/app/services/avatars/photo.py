"""The owner's edits to the avatar's picture: the background cut out or put
back, and the crop (with its reset). Each snapshots the state first
(services.avatars.history), so it can be undone.

The rig is in image pixels, so every edit that moves the picture moves the
rig with it — by translation, never by re-detection, which would lose the
owner's hand-placed marks and, for a face no detector finds, the whole fit.
"""

from __future__ import annotations

import io
import json
import logging

import numpy as np
from PIL import Image
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import Conflict409, Validation422
from app.models import Avatar, AvatarKind
from app.services import mouth_kit
from app.services.anchor_fit import (
    fit_base_key,
    fit_base_points,
    fit_base_record,
    move_fit_base,
    read_fit_base,
    write_fit_base,
)
from app.services.avatars.derived import rebuild_layers, rebuild_thumbnail
from app.services.avatars.history import snapshot
from app.services.jobs import run_cpu
from app.services.photo_io import has_alpha, png_bytes, scrub_transparent
from app.services.publishing import mark_dirty
from app.services.rig import build_rig, fit_base_mesh, landmarks_from_image, starting_mesh
from app.services.segment import SegmentationUnavailable, remove_background
from app.services.storage import STORAGE_ERRORS, get_storage

logger = logging.getLogger("liveface.avatars")

# Below this the rig has too little face left to be worth keeping.
MIN_CROP_FRACTION = 0.15


# --- Background ------------------------------------------------------------------


async def set_background(db: AsyncSession, avatar: Avatar, remove: bool) -> None:
    """Cut the subject out of the photo (`remove`), or put the original back:
    the original is kept, so either way is reversible. Committed; nothing to
    do when the photo is already as asked.

    The rig and the mouth kit are untouched on purpose: a cut-out moves no
    landmark and no pixel of the face (api.avatars.photo.set_background).
    """
    if avatar.kind != AvatarKind.photo or not avatar.image_key:
        raise Conflict409("Only photo avatars have a background", code="not_a_photo")

    storage = get_storage()

    if not remove:
        if not avatar.original_image_key:
            return  # already the original; nothing to undo
        await snapshot(avatar, storage, "restore background")
        avatar.image_key = avatar.original_image_key
        avatar.original_image_key = None
        await rebuild_thumbnail(avatar, storage)
        await rebuild_layers(avatar, storage)
        mark_dirty(avatar)
        await db.commit()
        return

    if avatar.original_image_key:
        return  # already cut out

    photo = await storage.get_bytes(avatar.image_key)
    try:
        # Seconds of decoding, segmenting and encoding: the CPU thread's work.
        cut_out = await run_cpu(remove_background, photo)
    except SegmentationUnavailable as exc:
        raise Conflict409(
            "Background removal is not configured on this server",
            code="segmentation_unavailable",
        ) from exc

    await snapshot(avatar, storage, "remove background")
    key = f"orgs/{avatar.org_id}/avatars/{avatar.id}/source-nobg.png"
    await storage.put_bytes(key, cut_out, "image/png")
    # The original is kept, not overwritten, so this is reversible.
    avatar.original_image_key = avatar.image_key
    avatar.image_key = key
    # The thumbnail is derived from the photo, so it has to follow it — and as
    # a JPEG it could not hold the transparency anyway, which is why the
    # dashboard grid kept showing the background after a successful removal.
    await rebuild_thumbnail(avatar, storage)
    await rebuild_layers(avatar, storage)
    mark_dirty(avatar)
    await db.commit()


# --- Crop ------------------------------------------------------------------------


async def crop(
    db: AsyncSession,
    avatar: Avatar,
    x: float,
    y: float,
    width: float,
    height: float,
    reset: bool,
) -> None:
    """Crop the photo to a rectangle in fractions of it, and move the rig
    (and the fit base and the mouth kit) with it; or with `reset`, put the
    photo from before the first crop back and the rig into its coordinates
    (_uncrop_rig). Committed.

    A translation, never a re-detection: the rig is in image pixels, and
    translating is exact and keeps any correction the user made by hand.
    """
    if avatar.kind != AvatarKind.photo or not avatar.image_key:
        raise Conflict409("Only photo avatars can be cropped", code="not_a_photo")

    storage = get_storage()

    if reset:
        if not avatar.precrop_image_key:
            return  # never cropped; nothing to undo
        await snapshot(avatar, storage, "crop reset")
        # Either may be the crop as cut: a background removed after
        # cropping replaces image_key and keeps the crop as the original.
        cropped_keys = [k for k in (avatar.image_key, avatar.original_image_key) if k]
        avatar.image_key = avatar.precrop_image_key
        avatar.precrop_image_key = None
        await rebuild_thumbnail(avatar, storage)
        await _uncrop_rig(avatar, storage, cropped_keys)
        await rebuild_layers(avatar, storage)
        # The same face, back in the whole picture: the mouth kit follows it.
        stale = await _kit_follows_rig(avatar, storage)
        mark_dirty(avatar)
        await db.commit()
        for key in stale:
            await storage.delete(key)
        return

    if x + width > 1.0 or y + height > 1.0:
        raise Validation422("Crop rectangle falls outside the image", code="crop_out_of_bounds")
    if width < MIN_CROP_FRACTION or height < MIN_CROP_FRACTION:
        raise Validation422(
            f"Crop must keep at least {int(MIN_CROP_FRACTION * 100)}% of each side",
            code="crop_too_small",
        )

    # Decoding, cropping and PNG-encoding a phone photo is up to seconds of
    # CPU: the CPU thread's work, never the loop's.
    png, (left, top), cropped_size = await run_cpu(
        _crop_png, await storage.get_bytes(avatar.image_key), x, y, width, height
    )

    await snapshot(avatar, storage, "crop")
    key = f"orgs/{avatar.org_id}/avatars/{avatar.id}/source-crop.png"
    await storage.put_bytes(key, png, "image/png")
    first_crop = not avatar.precrop_image_key
    # Only the first crop records the pre-crop image, so cropping twice still
    # resets all the way back rather than to the previous crop.
    if first_crop:
        avatar.precrop_image_key = avatar.image_key
    avatar.image_key = key

    if avatar.rig_key:
        rig = json.loads(await storage.get_bytes(avatar.rig_key))
        # Where this crop sits in the pre-crop photo, accumulated over
        # repeated crops, so a reset can move the rig back exactly instead
        # of re-detecting (which loses hand marks and, for an undetectable
        # face, the whole fit). A rig cropped before this was recorded has
        # no origin to add to; it stays without one and reset falls back.
        origin = [0, 0] if first_crop else rig.get("crop_origin")
        base_key = fit_base_key(avatar.org_id, avatar.id)
        base = await read_fit_base(storage, base_key)
        if fit_base_points(base, rig) is None:
            base = None  # not this rig's base: it does not follow the crop
        rig = _move_rig(rig, left, top, cropped_size)
        if origin is not None:
            rig["crop_origin"] = [origin[0] + left, origin[1] + top]
        await storage.put_bytes(avatar.rig_key, json.dumps(rig).encode(), "application/json")
        # The fit base moves with its rig, so marks saved after the crop are
        # fitted from the same mesh as before it. One that already did not
        # match is left to be rebuilt when next needed.
        if base is not None:
            await write_fit_base(storage, base_key, move_fit_base(base, left, top, rig))
    await rebuild_thumbnail(avatar, storage)
    await rebuild_layers(avatar, storage)
    # The same face's pixels, translated: the mouth kit follows the moved
    # rig (its teeth photo is registered by its own landmarks anyway).
    stale = await _kit_follows_rig(avatar, storage)
    mark_dirty(avatar)
    await db.commit()
    for key in stale:
        await storage.delete(key)


def _crop_png(
    data: bytes, x: float, y: float, width: float, height: float
) -> tuple[bytes, tuple[int, int], tuple[int, int]]:
    """The photo cut to a rectangle given in fractions of it, as a PNG; and
    the crop's top-left and size in the photo's pixels."""
    source = Image.open(io.BytesIO(data))
    # Preserve alpha: cropping a cut-out must not paste the background back.
    source = source.convert("RGBA" if has_alpha(source) else "RGB")
    image_width, image_height = source.size
    left = int(round(x * image_width))
    top = int(round(y * image_height))
    right = int(round((x + width) * image_width))
    bottom = int(round((y + height) * image_height))
    cropped = source.crop((left, top, right, bottom))
    return png_bytes(cropped), (left, top), cropped.size


async def _kit_follows_rig(avatar: Avatar, storage) -> list[str]:
    """The mouth kit moved onto the rig now in place after a crop or its
    reset (mouth_kit.follow_points): a crop cuts the same pixels at whole
    pixels, so the kit is the face's still, only elsewhere in the picture.
    Returns the keys to delete after the commit."""
    if not avatar.rig_key:
        return []
    try:
        rig = json.loads(await storage.get_bytes(avatar.rig_key))
    except STORAGE_ERRORS:
        logger.exception("rig read failed for avatar %s", avatar.id)
        return []
    return await mouth_kit.follow_points(avatar, storage, rig["points"], rig["image_size"])


def _move_rig(rig: dict, left: float, top: float, size: tuple[int, int]) -> dict:
    """The rig for an image whose top-left sits at (left, top) of the
    current one — a crop, or with a negative origin, the crop undone."""
    moved = dict(rig)
    moved["image_size"] = [size[0], size[1]]
    moved["points"] = [[p[0] - left, p[1] - top] for p in rig.get("points", [])]
    box = rig.get("face_box")
    if box and len(box) == 4:
        moved["face_box"] = [box[0] - left, box[1] - top, box[2] - left, box[3] - top]
    # Saved hand-placed marks live in image pixels too; without this a crop
    # would reopen the marking panel with every handle off by the crop origin.
    if rig.get("user_anchors"):
        moved["user_anchors"] = _move_anchors(rig["user_anchors"], left, top)
    return moved


def _move_anchors(anchors, left: float, top: float):
    """Every {x, y} in a marking, wherever it sits: region edges, pupils,
    the mouth line's list, the chin. Anything else (the source) is kept."""
    if isinstance(anchors, dict):
        if "x" in anchors and "y" in anchors:
            return {**anchors, "x": anchors["x"] - left, "y": anchors["y"] - top}
        return {key: _move_anchors(value, left, top) for key, value in anchors.items()}
    if isinstance(anchors, list):
        return [_move_anchors(value, left, top) for value in anchors]
    return anchors


async def _uncrop_rig(avatar: Avatar, storage, cropped_keys: list[str]) -> None:
    """Put the rig back into the pre-crop photo's coordinates.

    A translation, not a re-detection: the rig keeps its viseme table, its
    hand-placed marks and, for a face no detector finds, the fit the owner
    made by hand. Rigs cropped before the origin was recorded get it from
    the pixels — a crop is an exact sub-rectangle of the photo it was cut
    from — and only when that fails is the face detected again.
    """
    if not avatar.rig_key or not avatar.image_key:
        return
    rig = json.loads(await storage.get_bytes(avatar.rig_key))
    base_key = fit_base_key(avatar.org_id, avatar.id)
    base = await read_fit_base(storage, base_key)
    if fit_base_points(base, rig) is None:
        base = None  # not this rig's base: it does not follow the reset
    precrop_bytes = await storage.get_bytes(avatar.image_key)
    precrop_size = Image.open(io.BytesIO(precrop_bytes)).size  # the header only

    origin = rig.get("crop_origin")
    if origin is None:
        for key in cropped_keys:
            try:
                cropped_bytes = await storage.get_bytes(key)
            except STORAGE_ERRORS:
                logger.warning("crop candidate %s of avatar %s unreadable", key, avatar.id)
                continue
            # Two full decodes and a pixel search: the CPU thread's work.
            origin = await run_cpu(_locate_crop_in, precrop_bytes, cropped_bytes)
            if origin is not None:
                break

    if origin is not None:
        restored = _move_rig(rig, -origin[0], -origin[1], precrop_size)
        restored.pop("crop_origin", None)
        if base is not None:
            base = move_fit_base(base, -origin[0], -origin[1], restored)
    else:
        redetected = await run_cpu(_redetect_rig, avatar, precrop_bytes, rig)
        if redetected is None:
            return
        restored, base = redetected
    await storage.put_bytes(avatar.rig_key, json.dumps(restored).encode(), "application/json")
    if base is not None:
        await write_fit_base(storage, base_key, base)


def _locate_crop_in(outer: bytes, inner: bytes) -> tuple[int, int] | None:
    """`_locate_crop` for two encoded pictures; None when either cannot be
    read (Pillow's unreadable file is an OSError)."""
    try:
        return _locate_crop(Image.open(io.BytesIO(outer)), Image.open(io.BytesIO(inner)))
    except OSError:
        logger.warning("a crop candidate could not be decoded")
        return None


def _locate_crop(outer, inner) -> tuple[int, int] | None:
    """Where `inner` sits in `outer` pixel for pixel, or None when it does
    not sit anywhere exactly once (not a crop of it, or a flat image where
    every position matches and the origin is unknowable)."""
    # Compared as scrubbed RGBA: an older cut-out still holds colour under
    # alpha 0, and cropping it now blanks that colour.
    big = np.ascontiguousarray(np.asarray(scrub_transparent(outer))).view(np.uint32)[:, :, 0]
    small = np.ascontiguousarray(np.asarray(scrub_transparent(inner))).view(np.uint32)[:, :, 0]
    (height, width), (h, w) = big.shape, small.shape
    if h > height or w > width:
        return None
    span_y, span_x = height - h + 1, width - w + 1
    # Narrow the candidate origins with a spread of probe pixels, then check
    # the few survivors in full.
    candidates = np.ones((span_y, span_x), dtype=bool)
    for py in np.linspace(0, h - 1, 5).astype(int):
        for px in np.linspace(0, w - 1, 5).astype(int):
            candidates &= big[py : py + span_y, px : px + span_x] == small[py, px]
    found = [
        (int(x), int(y))
        for y, x in np.argwhere(candidates)[:8]
        if np.array_equal(big[y : y + h, x : x + w], small)
    ]
    return found[0] if len(found) == 1 else None


def _redetect_rig(
    avatar: Avatar, image_bytes: bytes, previous: dict
) -> tuple[dict, dict] | None:
    """Last resort for a crop reset with no recoverable origin: the rig and
    its fit base, built as a first build would build them.

    Detection runs with the avatar's face type so the rig keeps its viseme
    table and an undetected animal its template. Hand marks cannot follow:
    they are in the cropped photo's coordinates and nothing says where that
    crop was.
    """
    try:
        points, blendshapes, size, detected = landmarks_from_image(image_bytes)
    except Exception:
        # Broad on purpose: the detector's runtime fails in its own types,
        # and the reset then leaves the rig as it is.
        logger.exception("rig rebuild failed after crop reset for avatar %s", avatar.id)
        return None
    if previous.get("user_anchors"):
        logger.warning(
            "crop reset for avatar %s: crop origin unknown, hand marks dropped", avatar.id
        )
    rig = build_rig(
        starting_mesh(points, size, detected, avatar.face_type), size, blendshapes,
        face_type=avatar.face_type,
    )
    return rig, fit_base_record(fit_base_mesh(points, size, detected), rig, detected)
