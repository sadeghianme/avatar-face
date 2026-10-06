"""The owner's changes to a draft that need no AI: its framing and its
line, the image chosen, and the background kept or removed.

Each change follows the package's rules: a new frame is a new step and
clears the marks; a cut-out keeps them (no pixel moves); every write is
conditional on the revision the request read.
"""

from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.errors import Conflict409, Validation422
from app.models import Creation
from app.services.creations.guards import require_draft, require_face_type, require_image
from app.services.creations.repo import update_content
from app.services.creations.rules import (
    BEFORE_STYLISE,
    FULL_FRAME,
    MIN_CROP_FRACTION,
    rules_for,
    step_key,
)
from app.services.creations.runs import start_job
from app.services.creations.steps import (
    background_source,
    copied,
    current_step,
    cutout_id_for,
    drop_adjusted,
    drop_cutouts,
    frame_key,
    is_cut_out,
    step_check,
    step_items,
    stylised,
)
from app.services.jobs import run_cpu
from app.services.storage import get_storage


def background_offer(face_type: str | None) -> dict:
    """{available, reason}: whether removing the background can be offered
    on this line, on this server (BackgroundOffer)."""
    if face_type is None:
        return {"available": False, "reason": "face_type_required"}
    if not rules_for(face_type).background_removal:
        return {"available": False, "reason": "not_for_face_type"}
    if not get_settings().segment_model_path:
        return {"available": False, "reason": "segmentation_unavailable"}
    return {"available": True}


async def frame_or_line(
    db: AsyncSession,
    creation: Creation,
    crop: dict | None,
    roll: float | None,
    face_type: str | None,
) -> bool:
    """Frame the photo (`crop`, `roll`) and/or switch the line (`face_type`);
    None leaves either as it is. Whether anything changed (committed).

    Framing is a new step made from the original, never an edit of it, with
    its own photo check. Either change invalidates what was made after it:
    the cut-outs (made from the old frame, or by the old line's segmenter),
    the AI results (made from the old frame) and the marks.
    """
    from app.services.photo_analysis import check_photo
    from app.services.photo_io import frame_photo, png_bytes

    require_draft(creation)
    require_image(creation)
    steps = copied(creation.steps)
    items = steps["items"]
    changed = False
    clear_anchors = False
    new_keys: list[str] = []
    old_keys: list[str] = []

    if crop is not None or roll is not None:
        previous = items.get("framed")
        crop = crop if crop is not None else (previous or {}).get("crop", FULL_FRAME)
        roll = roll if roll is not None else (previous or {}).get("roll", 0.0)
        if crop["x"] + crop["w"] > 1.0 + 1e-6 or crop["y"] + crop["h"] > 1.0 + 1e-6:
            raise Validation422("The crop falls outside the photo", code="crop_out_of_bounds")
        if crop["w"] < MIN_CROP_FRACTION or crop["h"] < MIN_CROP_FRACTION:
            raise Validation422(
                f"The crop must keep at least {int(MIN_CROP_FRACTION * 100)}% of each side",
                code="crop_too_small",
            )
        unframed = crop == FULL_FRAME and not roll
        if previous and previous.get("crop") == crop and previous.get("roll") == roll:
            pass  # the framing it already has
        elif unframed and previous is None:
            pass  # never framed, and still not
        else:
            changed = clear_anchors = True
            old_keys.extend(drop_cutouts(steps))
            # AI candidates were made from the old frame: a new frame is a
            # new photo to adjust. (The rounds they cost stay spent.)
            old_keys.extend(drop_adjusted(steps))
            if previous:
                old_keys.append(items.pop("framed")["key"])
            if unframed:
                # Framing back to the whole, level photo IS the original.
                steps["current"] = "original"
            else:
                original = await get_storage().get_bytes(items["original"]["key"])

                def frame() -> tuple[bytes, tuple[int, int], dict]:
                    image = frame_photo(original, crop, roll)
                    return png_bytes(image), image.size, step_check(check_photo(image))

                data, (width, height), check = await run_cpu(frame)
                key = step_key(creation.org_id, creation.id, "framed")
                await get_storage().put_bytes(key, data, "image/png")
                new_keys.append(key)
                items["framed"] = {
                    "key": key, "width": width, "height": height, "from": "original",
                    "crop": crop, "roll": roll, "check": check,
                }
                steps["current"] = "framed"

    values: dict = {}
    if face_type is not None and face_type != creation.face_type:
        changed = clear_anchors = True
        values["face_type"] = face_type
        # Cut out by the old line's segmenter (or offered to it): gone, and
        # the background is asked again for the new line.
        old_keys.extend(drop_cutouts(steps))
        steps.pop("background", None)
        # The owner chose the line: going back from a stylised version no
        # longer restores the one it had before.
        steps.pop(BEFORE_STYLISE, None)

    if not changed:
        return False
    if clear_anchors:
        values["anchors"] = None
    storage = get_storage()
    try:
        await update_content(db, creation, steps=steps, **values)
    except Conflict409:
        for key in new_keys:
            await storage.delete(key)
        raise
    for key in old_keys:
        await storage.delete(key)
    return True


async def choose(db: AsyncSession, creation: Creation, choice: str) -> int | None:
    """Make the step `choice` the current image. The status to answer with:
    200 when it is done, 202 when a background job finishes it, None when it
    already was the current image (nothing written).

    Marks placed on another pixel frame are cleared. A candidate that failed
    its checks is refused (422 candidate_rejected). A regenerated picture
    comes back opaque: when the owner chose to remove the background, it is
    cut out too, a chained background job, at once if that cut-out exists.
    A stylised candidate moves the creation to the animation line; going
    back from one to a picture that is not one restores the line and the
    background answer it had before.
    """
    require_draft(creation)
    require_image(creation)
    items = step_items(creation.steps)
    item = items.get(choice)
    if item is None:
        raise Validation422("There is no such image to choose", code="unknown_choice")
    adjust = item.get("adjust") or {}
    if adjust.get("rejected"):
        raise Validation422(
            "This result failed its checks and cannot be used: "
            + adjust["rejected"]["detail"],
            code="candidate_rejected",
            extra={"reason": adjust["rejected"]},
        )
    if choice == current_step(creation.steps):
        return None
    steps = copied(creation.steps)
    steps["current"] = choice
    values: dict = {"steps": steps}
    stale: list[str] = []
    chained: dict | None = None
    face_type = creation.face_type
    restored = False
    before = steps.get(BEFORE_STYLISE)
    if adjust.get("mode") == "stylise" and face_type != "cartoon":
        # A stylised person is an animation now: rigged, marked and
        # rendered as one. The cut-outs belonged to the photo line, whose
        # segmenter the animation line does not use, so its backdrop (the
        # plain one the model drew) is kept. What the creation was before
        # is remembered, for going back to the photo.
        steps[BEFORE_STYLISE] = {"face_type": face_type, "background": steps.get("background")}
        face_type = values["face_type"] = "cartoon"
        stale = drop_cutouts(steps)
        steps["current"] = choice
        steps["background"] = "keep"
    elif before and face_type == "cartoon" and not stylised(steps, choice):
        # Back from a stylised version to a picture that is not one ("Keep
        # my photo"): a person's photo is not rigged as a drawing, so the
        # line and the background answer it had before the stylise return.
        face_type = values["face_type"] = before.get("face_type") or "human"
        steps.pop(BEFORE_STYLISE)
        if before.get("background"):
            steps["background"] = before["background"]
        else:
            steps.pop("background", None)
        restored = True
    if (
        (adjust or restored)
        and not is_cut_out(items, steps["current"])
        and steps.get("background") == "remove"
    ):
        # An opaque AI result, or the photo whose cut-out the stylise
        # dropped, on a creation whose background comes off.
        cut = cutout_id_for(steps["current"])
        if cut in items and items[cut].get("from") == steps["current"]:
            steps["current"] = cut
        elif background_offer(face_type)["available"]:
            chained = {"source": steps["current"]}
    anchors = creation.anchors
    if anchors and (
        face_type != creation.face_type
        or anchors.get("frame") != frame_key(steps, steps["current"])
    ):
        values["anchors"] = None
    status = 200
    if chained is not None:
        # The choice and the job in one write: a refused admission (a job
        # already running, the queue full) leaves the choice unmade.
        await start_job(db, creation, "background", chained, values=values, bump=True)
        status = 202
    else:
        await update_content(db, creation, **values)
    for key in stale:
        await get_storage().delete(key)
    return status


async def set_background(db: AsyncSession, creation: Creation, mode: str) -> int:
    """Step 2: remove the background of the current image (a job: 202; 200
    when it is a cut-out already, or its cut-out exists), or keep it (200:
    back to the opaque image behind a current cut-out). The answer is
    remembered (`background`): choosing an AI result later follows it,
    cutting the new picture out when it is "remove". The status to answer
    with."""
    require_draft(creation)
    require_image(creation)
    face_type = require_face_type(creation)
    items = step_items(creation.steps)
    current = current_step(creation.steps)
    assert current is not None  # require_image: an image exists, so one is current
    chosen = (creation.steps or {}).get("background")
    if mode == "keep":
        # Nothing to compute: the opaque image behind the current one is
        # the answer. The cut-outs, if any, stay choosable.
        behind = background_source(creation.steps)
        if current != behind or chosen != "keep":
            steps = copied(creation.steps)
            steps["current"] = behind
            steps["background"] = "keep"
            await update_content(db, creation, steps=steps)
        return 200

    if not rules_for(face_type).background_removal:
        raise Validation422(
            "Background removal only understands people so far; keep the background "
            "for animals and animations",
            code="background_not_for_face_type",
        )
    if is_cut_out(items, current):
        # Already a cut-out (a touch-up of one included): nothing to remove.
        if chosen != "remove":
            steps = copied(creation.steps)
            steps["background"] = "remove"
            await update_content(db, creation, steps=steps)
        return 200
    cut = cutout_id_for(current)
    if cut in items and items[cut].get("from") == current:
        # Already cut from this image: choosing it is enough.
        steps = copied(creation.steps)
        steps["current"] = cut
        steps["background"] = "remove"
        await update_content(db, creation, steps=steps)
        return 200
    if not get_settings().segment_model_path:
        raise Conflict409(
            "Background removal is not configured on this server",
            code="segmentation_unavailable",
        )
    await start_job(db, creation, "background", {"source": current})
    return 202
