"""The avatar's mouth settings: which renderer, how it is fitted, the
optional photo of the person's own teeth, and the avatar's own motion.

Stored as one JSON blob on the avatar (`mouth_config`). The storage keys in
it are internal; what the owner's dashboard is told is built by the owner
API (api.avatars.presenting.mouth_view), and publishing's `_mouth_view` is
what a visitor's engine gets.

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
from typing import cast

from app.models.shapes import CharacterSettings, MouthConfig, Note, OralUrls, TeethRecord
from app.services.storage import Storage

RENDERERS = ("classic", "continuous")

# The photographic ("continuous") mouth paints human enamel and lips. On an
# animal or a drawn character that is a person's teeth in the wrong face.
CONTINUOUS_FACE_TYPES = ("human",)


def renderer_allowed(renderer: str, face_type: str) -> bool:
    return renderer != "continuous" or face_type in CONTINUOUS_FACE_TYPES


# The character mouth (embed/src/engine/character-mouth.ts) is how an animation or an
# animal talks: a drawn or rendered opening with a tongue and, for a toon,
# teeth. It is chosen by the rig's render profile, not by `renderer`, so the
# photographic mouth and the character mouth never meet on one face; what is
# stored here is only how the owner set it: `style` ("character", or "classic"
# for the look the line had before it), `teeth`, `tongue` and `jaw`.
CHARACTER_FACE_TYPES = ("cartoon", "animal")
CHARACTER_STYLES = ("character", "classic")
CHARACTER_TEETH = ("upper", "none")
JAW_RANGE = (0.5, 1.6)
DEFAULT_CHARACTER = {"style": "character", "teeth": "upper", "tongue": True, "jaw": 1.0}


def character_allowed(face_type: str) -> bool:
    return face_type in CHARACTER_FACE_TYPES


def clean_character(raw: object) -> CharacterSettings | None:
    """The owner's character settings as stored: only known keys, each in its
    range; a value that is not usable is the default. None for none."""
    if not isinstance(raw, dict):
        return None
    jaw = raw.get("jaw")
    jaw = float(jaw) if isinstance(jaw, (int, float)) and not isinstance(jaw, bool) else 1.0
    if jaw != jaw:  # NaN
        jaw = 1.0
    # CHARACTER_STYLES and CHARACTER_TEETH, each with its default first.
    return {
        "style": "classic" if raw.get("style") == "classic" else "character",
        "teeth": "none" if raw.get("teeth") == "none" else "upper",
        "tongue": raw["tongue"] if isinstance(raw.get("tongue"), bool) else True,
        "jaw": round(max(JAW_RANGE[0], min(JAW_RANGE[1], jaw)), 3),
    }


def character_style(raw: str | None) -> str:
    """The owner's chosen mouth style for an avatar's stored config; the
    character mouth unless they chose the classic one."""
    config = load(raw)
    return ((config or {}).get("character") or {}).get("style") or "character"


def load(raw: str | None) -> MouthConfig | None:
    try:
        value = json.loads(raw) if raw else None
    except ValueError:
        return None
    if not isinstance(value, dict) or value.get("renderer") not in RENDERERS:
        return None
    # The column as this module and its writers keep it (MouthConfig).
    return cast(MouthConfig, value)


def oral_keys(org_id: str, avatar_id: str, stamp: str) -> tuple[str, str]:
    # WebP (services.mouth_photo.MOUTH_PHOTO_TYPE). Photos stored as PNG
    # before keep their keys; everything downstream reads the extension.
    base = f"orgs/{org_id}/avatars/{avatar_id}/mouth-{stamp}"
    return f"{base}.webp", f"{base}.json"


def motion_key(org_id: str, avatar_id: str, stamp: str) -> str:
    """The avatar's own motion manifest, beside its teeth photo."""
    return f"orgs/{org_id}/avatars/{avatar_id}/mouth-motion-{stamp}.json"


async def photo_urls(config: MouthConfig | None, storage: Storage) -> OralUrls | None:
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


async def motion_url(config: MouthConfig | None, storage: Storage) -> str | None:
    """The presigned URL of the motion manifest, if it still exists. None
    means the engine plays the bundled Reference motion, as it always did."""
    key = (config or {}).get("motion_key")
    if not key or not await storage.exists(key):
        return None
    return await storage.presign_get(key)


# --- The teeth record (mouth_config["teeth"], services.mouth_photo) -----------


def ai_teeth_record(model: str | None) -> TeethRecord:
    return {"source": "ai", "model": model}


def upload_teeth_record() -> TeethRecord:
    return {"source": "upload"}


def generic_teeth_record(note: Note | None) -> TeethRecord:
    """The record of the standard teeth (no teeth photo of its own), and why."""
    return {"source": None, "note": note}


# The note code of an avatar that was not finished with the standard teeth
# but moved onto them: it had the classic drawn mouth from before a new
# person got the photographic one (scripts/migrate_classic_mouths.py).
MIGRATED_STANDARD = "migrated_standard"


def migrated_teeth_record(day: str) -> TeethRecord:
    """The standard teeth's record for an existing avatar moved from the
    classic mouth on `day` (an ISO date): `default_config`'s mouth is what
    it gets, and this says why it has no teeth of its own."""
    return generic_teeth_record(
        {
            "code": MIGRATED_STANDARD,
            "detail": f"Standard teeth: moved from the classic mouth on {day}",
        }
    )
