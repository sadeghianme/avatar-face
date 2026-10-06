"""The scene an avatar is shown in: how far in, where, and on what.

The engine lays the whole picture on the canvas through a viewport (embed
viewport.ts): "face" is zoom 1, "full" zoom 0, and the owner may now set
any zoom up to ZOOM_MAX, pan the view, and put a background behind a
cut-out — a colour, or a picture of their own. That is the scene:

    {"zoom": 0..1.3,
     "pan": {"x": -1..1, "y": -1..1},     # fractions of the view; 0 is the
                                          # engine's own placement
     "background": {"kind": "transparent" | "color" | "image",
                    "color": "#rrggbb",    # kind color
                    "image_key": "..."}}   # kind image: the stored picture

It lives on the avatar (`scene_config`), draft and published like the
framing: the widget, the share page and every dashboard preview render one
scene, from the same numbers. An avatar from before scenes existed has
none and renders by its `framing` column exactly as it did (`from_framing`);
the column is kept in step with the scene's zoom for any client that still
reads it.

The background picture is a file like the mouth photo: validated and
re-encoded on upload (WebP, no metadata, at most MAX_SIDE a side), stored
under a fresh key beside the avatar's other files, copied into the
published snapshot by publishing (visitors never see a draft file), put
back by Discard, and swept with the draft's other orphans.
"""

from __future__ import annotations

import io
import re
from typing import Any

from app.core.errors import Validation422

ZOOM_MAX = 1.3
KINDS = ("transparent", "color", "image")
_HEX = re.compile(r"^#[0-9a-f]{6}$")
# The longest side a background is stored at: it is drawn behind a face a
# few hundred pixels wide, cover-fitted, so more would only cost visitors.
MAX_SIDE = 2048
IMAGE_TYPE = "image/webp"
IMAGE_QUALITY = 82
# The draft's own background files: scene-<stamp>.webp beside the avatar's
# other files. The published copies are under published/, never this name.
SCENE_FILE = re.compile(r"scene-[A-Za-z0-9-]+\.webp")


def from_framing(framing: str | None) -> dict:
    """The scene an avatar without one renders by: its framing, nothing
    behind it."""
    return {
        "zoom": 0.0 if framing == "full" else 1.0,
        "pan": {"x": 0.0, "y": 0.0},
        "background": {"kind": "transparent"},
    }


def framing_of(scene: dict) -> str:
    """The `framing` a scene amounts to, for clients that read only that."""
    return "full" if float(scene.get("zoom", 1.0)) < 0.5 else "face"


def load(avatar: Any) -> dict | None:
    """The avatar's stored scene, or None for one made before scenes."""
    value = getattr(avatar, "scene_config", None)
    if not isinstance(value, dict) or "zoom" not in value:
        return None
    return value


def effective(avatar: Any) -> dict:
    """The scene the avatar renders by: its own, or its framing's."""
    return load(avatar) or from_framing(getattr(avatar, "framing", "face"))


def _number(value: Any, lo: float, hi: float, name: str) -> float:
    try:
        n = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} must be a number") from exc
    if n != n or n < lo or n > hi:
        raise ValueError(f"{name} must be between {lo} and {hi}")
    return round(n, 4)


def clean(value: dict, image_key: str | None) -> dict:
    """A scene as the owner sent it (zoom, pan, background kind and colour),
    checked and tidied for storage. `image_key` is the picture the draft
    already holds, if any: the owner never names keys, only the kind, and a
    kind "image" needs a picture uploaded first (ValueError otherwise)."""
    if not isinstance(value, dict):
        raise ValueError("scene must be an object")
    zoom = _number(value.get("zoom", 1.0), 0.0, ZOOM_MAX, "zoom")
    pan = value.get("pan") or {}
    if not isinstance(pan, dict):
        raise ValueError("pan must be an object")
    background = value.get("background") or {}
    if not isinstance(background, dict):
        raise ValueError("background must be an object")
    kind = background.get("kind", "transparent")
    if kind not in KINDS:
        raise ValueError("background kind must be transparent, color or image")
    cleaned: dict = {
        "zoom": zoom,
        "pan": {
            "x": _number(pan.get("x", 0.0), -1.0, 1.0, "pan.x"),
            "y": _number(pan.get("y", 0.0), -1.0, 1.0, "pan.y"),
        },
        "background": {"kind": kind},
    }
    if kind == "color":
        color = str(background.get("color", "")).strip().lower()
        if not _HEX.match(color):
            raise ValueError("color must be #rrggbb")
        cleaned["background"]["color"] = color
    if kind == "image":
        if not image_key:
            raise ValueError("no background picture has been uploaded")
        cleaned["background"]["image_key"] = image_key
    elif image_key:
        # The picture stays stored while another kind is shown, so choosing
        # "image" again needs no new upload; removing it is its own action.
        cleaned["background"]["image_key"] = image_key
    return cleaned


def with_zoom(scene: dict, zoom: float) -> dict:
    return {**scene, "zoom": _number(zoom, 0.0, ZOOM_MAX, "zoom")}


def image_key_of(scene: dict | None) -> str | None:
    return ((scene or {}).get("background") or {}).get("image_key") or None


def shows_image(scene: dict | None) -> bool:
    background = (scene or {}).get("background") or {}
    return background.get("kind") == "image" and bool(background.get("image_key"))


def public_view(scene: dict | None) -> dict | None:
    """The owner's view: the numbers, the kind and the colour, and whether a
    picture is stored, never where."""
    if not isinstance(scene, dict) or "zoom" not in scene:
        return None
    background = scene.get("background") or {}
    view: dict = {
        "zoom": scene.get("zoom", 1.0),
        "pan": dict(scene.get("pan") or {"x": 0.0, "y": 0.0}),
        "background": {"kind": background.get("kind", "transparent"), "has_image": bool(background.get("image_key"))},
    }
    if background.get("color"):
        view["background"]["color"] = background["color"]
    return view


async def visitor_view(scene: dict | None, storage) -> dict | None:
    """What an engine renders: the numbers, and for a picture its presigned
    URL (a kind "image" whose file is gone shows as transparent, which is
    what the engine does with a picture that fails to load)."""
    if not isinstance(scene, dict) or "zoom" not in scene:
        return None
    background = scene.get("background") or {}
    kind = background.get("kind", "transparent")
    out: dict = {"kind": kind}
    if kind == "color":
        out["color"] = background.get("color", "#000000")
    if kind == "image":
        key = background.get("image_key")
        if key and await storage.exists(key):
            out["image_url"] = await storage.presign_get(key)
        else:
            out["kind"] = "transparent"
    return {
        "zoom": scene.get("zoom", 1.0),
        "pan": dict(scene.get("pan") or {"x": 0.0, "y": 0.0}),
        "background": out,
    }


def image_key(org_id: str, avatar_id: str, stamp: str) -> str:
    return f"orgs/{org_id}/avatars/{avatar_id}/scene-{stamp}.webp"


def prepare_image(data: bytes) -> bytes:
    """`data` (an upload) as the WebP a background is stored as: decoded and
    checked, scaled to at most MAX_SIDE a side, alpha kept, metadata
    dropped. Validation422 for anything that is not a picture. CPU work."""
    from PIL import Image, UnidentifiedImageError

    try:
        with Image.open(io.BytesIO(data)) as probe:
            probe.verify()
        with Image.open(io.BytesIO(data)) as image:
            image.load()
            mode = "RGBA" if image.mode in ("RGBA", "LA", "P") and _has_alpha(image) else "RGB"
            converted = image.convert(mode)
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        raise Validation422("That file is not a picture we can read", code="scene_image_invalid") from exc
    longest = max(converted.size)
    if longest > MAX_SIDE:
        ratio = MAX_SIDE / longest
        converted = converted.resize(
            (max(1, round(converted.width * ratio)), max(1, round(converted.height * ratio)))
        )
    out = io.BytesIO()
    converted.save(out, format="WEBP", quality=IMAGE_QUALITY, method=4)
    return out.getvalue()


def _has_alpha(image) -> bool:
    if image.mode == "P":
        return "transparency" in image.info
    extrema = image.getextrema()
    alpha = extrema[-1] if isinstance(extrema, tuple) and isinstance(extrema[0], tuple) else None
    return bool(alpha and alpha[0] < 255)


async def store_image(avatar: Any, storage, image: bytes) -> list[str]:
    """Make `image` the draft's background and show it (the caller commits
    and marks the draft dirty). Returns the keys it replaced, to delete
    after the commit: the published snapshot has its own copy."""
    from uuid import uuid4

    scene = effective(avatar)
    previous = [k for k in (image_key_of(scene),) if k]
    key = image_key(avatar.org_id, avatar.id, uuid4().hex[:8])
    await storage.put_bytes(key, image, IMAGE_TYPE)
    avatar.scene_config = {**scene, "background": {"kind": "image", "image_key": key}}
    return previous


def without_image(avatar: Any) -> list[str]:
    """Drop the draft's background picture, showing nothing behind the
    avatar again. Returns the keys to delete after the commit."""
    scene = effective(avatar)
    previous = [k for k in (image_key_of(scene),) if k]
    avatar.scene_config = {**scene, "background": {"kind": "transparent"}}
    return previous


def keys(scene: dict | None) -> set[str]:
    key = image_key_of(scene)
    return {key} if key else set()


async def sweep_files(avatar: Any, storage, scene: dict | None) -> None:
    """Delete the draft's background files the draft no longer names: a
    process that died between replacing one and deleting the old one leaves
    it behind for good (publishing holds the edit lock, as every writer of
    these files does)."""
    import logging

    from app.services.storage import STORAGE_ERRORS

    logger = logging.getLogger("liveface.scene")
    root = f"orgs/{avatar.org_id}/avatars/{avatar.id}/"
    named = keys(scene)
    try:
        names = await storage.list_names(root)
    except STORAGE_ERRORS:
        logger.exception("could not list %s", root)
        return
    for name in names:
        if SCENE_FILE.fullmatch(name) and f"{root}{name}" not in named:
            try:
                await storage.delete(f"{root}{name}")
            except STORAGE_ERRORS:
                logger.exception("could not delete %s%s", root, name)
