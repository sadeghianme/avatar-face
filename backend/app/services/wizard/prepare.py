"""The prepare job: the picture in the plan's look (or the photo itself),
its cut-out and the face found on it, stored in one write."""

from __future__ import annotations

import copy
import hashlib
import io
import logging
from uuid import uuid4

from PIL import Image

from app.core.errors import AppError, Conflict409, Validation422
from app.services.jobs import FAILED, Job, run_cpu, runner
from app.services.wizard.plan import (
    CHANGE,
    GENERATE,
    KEPT_ANCHORS,
    KEPT_RECORD,
    ORIGINAL,
    STYLE_OF_LOOK,
    inferred_plan,
    plan_of,
)
from app.services.wizard.prompts import (
    change_prompt,
    character_prompt,
    prepare_prompt,
)

logger = logging.getLogger("liveface.wizard")


def _png(data: bytes) -> tuple[bytes, int, int]:
    """An answer as the creation stores images: upright PNG, no metadata,
    long edge at most photo_io.STORED_MAX_EDGE."""
    from PIL import Image

    from app.services.photo_io import STORED_MAX_EDGE, ingest_photo

    clean = ingest_photo(data, STORED_MAX_EDGE)
    with Image.open(io.BytesIO(clean)) as image:
        return clean, image.width, image.height


def cut_out(png: bytes, face_type: str) -> bytes | None:
    """The subject of `png` on transparency, or None when it cannot be cut
    cleanly (the picture is then kept as it is). A person goes through the
    person segmenter when this server has one; everything, and a person the
    segmenter cannot take, through the backdrop keyer. CPU work."""
    from app.services import backdrop, segment

    if face_type == "human":
        try:
            return segment.remove_background(png)
        except segment.SegmentationUnavailable:
            pass
        except Exception:
            # Broad on purpose: the segmenter's runtime fails in its own
            # types; the backdrop keyer is tried instead.
            logger.exception("segmenting a prepared picture failed; keying its backdrop")
    try:
        return backdrop.cut_backdrop(png)
    except Exception:
        # Broad on purpose: a picture neither can cut is kept as it is.
        logger.exception("keying a prepared picture's backdrop failed")
        return None


async def settle(
    job: Job,
    creation,
    steps: dict,
    opaque_id: str,
    png: bytes,
    consent_id: str | None,
    new_keys: list[str],
) -> tuple[dict, bool]:
    """Cut out the opaque step `opaque_id` (already in `steps`, its bytes
    `png`), make the cut-out current, and find the face on it.

    Returns (anchors, cut). `steps` is edited in place; every key written
    is added to `new_keys` (deleted if the result is discarded).
    """
    from app.services import creations as svc
    from app.services.storage import get_storage

    face_type = creation.face_type
    storage = get_storage()
    items = steps["items"]
    job.report(0.72, "removing the background")
    cut = await run_cpu(cut_out, png, face_type)
    current = opaque_id
    if cut is not None:
        cut_id = svc.cutout_id_for(opaque_id)
        key = svc.step_key(job.org_id, job.subject_id, cut_id.replace(":", ""))
        await storage.put_bytes(key, cut, "image/png")
        new_keys.append(key)
        item = items[opaque_id]
        items[cut_id] = {
            "key": key, "width": item["width"], "height": item["height"], "from": opaque_id,
            "cutout": True,
        }
        current = cut_id
        steps["background"] = "remove"
    else:
        steps["background"] = "keep"
    steps["current"] = current

    job.report(0.85, "finding the face")
    shown = cut if cut is not None else png
    found = await run_cpu(svc.detect_anchors, shown, face_type)
    source = "mediapipe" if found["detected"] else "template"
    if consent_id and svc.wants_ai_points(face_type, found["detected"]):
        digest = await run_cpu(lambda: hashlib.sha256(shown).hexdigest())
        ai, warning = await svc._ai_points(
            job, {"sha256": digest, "charged": False}, shown, face_type,
            tuple(found["image_size"]),
        )
        if ai is not None:
            found, source = ai, "ai"
        elif warning is not None:
            found["validation"]["warnings"].append(warning)
    anchors = {
        "id": uuid4().hex,
        "frame": svc.frame_key(steps, current),
        "face_type": face_type,
        "source": source,
        **found,
    }
    # Kept with the version too: going back to it later (POST /version)
    # opens these points again rather than finding them anew.
    items[opaque_id][KEPT_ANCHORS] = copy.deepcopy(anchors)
    return anchors, cut is not None


def _refund(usage: dict) -> None:
    usage["prepare_rounds"] = max(0, int(usage.get("prepare_rounds") or 0) - 1)


def _refund_free(usage: dict) -> None:
    usage["free_clears"] = max(0, int(usage.get("free_clears") or 0) - 1)


def head_crop_source(data: bytes) -> tuple[bytes, str] | None:
    """The head-and-shoulders crop of the picture about its face, as it may
    be sent to the model (opaque, shrunk, JPEG), or None when there is no
    face to crop around or the crop is the whole picture. CPU work.

    Measured against the real model (2026-09-25 and again 2026-10-03): a
    whole-frame portrait is declined at the prompt (promptFeedback OTHER)
    and the same face cropped to 2.2 face widths is edited under the same
    prompt. So a declined edit is asked once more on this: a different
    input, never the same request repeated (photo_adjust.head_crop)."""
    from app.services import imagegen, landmarks, photo_adjust
    from app.services.photo_io import on_backdrop

    image = on_backdrop(Image.open(io.BytesIO(data)))
    try:
        points = photo_adjust._detect(image)
    except landmarks.LandmarkerUnavailable:
        return None
    if points is None:
        return None
    crop = photo_adjust.head_crop(image, points)
    if crop is None:
        return None
    return photo_adjust._jpeg(crop, imagegen.SOURCE_QUALITY), "image/jpeg"


async def _ask_ai(
    job: Job, prompt: str, source: bytes | None, mode: str
) -> tuple[bytes, str]:
    """The call to the image model, metered as it is answered. Raises the
    wizard's own errors: safety_refused (never asked a third time), no_image,
    imagegen_unavailable, provider_error, third_party_ai_disabled, and the
    monthly limit.

    An edit the model declines (an upload, a change) is asked ONCE more on
    the picture's head-and-shoulders crop when it has one that differs from
    the whole picture (head_crop_source); every answered call, the refusal
    included, is metered, and the switch and the monthly limit are read
    again before the second. A character made from words has no picture to
    crop and is asked once."""
    from app.db import get_session_factory
    from app.services import creations as svc
    from app.services import imagegen
    from app.services.usage import check_image_limit, record_generation

    session = get_session_factory()
    sends: list[tuple[bytes, str] | None] = (
        [None] if source is None else [await run_cpu(svc.source_on_backdrop, source)]
    )
    tried_crop = source is None
    refusal: imagegen.ImageGenRefused | None = None
    index = 0
    while index < len(sends):
        if await svc._ai_switched_off(job.org_id):
            raise svc._ai_disabled_error()
        async with session() as db:
            await check_image_limit(db, job.org_id)
        send = sends[index]
        index += 1
        try:
            # The wait on Google (tens of seconds) is not work on this box:
            # the running slot goes back for it, so other people's uploads
            # are not held at "waiting for a free worker" behind it.
            async with runner.outside_slot(job):
                if send is not None:
                    answer = await imagegen.edit_image(prompt, send[0], send[1])
                else:
                    answer = await imagegen.create_image(prompt)
        except imagegen.ImageGenRefused as exc:
            async with session() as db:
                await record_generation(db, job.org_id, "gemini", mode)
            refusal = exc
            if not tried_crop:
                tried_crop = True
                crop = await run_cpu(head_crop_source, source)
                if crop is not None:
                    logger.info(
                        "prepare %s refused (%s); asking once more on the head crop",
                        job.id, exc.reason,
                    )
                    sends.append(crop)
            continue
        except imagegen.ImageGenNoImage as exc:
            async with session() as db:
                await record_generation(db, job.org_id, "gemini", mode)
            raise AppError(
                "The AI answered without a picture; try again", code="no_image"
            ) from exc
        except imagegen.ImageGenUnavailable as exc:
            raise Conflict409(
                "AI image making is not configured on this server", code="imagegen_unavailable"
            ) from exc
        except AppError:
            raise
        except Exception as exc:
            # Broad on purpose: the provider's call fails in many types; any
            # other than those above is provider_error, which may be retried.
            logger.exception("prepare %s: the provider call failed", job.id)
            raise AppError(
                "The AI service did not return a picture; try again", code="provider_error"
            ) from exc
        async with session() as db:
            await record_generation(db, job.org_id, "gemini", mode)
        return answer.image, answer.model
    if source is None:
        detail = "The AI declined to make this character; change the description"
    else:
        detail = "The AI declined to edit this photo; try another photo or change"
    raise Validation422(detail, code="safety_refused") from refusal


async def prepare_job(job: Job, params: dict) -> None:
    """Step 3: make the picture the avatar is built from (see the module
    docstring), cut it out and find its face, in one write."""
    from app.services import creations as svc
    from app.services.storage import get_storage

    creation = await svc._load(job)
    if creation is None:
        return
    mode = params["mode"]
    plan = plan_of(creation.steps) or inferred_plan(creation.face_type, False)
    model, look = plan["model"], plan["look"]
    items = svc.step_items(creation.steps)
    original = items.get("original")
    if original is None or creation.face_type is None:
        await svc._write_job(job, FAILED, params, svc.SUPERSEDED)
        return
    storage = get_storage()
    steps = svc.copied(creation.steps)
    new_keys: list[str] = []
    old_keys: list[str] = []
    consent_id = params.get("consent_id")

    if mode == ORIGINAL:
        # The photo itself, framed on its face when the check found one,
        # cut out: no AI. Replaces an earlier framing and its cut-out.
        from app.services.photo_analysis import check_photo
        from app.services.photo_io import frame_photo, png_bytes

        job.report(0.1, "preparing the photo")
        # The photo's own framing and cut-out, from an earlier "use my
        # original photo": made again (AI results made since stay).
        old_keys.extend(svc._remove_steps(steps, {"framed", svc.CUTOUT}))
        data = await storage.get_bytes(original["key"])
        framing = (creation.analysis or {}).get("suggested_framing")
        opaque_id, png = "original", data
        if framing:
            def frame() -> tuple[bytes, tuple[int, int], dict]:
                image = frame_photo(data, framing["crop"], framing.get("roll") or 0.0)
                return png_bytes(image), image.size, svc.step_check(check_photo(image))

            png, (width, height), check = await run_cpu(frame)
            key = svc.step_key(job.org_id, job.subject_id, "framed")
            await storage.put_bytes(key, png, "image/png")
            new_keys.append(key)
            steps["items"]["framed"] = {
                "key": key, "width": width, "height": height, "from": "original",
                "crop": framing["crop"], "roll": framing.get("roll") or 0.0, "check": check,
            }
            opaque_id = "framed"
        record = {"mode": ORIGINAL, "look": look, "instruction": None, "step": opaque_id}
    else:
        from app.services.photo_analysis import check_png

        instruction = (params.get("instruction") or "").strip() or None
        if mode == GENERATE:
            source, prompt = None, character_prompt(model, look, plan.get("description"))
            base_id = "original"
            call = "generate"
        elif mode == CHANGE:
            base_id = svc._through_cutouts(creation.steps, svc.current_step(creation.steps))
            if params.get("again"):
                # Retry of the last change: from what that try started from,
                # so the change is not applied on top of its own result.
                last = (svc.ai_usage_of(creation).get("last_prepare") or {}).get("step")
                tried = items.get(last) if last is not None else None
                base_id = (tried or {}).get("from") or base_id
            if base_id is None or base_id not in items:
                base_id = "original"
            source = await storage.get_bytes(items[base_id]["key"])
            made = svc.adjusted_index(base_id) is not None or bool(
                items[base_id].get("generated")
            )
            prompt = (
                change_prompt(model, look, instruction or "")
                if made else prepare_prompt(model, look, instruction)
            )
            call = "prepare"
        else:
            base_id = "original"
            source = await storage.get_bytes(original["key"])
            prompt = prepare_prompt(model, look, instruction)
            call = "prepare"

        job.report(0.15, "creating your avatar")
        try:
            answer, made_by = await _ask_ai(job, prompt, source, call)
        except AppError as exc:
            if exc.code in (
                "imagegen_unavailable", "third_party_ai_disabled", "image_limit_reached",
                "provider_error",
            ):
                # Nothing was sent, or nothing answered: the try is given back.
                # (A refusal or an answer without a picture was billed.)
                give_back = _refund_free if params.get("free") else _refund
                await svc._update_ai_usage(job, give_back)
            raise
        job.report(0.6, "checking the picture")
        png, width, height = await run_cpu(_png, answer)
        check = svc.step_check(await run_cpu(check_png, png))
        usage = svc.ai_usage_of(creation)
        number = usage["next_adjusted"]
        opaque_id = f"{svc.ADJUSTED_PREFIX}{number}"
        key = svc.step_key(job.org_id, job.subject_id, f"adjusted{number}")
        await storage.put_bytes(key, png, "image/png")
        new_keys.append(key)
        steps["items"][opaque_id] = {
            "key": key, "width": width, "height": height, "from": base_id, "cutout": False,
            "check": check,
            "adjust": {
                "mode": "generate" if mode == GENERATE else (
                    "regenerate" if look == "realistic" else "stylise"
                ),
                "style": STYLE_OF_LOOK[look],
                "model": made_by,
                "generated_eyes": False,
                "rejected": None,
                "checks": {},
                "look": look,
                "instruction": instruction,
            },
        }

        def advance(u: dict) -> None:
            u["next_adjusted"] = max(int(u.get("next_adjusted") or 0), number + 1)

        await svc._update_ai_usage(job, advance)
        record = {"mode": mode, "look": look, "instruction": instruction, "step": opaque_id}

    anchors, cut = await settle(job, creation, steps, opaque_id, png, consent_id, new_keys)
    record["cut"] = cut
    steps["items"][opaque_id][KEPT_RECORD] = dict(record)

    def remember(u: dict) -> None:
        u["last_prepare"] = record

    job.report(0.95, "saving")
    await svc._update_ai_usage(job, remember)
    if await svc._store_result(job, params, {"steps": steps, "anchors": anchors}, new_keys):
        for key in old_keys:
            await storage.delete(key)
