"""Finding the face: the marks the wizard opens on (the line's detector,
else the face template; the vision model's points for a line the detector
cannot see), and the rig a set of marks fits."""

from __future__ import annotations

import io
from uuid import uuid4

from PIL import Image

from app.core.errors import AppError
from app.db import get_session_factory
from app.models import Creation
from app.services import vision_points
from app.services.anchors import detect_anchors, fit_from_anchors  # noqa: F401
from app.services.creations.records import (
    SUPERSEDED,
    ai_disabled_error,
    ai_switched_off_now,
    ai_usage_of,
    error_record,
    load_creation,
    store_result,
    update_ai_usage,
    write_job,
)
from app.services.creations.steps import current_step, frame_key, step_items
from app.services.imagegen import SOURCE_MAX_EDGE, SOURCE_QUALITY
from app.services.jobs import (
    FAILED,
    Job,
    run_cpu,
)
from app.services.photo_io import on_backdrop
from app.services.storage import get_storage
from app.services.usage import check_vision_limit, record_vision
from app.services.vision_points import MODEL

# How many point-finder answers a creation keeps: the image it is on, and
# the one before (choosing back and forth between two costs nothing).
VISION_CACHE_SIZE = 2


def vision_cache_hit(usage: dict, digest: str | None, face_type: str) -> dict | None:
    """Cached point-finder answer for these pixels, this line, this model."""
    for entry in usage.get("vision_cache") or []:
        if (entry.get("sha256"), entry.get("face_type"), entry.get("model")) == (
            digest, face_type, MODEL
        ):
            return entry["points"]
    return None


def wants_ai_points(face_type: str, detected: bool) -> bool:
    """Is the point finder worth asking? For an animal always (MediaPipe
    never sees one), for an animation only when MediaPipe found nothing, and
    never for a person, whom MediaPipe fits better than any pointer."""
    return face_type == "animal" or (face_type == "cartoon" and not detected)


def source_on_backdrop(data: bytes) -> tuple[bytes, str]:
    """An image as it may be sent to a model: opaque, a cut-out on the
    neutral grey (photo_io.on_backdrop, never the black under alpha 0 nor
    the removed background), shrunk to imagegen.SOURCE_MAX_EDGE, as JPEG.
    CPU work."""
    with Image.open(io.BytesIO(data)) as opened:
        image = on_backdrop(opened)
    if max(image.size) > SOURCE_MAX_EDGE:
        image.thumbnail((SOURCE_MAX_EDGE, SOURCE_MAX_EDGE), Image.Resampling.LANCZOS)
    out = io.BytesIO()
    image.save(out, format="JPEG", quality=SOURCE_QUALITY, optimize=True)
    return out.getvalue(), "image/jpeg"


async def ai_points(job: Job, params: dict, data: bytes, face_type: str, size) -> tuple[
    dict | None, dict | None
]:
    """(anchors, warning): the point finder's anchors, or why not.

    Never fails the detection: a refused, failed or implausible answer
    falls back to what the detector found (or the template), with the
    reason shown beside it. Only an answer the provider actually gave
    spends the detection budget; everything else refunds it.
    """
    creation = await load_creation(job)
    digest = params.get("sha256")
    points = vision_cache_hit(ai_usage_of(creation), digest, face_type) if creation else None
    if points is None:
        called = False
        warning = None
        try:
            if await ai_switched_off_now(job.org_id):
                raise ai_disabled_error()
            async with get_session_factory()() as db:
                await check_vision_limit(db, job.org_id)
            job.report(0.4, "asking the AI for the points")
            payload, mime = await run_cpu(source_on_backdrop, data)
            points = await vision_points.request_points(payload, mime, face_type)
            called = True
        except AppError as exc:  # the monthly limit, or AI switched off
            warning = error_record(exc.code, exc.detail)
        except vision_points.VisionError as exc:
            called = exc.answered
            warning = error_record(exc.code, exc.detail)
        if called:
            async with get_session_factory()() as db:
                await record_vision(db, job.org_id, vision_points.PROVIDER)
        answered = points

        def settle(usage: dict) -> None:
            # Only a call the provider answered spends the detection.
            if not called and params.get("charged"):
                usage["detections"] = max(0, usage["detections"] - 1)
            if answered is not None:
                entry = {
                    "sha256": digest, "face_type": face_type,
                    "model": vision_points.MODEL, "points": answered,
                }
                usage["vision_cache"] = (usage["vision_cache"] + [entry])[-VISION_CACHE_SIZE:]

        await update_ai_usage(job, settle)
    else:
        warning = None
    if points is None:
        return None, warning
    job.report(0.7, "checking the points")
    result = await run_cpu(vision_points.anchors_from_points, points, size, face_type)
    if result.anchors is None:
        return None, error_record(
            "ai_points_implausible",
            "The AI's points did not fit this face (" + "; ".join(result.problems)
            + "); they were placed from the template instead",
        )
    return result.anchors, None


async def run_detect(job: Job, params: dict) -> None:
    creation = await load_creation(job)
    if creation is None:
        return
    current = current_step(creation.steps)
    image = step_items(creation.steps).get(current) if current is not None else None
    if image is None or creation.face_type is None:
        await write_job(job, FAILED, params, SUPERSEDED)
        return
    face_type = creation.face_type
    job.report(0.2, "finding the face")
    data = await get_storage().get_bytes(image["key"])
    found = await run_cpu(detect_anchors, data, face_type)
    source = "mediapipe" if found["detected"] else "template"
    if params.get("use_ai"):
        ai, warning = None, None
        if wants_ai_points(face_type, found["detected"]):
            ai, warning = await ai_points(
                job, params, data, face_type, tuple(found["image_size"])
            )
        else:
            # MediaPipe found this face; the budget admission took is returned.
            def refund(usage: dict) -> None:
                usage["detections"] = max(0, usage["detections"] - 1)

            if params.get("charged"):
                await update_ai_usage(job, refund)
        if ai is not None:
            found, source = ai, "ai"
        elif warning is not None:
            found["validation"]["warnings"].append(warning)
    anchors = {
        "id": uuid4().hex,
        "frame": frame_key(creation.steps, current),
        "face_type": face_type,
        "source": source,
        **found,
    }
    await store_result(job, params, {"anchors": anchors}, [])


def anchors_are_current(creation: Creation) -> bool:
    anchors = creation.anchors
    return bool(
        anchors
        and anchors.get("face_type") == creation.face_type
        and anchors.get("frame") == frame_key(creation.steps, current_step(creation.steps))
    )
