"""Take out of stored avatar images what a visitor must never get from them.

New files are written clean (services.photo_io, services.layers); this
rewrites the ones stored before that. Three leaks:

1. **Colour under transparency.** A removed background was only made
   invisible: alpha 0 over the original colours, so anyone who dropped the
   alpha channel of a cut-out, a head/body layer, a thumbnail or a published
   copy got the room behind the person back. Such a PNG is rewritten with RGB
   blanked under alpha 0; every visible pixel stays as it was.
2. **A backdrop behind a cut-out.** Removing the background left the opaque
   photo's background layer (the room, with the person painted out) in
   place, and it was served and published behind the cut-out. It is deleted
   wherever the image it sits behind has alpha, in the draft and in every
   published revision, and dropped from the live snapshot's layer_keys.
3. **Photo metadata.** Before uploads were ingested, the presigned upload
   stored the browser's bytes as they came, EXIF and GPS included, and
   publishing copied them byte for byte. Such a file is rewritten in its own
   format under its own key, pixels and size unchanged (a JPEG is re-encoded
   with its own quantisation tables). Only the orientation flag is kept:
   browsers honour it, and dropping it would turn the picture on its side.

What it looks at, per avatar: the current, original and pre-crop images, the
thumbnail, the layers, the mouth photo, every image an undo entry still
points at, and each published revision's copies under published/r<n>/ (all
revisions still in storage, not only the live one).

Idempotent — a clean file has nothing left to take out, so a second run
changes nothing. Dry run by default: it lists what it would change and
changes nothing. Run inside the API container:

    python -m scripts.scrub_stored_photos            # list only
    python -m scripts.scrub_stored_photos --apply    # rewrite and delete
"""

from __future__ import annotations

import argparse
import asyncio
import io
import json

from PIL import ExifTags, Image

# Everything publishing.publish writes as an image, by name under r<n>/; the
# extension follows the source, so each is looked for in every format.
PUBLISHED_IMAGES = ("image", "thumb", "layer-background", "layer-body", "layer-head", "mouth")
IMAGE_TYPES = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp"}

ORIENTATION = ExifTags.Base.Orientation
# Where Pillow exposes what a file says about its author, place and history,
# besides the EXIF block (judged tag by tag, since its orientation is kept).
# "mp" is a multi-picture JPEG's index: the frames it points at carry their
# own EXIF.
METADATA_INFO = ("comment", "xmp", "XML:com.adobe.xmp", "photoshop", "mp")


def leaking_pixels(data: bytes) -> int:
    """Transparent pixels that still hold colour; 0 for anything else."""
    import numpy as np

    from app.services.photo_io import has_alpha

    try:
        image = Image.open(io.BytesIO(data))
        if image.format != "PNG" or not has_alpha(image):
            return 0
        rgba = np.asarray(image.convert("RGBA"))
    except Exception:
        return 0
    return int(rgba[rgba[:, :, 3] == 0, :3].any(axis=1).sum())


def carries_metadata(data: bytes) -> bool:
    try:
        image = Image.open(io.BytesIO(data))
        if image.format not in ("JPEG", "MPO", "PNG", "WEBP"):
            return False
        return (
            bool(set(image.getexif()) - {ORIENTATION})
            or any(name in image.info for name in METADATA_INFO)
            or bool(getattr(image, "text", None))  # PNG text chunks
        )
    except Exception:
        return False


def without_metadata(data: bytes) -> bytes:
    """The same picture in the same format, with only its orientation kept."""
    image = Image.open(io.BytesIO(data))
    options: dict = {}
    orientation = image.getexif().get(ORIENTATION, 1)
    if orientation != 1:
        kept = Image.Exif()
        kept[ORIENTATION] = orientation
        options["exif"] = kept.tobytes()
    if image.info.get("icc_profile"):
        options["icc_profile"] = image.info["icc_profile"]
    out = io.BytesIO()
    if image.format in ("JPEG", "MPO"):
        # "keep" reuses the file's own quantisation tables and subsampling,
        # so the round trip changes next to nothing. A multi-picture JPEG
        # cannot use it and gets a high fixed quality; only its first frame,
        # the one a browser shows, is kept.
        quality = "keep" if image.format == "JPEG" else 95
        # Pillow carries a JPEG comment over unless told otherwise.
        image.save(out, format="JPEG", quality=quality, comment=b"", **options)
    elif image.format == "WEBP":
        image.save(out, format="WEBP", lossless=_webp_lossless(data), quality=95, **options)
    else:
        image.save(out, format="PNG", **options)
    return out.getvalue()


def _webp_lossless(data: bytes) -> bool:
    """Whether a WebP's image chunk is VP8L, so a rewrite can stay lossless."""
    offset = 12  # past "RIFF", the size and "WEBP"
    while offset + 8 <= len(data):
        fourcc = data[offset : offset + 4]
        if fourcc in (b"VP8 ", b"VP8L"):
            return fourcc == b"VP8L"
        size = int.from_bytes(data[offset + 4 : offset + 8], "little")
        offset += 8 + size + (size & 1)
    return False


def avatar_keys(avatar) -> set[str]:
    """Every stored image of this avatar a column or snapshot points at."""
    from app.services.layers import LAYER_FILES, layer_key
    from app.services.mouth import load as load_mouth
    from app.services.publishing import config_of

    keys = {
        avatar.image_key,
        avatar.original_image_key,
        avatar.precrop_image_key,
        avatar.thumbnail_key,
        *(layer_key(avatar.org_id, avatar.id, name) for name in LAYER_FILES),
        (load_mouth(avatar.mouth_config) or {}).get("oral_image_key"),
    }
    try:
        history = json.loads(avatar.edit_history or "[]")
    except ValueError:
        history = []
    for entry in history:
        keys.update(
            entry.get(name)
            for name in ("image_key", "original_image_key", "precrop_image_key", "thumbnail_key")
        )
    published = config_of(avatar) or {}
    keys.update((published.get("layer_keys") or {}).values())
    keys.update(published.get(name) for name in ("image_key", "thumbnail_key"))
    return {key for key in keys if key and key.rsplit(".", 1)[-1] in IMAGE_TYPES}


def published_keys(avatar) -> set[str]:
    """Copies in every published revision that may still be stored — older
    ones are kept for in-flight page loads and no column names them."""
    return {
        f"{prefix}/{name}.{ext}"
        for prefix in _published_prefixes(avatar)
        for name in PUBLISHED_IMAGES
        for ext in IMAGE_TYPES
    }


def _published_prefixes(avatar) -> list[str]:
    from app.services.publishing import published_prefix

    return [
        published_prefix(avatar.org_id, avatar.id, revision)
        for revision in range((avatar.draft_revision or 0) + 1)
    ]


async def _is_cutout(storage, key: str | None) -> bool:
    """Whether the image at `key` exists and has alpha."""
    from app.services.photo_io import has_alpha

    if not key or not await storage.exists(key):
        return False
    try:
        return has_alpha(Image.open(io.BytesIO(await storage.get_bytes(key))))
    except Exception:
        return False


async def stale_backdrops(avatar, storage) -> list[str]:
    """Background layers stored behind an image that has alpha."""
    from app.services.layers import layer_key

    pairs = [(avatar.image_key, layer_key(avatar.org_id, avatar.id, "background"))]
    for prefix in _published_prefixes(avatar):
        for ext in IMAGE_TYPES:
            pairs.append((f"{prefix}/image.{ext}", f"{prefix}/layer-background.jpg"))
    stale: list[str] = []
    for image, backdrop in pairs:
        if backdrop not in stale and await storage.exists(backdrop) and await _is_cutout(storage, image):
            stale.append(backdrop)
    return stale


def _forget_backdrop(avatar, key: str) -> None:
    """Drop a deleted backdrop from the live snapshot, so the embed does not
    hand visitors a URL to a file that is gone."""
    from app.services.publishing import config_of

    config = config_of(avatar)
    layers = (config or {}).get("layer_keys") or {}
    if layers.get("background") == key:
        del layers["background"]
        avatar.published_config = json.dumps(config)


async def scrub(apply: bool) -> list[tuple[str, str]]:
    """(key, what is wrong with it) for every file that needs fixing;
    fixed when `apply`."""
    from sqlalchemy import select

    from app.db import get_session_factory
    from app.models import Avatar
    from app.services.photo_io import png_bytes
    from app.services.storage import get_storage

    storage = get_storage()
    found: list[tuple[str, str]] = []
    async with get_session_factory()() as db:
        avatars = (await db.execute(select(Avatar))).scalars().all()
        for avatar in avatars:
            for key in await stale_backdrops(avatar, storage):
                found.append((key, "background layer behind a cut-out"))
                if apply:
                    await storage.delete(key)
                    _forget_backdrop(avatar, key)
            for key in sorted(avatar_keys(avatar) | published_keys(avatar)):
                if not await storage.exists(key):
                    continue
                data = await storage.get_bytes(key)
                problems = []
                if carries_metadata(data):
                    data = without_metadata(data)
                    problems.append("photo metadata")
                leaking = leaking_pixels(data)
                if leaking:
                    data = png_bytes(Image.open(io.BytesIO(data)))
                    problems.append(f"{leaking} hidden pixels")
                if not problems:
                    continue
                found.append((key, ", ".join(problems)))
                if apply:
                    await storage.put_bytes(key, data, IMAGE_TYPES[key.rsplit(".", 1)[-1]])
        if apply:
            await db.commit()
    return found


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true", default=True,
                      help="list what would change (the default)")
    mode.add_argument("--apply", action="store_true", help="rewrite and delete the files")
    args = parser.parse_args()

    found = asyncio.run(scrub(apply=args.apply))
    verb = "fixed" if args.apply else "would fix"
    for key, problem in found:
        print(f"  {verb} {key} ({problem})")
    print(f"{len(found)} file(s) {verb}" + ("" if args.apply else "; run with --apply to write"))


if __name__ == "__main__":
    main()
