"""The expression pictures as a batch (services.expression_kit.batch): sent
when a publish asks for them and the owner chose "cheaper, when ready",
collected by the sweeper, checked and saved exactly as a live kit is
(saving.save), and published at once when they complete that publish.

Who may send is decided as for a live kit, once, when the batch is sent
(the switch, the image model, the monthly limit for all five, the consent
recorded before anything leaves); the answers are metered when collected,
one usage row per answer, as live calls are. A batch that fails or expires
is given up: the next publish asks again.
"""

from __future__ import annotations

import json
import logging
from datetime import UTC, datetime, timedelta

import numpy as np
from sqlalchemy import select

from app.core.errors import AppError, Conflict409, Forbidden403
from app.db import get_session_factory
from app.models import Avatar
from app.models.shapes import PendingBatch
from app.services import imagegen
from app.services.consent import ai_switched_off
from app.services.edit_locks import avatar_edits
from app.services.expression_kit import batch
from app.services.expression_kit.build import build_expressions, request_for
from app.services.expression_kit.constants import EXPRESSIONS, EXPRESSIONS_CALL
from app.services.expression_kit.prompts import expression_prompt
from app.services.expression_kit.saving import (
    Origin,
    load_avatar,
    record_consent,
    require_person,
    save,
)
from app.services.expressions import load, now
from app.services.jobs import run_cpu
from app.services.performance_kit import KitFailed, KitUnavailable
from app.services.performance_kit.requests import FACE_CROP, crop_picture, load_base_image
from app.services.storage import get_storage
from app.services.usage import check_image_limit, record_generation

logger = logging.getLogger("liveface.expression_kit")

# Google answers a batch within 24 hours or expires it; after this long
# without an end it is given up here too.
GIVE_UP_AFTER = timedelta(hours=26)


async def submit_for_avatar(
    org_id: str, avatar_id: str, consent_id: str, revision: int | None
) -> PendingBatch:
    """Send the five edits of the avatar's picture as one batch and record
    it on the avatar (`pending`). Refused as a live kit would be (403, 409,
    429) before anything is sent."""
    storage = get_storage()
    async with get_session_factory()() as db:
        avatar = await load_avatar(db, org_id, avatar_id)
        require_person(avatar)
        assert avatar is not None  # require_person refuses None
        if await ai_switched_off(org_id):
            raise Forbidden403(
                "Your organization turned off third-party AI, so nothing was sent",
                code="third_party_ai_disabled",
            )
        if not imagegen.configured():
            raise Conflict409(
                "AI editing is not configured on this server", code="imagegen_unavailable"
            )
        await check_image_limit(db, org_id, incoming=len(EXPRESSIONS))
        image_key, rig_key = avatar.image_key, avatar.rig_key
    assert image_key is not None and rig_key is not None  # require_person checked both
    rig = json.loads(await storage.get_bytes(rig_key))
    points = np.asarray(rig["points"], dtype=np.float64)
    image = await run_cpu(load_base_image, await storage.get_bytes(image_key))
    crop = await run_cpu(crop_picture, image, points, FACE_CROP)
    assert crop is not None  # the face crop is always made
    requests = {}
    for name in EXPRESSIONS:
        request = request_for(name, crop)
        requests[name] = imagegen.edit_request(request.prompt, request.payload, request.mime)
    await record_consent(org_id, avatar_id, consent_id)
    name = await batch.submit(f"liveface-expressions-{avatar_id}", requests)
    pending: PendingBatch = {
        "name": name,
        "submitted_at": now(),
        "consent_id": consent_id,
        "picture": {"image_key": image_key, "image_size": list(rig["image_size"])},
        "points": rig["points"],
        "requests": list(EXPRESSIONS),
        "revision": revision,
    }
    async with avatar_edits.hold(avatar_id), get_session_factory()() as db:
        row = await load_avatar(db, org_id, avatar_id)
        if row is not None:
            config = load(row) or {"ai": True}
            config["pending"] = pending
            row.expression_config = config
            await db.commit()
    logger.info("expressions batch %s sent for avatar %s", name, avatar_id)
    return pending


async def collect_batches() -> int:
    """Read back every batch on its way; save those that ended. Never
    raises (the sweeper's tick). Returns how many were settled."""
    try:
        async with get_session_factory()() as db:
            rows = (
                await db.execute(select(Avatar).where(Avatar.expression_config.is_not(None)))
            ).scalars()
            waiting = [
                (row.org_id, row.id, pending)
                for row in rows
                if (pending := (load(row) or {}).get("pending"))
            ]
    except Exception:
        # Broad on purpose: housekeeping must never take the API down.
        logger.exception("could not list the expression batches")
        return 0
    settled = 0
    for org_id, avatar_id, pending in waiting:
        try:
            settled += await collect(org_id, avatar_id, pending)
        except Exception:
            # Broad on purpose: one avatar's batch must not stop the others.
            logger.exception("collecting the expressions batch of avatar %s failed", avatar_id)
    return settled


async def clear_pending(org_id: str, avatar_id: str, name: str) -> None:
    async with avatar_edits.hold(avatar_id), get_session_factory()() as db:
        row = await load_avatar(db, org_id, avatar_id)
        config = load(row) if row is not None else None
        if row is not None and config and (config.get("pending") or {}).get("name") == name:
            config["pending"] = None
            row.expression_config = config
            await db.commit()


async def collect(org_id: str, avatar_id: str, pending: PendingBatch) -> int:
    """One batch: 0 while it runs; 1 once it ended (saved, or given up)."""
    submitted = datetime.fromisoformat(pending["submitted_at"])
    state = await batch.poll(pending["name"])
    if state.state == batch.RUNNING:
        if datetime.now(UTC) - submitted < GIVE_UP_AFTER:
            return 0
        logger.warning("expressions batch %s gave no answer; given up", pending["name"])
        await clear_pending(org_id, avatar_id, pending["name"])
        return 1
    if state.state == batch.FAILED:
        logger.warning("expressions batch %s failed", pending["name"])
        await clear_pending(org_id, avatar_id, pending["name"])
        return 1
    answered = len(state.answers)
    for _ in range(answered):
        async with get_session_factory()() as db:
            await record_generation(db, org_id, "gemini", EXPRESSIONS_CALL)
    storage = get_storage()
    image_key = pending["picture"]["image_key"]
    try:
        picture = await storage.get_bytes(image_key or "")
    except Exception:
        # Broad on purpose: storage fails in many types; the picture the
        # batch was for is gone, so are its pictures.
        logger.exception("the picture of expressions batch %s is gone", pending["name"])
        await clear_pending(org_id, avatar_id, pending["name"])
        return 1
    prompts = {name: expression_prompt(name) for name in pending["requests"]}
    edit = batch.answers_as_edits(state, prompts)
    try:
        result = await build_expressions(
            picture, pending["points"], edit, names=pending["requests"], bound_calls=False
        )
    except (KitUnavailable, KitFailed, ValueError):
        logger.exception("expressions batch %s could not be checked", pending["name"])
        await clear_pending(org_id, avatar_id, pending["name"])
        return 1
    result.calls, result.billed_calls = answered + len(state.errors), answered
    origin = Origin(org_id, avatar_id, pending["points"], "batch", pending.get("revision"))
    try:
        await save(origin, result)
    except AppError as exc:
        logger.info(
            "expressions batch %s for avatar %s: %s", pending["name"], avatar_id, exc.detail
        )
        await clear_pending(org_id, avatar_id, pending["name"])
    return 1
