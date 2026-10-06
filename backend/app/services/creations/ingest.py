"""The jobs that bring a picture in: the upload cleaned and analysed into
the creation's original, and a background removal's cut-out."""

from __future__ import annotations

from sqlalchemy import func

from app.core.errors import Conflict409, Validation422
from app.models import Creation
from app.services import photo_io, segment
from app.services.creations.records import SUPERSEDED, load_creation, store_result, write_job
from app.services.creations.rules import incoming_key, step_key
from app.services.creations.steps import copied, cutout_id_for, step_check, step_items
from app.services.jobs import (
    FAILED,
    Job,
    run_cpu,
)
from app.services.photo_analysis import analyse
from app.services.photo_io import ingest_photo
from app.services.storage import get_storage


async def run_ingest(job: Job, params: dict) -> None:
    storage = get_storage()
    incoming = incoming_key(job.org_id, job.subject_id)
    raw = await storage.get_bytes(incoming)
    job.report(0.1, "reading")
    try:
        clean = await run_cpu(ingest_photo, raw, photo_io.STORED_MAX_EDGE)
    except Validation422:
        # The file itself is the problem; retrying cannot help, and the raw
        # upload (EXIF and all) has no reason to stay.
        await storage.delete(incoming)
        raise
    job.report(0.5, "analysing")
    analysis = await run_cpu(analyse, clean)
    width, height = analysis["image_size"]
    key = step_key(job.org_id, job.subject_id, "original")
    await storage.put_bytes(key, clean, "image/png")
    steps = {
        "current": "original",
        "items": {
            "original": {
                "key": key, "width": width, "height": height, "from": None,
                "check": step_check(analysis),
            }
        },
    }
    # The four-step wizard's plan, and the name it proposes (services.wizard),
    # both given at upload.
    creation = await load_creation(job)
    given = (creation.steps or {}) if creation is not None else {}
    for kept in ("plan", "name"):
        if given.get(kept):
            steps[kept] = given[kept]
    stored = await store_result(
        job,
        params,
        {
            "steps": steps,
            "analysis": stored_analysis(analysis),
            # The owner's choice at upload stands; otherwise the suggestion,
            # which is null when no face was found (the wizard then asks).
            "face_type": func.coalesce(Creation.face_type, analysis["suggested_face_type"]),
        },
        [key],
    )
    if stored:
        await storage.delete(incoming)


def stored_analysis(analysis: dict) -> dict:
    """The upload's analysis as the creation keeps it: what step 1 reads.
    The per-line recommendations live on each step's check, so the one the
    wizard shows is always the current image's (api.creations)."""
    return {k: v for k, v in analysis.items() if k != "recommendations"}


# --- Background -------------------------------------------------------------------


async def run_background(job: Job, params: dict) -> None:
    """Cut the subject out of `params["source"]` and make the cut-out the
    current image. Also what choosing an AI result runs, chained, when the
    owner chose to remove the background: the new picture is opaque."""
    creation = await load_creation(job)
    if creation is None:
        return
    source_id = params["source"]
    source = step_items(creation.steps).get(source_id)
    if source is None:
        await write_job(job, FAILED, params, SUPERSEDED)
        return
    storage = get_storage()
    data = await storage.get_bytes(source["key"])
    job.report(0.2, "removing background")
    try:
        # segment.remove_background writes through photo_io.png_bytes, which
        # zeroes the colour under alpha 0: the room is removed from the file,
        # not hidden in it.
        cut_out = await run_cpu(segment.remove_background, data)
    except segment.SegmentationUnavailable as exc:
        raise Conflict409(
            "Background removal is not configured on this server",
            code="segmentation_unavailable",
        ) from exc
    job.report(0.8, "saving")
    cut_id = cutout_id_for(source_id)
    key = step_key(job.org_id, job.subject_id, cut_id.replace(":", ""))
    await storage.put_bytes(key, cut_out, "image/png")
    steps = copied(creation.steps)
    previous = steps["items"].get(cut_id)
    steps["items"][cut_id] = {
        "key": key, "width": source["width"], "height": source["height"], "from": source_id,
        "cutout": True,
    }
    steps["current"] = cut_id
    # The owner's step 2 answer, which choosing an AI result later follows.
    steps["background"] = "remove"
    if await store_result(job, params, {"steps": steps}, [key]) and previous:
        await storage.delete(previous["key"])
