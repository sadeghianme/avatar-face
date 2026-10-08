"""The owner's marks on the face, and the rig fitted to them
(services.anchor_fit): where each handle opens, a fit previewed or saved,
and the rig's viseme table and render profile kept in step with the
avatar's line and mouth style.
"""

from __future__ import annotations

import asyncio
import json
import logging

import numpy as np
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool

from app.core.errors import Conflict409, Validation422
from app.models import Avatar, AvatarKind, AvatarStatus
from app.services import mouth_kit
from app.services.anchor_fit import (
    NUM_POINTS,
    FitProblem,
    fit_base_key,
    fit_base_points,
    fit_base_record,
    fit_rig,
    marks_from_dict,
    marks_from_mesh,
    marks_mouth_as_line,
    marks_to_dict,
    merge,
    read_fit_base,
    render_profile_for,
    saved_marks,
    with_head_outline,
    write_fit_base,
)
from app.services.mouth import character_style
from app.services.publishing import mark_dirty
from app.services.rig import (
    VISEME_BLENDSHAPES,
    VISEME_PROFILES,
    fit_base_mesh,
    landmarks_from_image,
)
from app.services.storage import STORAGE_ERRORS, Storage, get_storage

logger = logging.getLogger("liveface.avatars")


# --- The rig's look --------------------------------------------------------------


def honour_mouth_style(rig: dict, avatar: Avatar, face_type: str) -> None:
    """A fit names the line's current render profile; an avatar whose owner
    chose the classic mouth keeps the classic one through a re-fit."""
    profile = render_profile_for(face_type, character_style(avatar.mouth_config))
    if profile:
        rig["render_profile"] = profile
    else:
        rig.pop("render_profile", None)


async def rig_profile(avatar: Avatar) -> str | None:
    """The render profile of the avatar's draft rig; null when it names none
    or the rig cannot be read (a photo avatar still processing)."""
    if not avatar.rig_key or avatar.kind != AvatarKind.photo:
        return None
    try:
        rig = json.loads(await get_storage().get_bytes(avatar.rig_key))
    except STORAGE_ERRORS:
        logger.debug("no readable rig for avatar %s", avatar.id, exc_info=True)
        return None
    profile = rig.get("render_profile")
    return profile if isinstance(profile, str) else None


async def reprofile_visemes(avatar: Avatar, visemes: bool = True) -> None:
    """Swap the stored rig's viseme table (unless `visemes` is False) and
    render profile to match the avatar's face type and the owner's mouth
    style. The draft only: visitors see it once published."""
    if not avatar.rig_key or avatar.kind != AvatarKind.photo:
        return
    storage = get_storage()
    try:
        rig = json.loads(await storage.get_bytes(avatar.rig_key))
        if visemes:
            rig["visemes"] = VISEME_PROFILES.get(avatar.face_type, VISEME_BLENDSHAPES)
        # A face that stops being an animal must get its incisors back, and
        # one that becomes an animal loses them, as a fit would have done.
        profile = render_profile_for(avatar.face_type, character_style(avatar.mouth_config))
        if profile:
            rig["render_profile"] = profile
        else:
            rig.pop("render_profile", None)
        await storage.put_bytes(
            avatar.rig_key, json.dumps(rig).encode(), "application/json"
        )
    except STORAGE_ERRORS:
        logger.exception("viseme reprofile failed for avatar %s", avatar.id)


# --- The fit base ----------------------------------------------------------------


async def fit_base(avatar: Avatar, storage: Storage, rig: dict) -> tuple[np.ndarray, bool]:
    """The mesh this rig's fits start from — the detection, else the
    template — and whether the rig's own points number their landmarks as
    it does (see anchor_fit.saved_marks): true of a detection, which the rig
    was built on, and of a rig that is its own base.

    Normally the stored base. A rig without one (built before bases were
    kept) or whose base belongs to another frame (an undo or a discarded
    draft put back an older rig) gets it rebuilt the way a first build makes
    it — detection, else the template — which is deterministic, and stored.
    """
    key = fit_base_key(avatar.org_id, avatar.id)
    stored = await read_fit_base(storage, key)
    points = fit_base_points(stored, rig)
    if stored is not None and points is not None:
        return points, bool(stored.get("detected"))

    def detect(data: bytes):
        found, _, size, detected = landmarks_from_image(data)
        return fit_base_mesh(found, size, detected), size, detected

    assert avatar.image_key is not None  # every caller fits a photo avatar's rig
    image = await storage.get_bytes(avatar.image_key)
    found, size, detected = await run_in_threadpool(detect, image)
    if list(size) != list(rig["image_size"]):
        # The photo and the rig disagree on the frame; nothing rebuilt from
        # the photo would line up, so the rig's own mesh is the only base
        # (and old marks read off it leave it exactly as it is).
        logger.warning("fit base for avatar %s taken from its rig: frame mismatch", avatar.id)
        return np.array(rig["points"], dtype=float), True
    record = fit_base_record(found, rig, detected)
    await write_fit_base(storage, key, record)
    # As stored, not as computed: the next fit reads the stored copy, and the
    # same marks must give the same rig both times.
    points = fit_base_points(record, rig)
    assert points is not None  # a record just made for this rig's frame
    return points, detected


# --- Marks -----------------------------------------------------------------------


def _clamped(value, width: float, height: float):
    """A marking with every point pulled inside the image."""
    if isinstance(value, dict):
        if "x" in value and "y" in value:
            x, y = min(max(value["x"], 0), width), min(max(value["y"], 0), height)
            return {**value, "x": x, "y": y}
        return {key: _clamped(v, width, height) for key, v in value.items()}
    if isinstance(value, list):
        return [_clamped(v, width, height) for v in value]
    return value


async def rig_anchors(avatar: Avatar) -> dict:
    """Where each handle of the avatar's line opens: {anchors, image_size}.

    On the owner's saved marks where there are some, returned as placed (the
    fitted mesh only passes near a mark, it is not where the handle was
    dropped). Anything never marked opens on the landmark it attaches to, in
    the mesh those saved marks make from the base — so a good detection
    means dragging nothing, and an eye left unmarked sits where the fit put
    it; a head saved with four points opens with its outline diagonals on
    the fitted mesh. Always in the line's scheme: an animal marked before
    mouth lines existed opens with a mouth line. Clamped to the image,
    because a later crop can leave a saved mark outside it, where no handle
    could be dragged from.
    """
    if avatar.kind != AvatarKind.photo or not avatar.rig_key or not avatar.image_key:
        raise Conflict409("Avatar has no rig", code="not_adjustable")
    storage = get_storage()
    rig = json.loads(await storage.get_bytes(avatar.rig_key))
    if len(rig.get("points") or []) != NUM_POINTS:
        raise Conflict409("Avatar rig is not adjustable", code="not_adjustable")
    base, rig_on_base = await fit_base(avatar, storage, rig)
    saved = saved_marks(rig, avatar.face_type, rig_on_base)
    # A mesh and a warp, on every panel open: a thread's work.
    fitted, _ = await asyncio.to_thread(fit_rig, rig, base, saved, avatar.face_type)
    # A head saved before it had diagonals opens with them where its fit put
    # them, so all eight handles are there, and the panel, which sends a head
    # it did not touch without them, saves it exactly as it was.
    points = np.array(fitted["points"], dtype=float)
    marks = with_head_outline(merge(marks_from_mesh(points, avatar.face_type), saved), points)
    width, height = rig["image_size"]
    return {
        "anchors": _clamped(marks_to_dict(marks), width, height),
        "image_size": rig["image_size"],
    }


def _marks_outside(marks: dict, width: float, height: float) -> bool:
    """Whether any mark the client sent lies outside the image."""

    def points(value):
        if isinstance(value, dict):
            if "x" in value and "y" in value:
                yield value
            else:
                for v in value.values():
                    yield from points(v)
        elif isinstance(value, list):
            for v in value:
                yield from points(v)

    return any(not (0 <= p["x"] <= width and 0 <= p["y"] <= height) for p in points(marks))


async def fit(avatar: Avatar, marks: dict) -> tuple[dict, list[FitProblem]]:
    """The rig these hand-placed `marks` give (as sent: the marks a client
    omits keep their saved marking), and the validator's problems with it.
    Nothing is written.

    Merged over what was saved before, and always fitted from the base:
    the same marks give the same rig however often they are saved.
    """
    if avatar.kind != AvatarKind.photo or avatar.status != AvatarStatus.ready or not avatar.rig_key:
        raise Conflict409("Avatar rig is not adjustable", code="not_adjustable")

    storage = get_storage()
    rig = json.loads(await storage.get_bytes(avatar.rig_key))
    if len(rig.get("points") or []) != NUM_POINTS:
        raise Conflict409("Avatar rig is not adjustable", code="not_adjustable")
    face_type = avatar.face_type
    as_line = "mouth_line" in marks or "chin" in marks
    if as_line and not marks_mouth_as_line(face_type):
        raise Validation422(
            "A human mouth is marked by its edges, not as a line with a chin",
            code="mouth_line_not_for_face_type",
        )
    width, height = rig["image_size"]
    if _marks_outside(marks, width, height):
        raise Validation422("Every mark must be inside the image", code="mark_outside_image")

    base, rig_on_base = await fit_base(avatar, storage, rig)
    merged = merge(saved_marks(rig, face_type, rig_on_base), marks_from_dict(marks, face_type))
    # On every drag of a handle: a thread's work, off the loop.
    adjusted, problems = await asyncio.to_thread(fit_rig, rig, base, merged, face_type)
    honour_mouth_style(adjusted, avatar, face_type)
    return adjusted, problems


async def save_fit(db: AsyncSession, avatar: Avatar, rig: dict) -> None:
    """Make a fitted rig the draft's. Committed."""
    storage = get_storage()
    assert avatar.rig_key is not None  # fit() refuses an avatar without one
    await storage.put_bytes(avatar.rig_key, json.dumps(rig).encode(), "application/json")
    # The mouth kit's rest pose is the rig's points: it follows the
    # marks, on the same picture, with no AI call.
    stale = await mouth_kit.follow_points(avatar, storage, rig["points"])
    mark_dirty(avatar)
    # Committed, or the dirty mark is lost with the session: the saved
    # marks would reach visitors silently on the next unrelated publish,
    # and the Publish bar would never say they were waiting.
    await db.commit()
    for key in stale:
        await storage.delete(key)
