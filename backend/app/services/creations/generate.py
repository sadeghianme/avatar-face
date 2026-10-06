"""The job that makes a creation's original with the image model."""

from __future__ import annotations

import logging

from sqlalchemy import select

from app.core.errors import AppError, Conflict409, Validation422
from app.db import get_session_factory
from app.models import Avatar
from app.services.jobs import (
    Job,
    run_cpu,
)
from app.services.storage import get_storage
from app.services.creations.detect import source_on_backdrop
from app.services.creations.ingest import _stored_analysis
from app.services.creations.records import (
    _ai_disabled_error,
    _ai_switched_off,
    _load,
    _store_result,
    _update_ai_usage,
)
from app.services.creations.rules import step_key
from app.services.creations.steps import step_check

logger = logging.getLogger("liveface.creations")


async def _generate(job: Job, params: dict) -> None:
    """Make the creation's original with the image model, from a text
    description (and optionally one of the org's avatars as the source),
    then analyse it like an upload. The wizard carries on from there: the
    generated picture passes the same points and the same confirmation."""
    from app.services import imagegen, photo_adjust
    from app.services.photo_analysis import analyse
    from app.services.photo_io import STORED_MAX_EDGE, ingest_photo
    from app.services.usage import check_image_limit, record_generation

    creation = await _load(job)
    if creation is None:
        return
    storage = get_storage()
    source: bytes | None = None
    if params.get("source_avatar_id"):
        async with get_session_factory()() as db:
            origin = (
                await db.execute(
                    select(Avatar).where(
                        Avatar.id == params["source_avatar_id"], Avatar.org_id == job.org_id
                    )
                )
            ).scalar_one_or_none()
        # The avatar's picture as visitors see it, a cut-out on the neutral
        # grey: never `original_image_key`, which for a cut-out is the photo
        # BEFORE its background came off. The consent the member gave says a
        # removed background is sent as plain grey (as AI adjust does).
        key = origin and origin.image_key
        if not key or not await storage.exists(key):
            raise Conflict409("The source avatar's photo is gone", code="source_gone")
        source = await storage.get_bytes(key)

    if await _ai_switched_off(job.org_id):
        raise _ai_disabled_error()
    async with get_session_factory()() as db:
        await check_image_limit(db, job.org_id)
    job.report(0.1, "generating")
    plan = (creation.steps or {}).get("plan")
    if plan and source is None:
        # The four-step wizard: its own prompt for the model and look, a
        # plain backdrop, and the cut-out and the face found in this job.
        from app.services import wizard

        prompt = wizard.character_prompt(plan["model"], plan["look"], plan.get("description"))
    else:
        prompt = photo_adjust.generation_prompt(
            params["style"], creation.face_type, params.get("prompt") or "", source is not None
        )
    try:
        if source is not None:
            payload, mime = await run_cpu(source_on_backdrop, source)
            generated = await imagegen.edit_image(prompt, payload, mime)
        else:
            generated = await imagegen.create_image(prompt)
    except imagegen.ImageGenNoImage as exc:
        # Answered and billed, so metered; a retry is metered again and
        # held by the monthly limit like any other call.
        async with get_session_factory()() as db:
            await record_generation(db, job.org_id, "gemini", "generate")
        raise AppError(
            "The AI answered without a picture; try again or change the description",
            code="no_image",
        ) from exc
    except imagegen.ImageGenRefused as exc:
        async with get_session_factory()() as db:
            await record_generation(db, job.org_id, "gemini", "generate")
        raise Validation422(
            "The AI declined to make this picture; change the description",
            code="safety_refused",
        ) from exc
    except imagegen.ImageGenUnavailable as exc:
        raise Conflict409(
            "Image generation is not configured on this server", code="imagegen_unavailable"
        ) from exc
    except Exception as exc:
        logger.exception("generation %s failed", job.id)
        raise AppError("The AI service did not return an image; try again",
                       code="provider_error") from exc
    async with get_session_factory()() as db:
        await record_generation(db, job.org_id, "gemini", "generate")

    job.report(0.6, "analysing")
    clean = await run_cpu(ingest_photo, generated.image, STORED_MAX_EDGE)
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
                "generated": {
                    "model": generated.model,
                    "style": params["style"],
                    "provider": "gemini",
                    # A redraw of one of the org's photos, or a face made
                    # from words: which statement finishing asks for.
                    "source_avatar_id": params.get("source_avatar_id"),
                },
            }
        },
    }
    values: dict = {"steps": steps, "analysis": _stored_analysis(analysis)}
    new_keys = [key]
    if plan and source is None:
        from app.services import wizard

        steps["plan"] = plan
        # The name the wizard proposed from the description, given with the plan.
        if name := (creation.steps or {}).get("name"):
            steps["name"] = name
        values["anchors"], cut = await wizard.settle(
            job, creation, steps, "original", clean, params.get("consent_id"), new_keys
        )

        record = {
            "mode": wizard.GENERATE, "look": plan["look"], "instruction": None,
            "step": "original", "cut": cut,
        }
        steps["items"]["original"][wizard.KEPT_RECORD] = dict(record)

        def remember(usage: dict) -> None:
            usage["last_prepare"] = record

        await _update_ai_usage(job, remember)
    await _store_result(job, params, values, new_keys)
