"""New creations: from an uploaded photo, or with an original the image
model makes (from words, or from one of the org's avatars). Either way the
first job is admitted with the row, and the row is the creation's draft.
"""

from __future__ import annotations

import asyncio

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import Conflict409, NotFound404, Validation422
from app.models import Avatar, AvatarKind, Creation, CreationStatus, Organization
from app.models.base import new_id
from app.schemas.creation import GenerateCreationRequest
from app.services import wizard
from app.services.creations.records import job_record
from app.services.creations.repo import check_draft_limit
from app.services.creations.rules import incoming_key
from app.services.creations.runs import launch
from app.services.jobs import QUEUED, runner
from app.services.storage import get_storage


def upload_plan(
    model: str | None, look: str | None, file_name: str | None
) -> tuple[dict | None, str | None]:
    """(steps, line) for an upload by the four-step wizard, which sends the
    `model` and the `look` (both, or neither: 422 plan_incomplete): the plan
    and the name it proposes, kept from the start, and the line they make.
    (None, None) for an older client, which sends neither."""
    if (model is None) != (look is None):
        raise Validation422("Send both the model and the look", code="plan_incomplete")
    if model is None or look is None:
        return None, None
    steps = {
        "current": None,
        "items": {},
        wizard.PLAN: wizard.make_plan(model, look, "upload"),
        wizard.NAME: wizard.default_name(file_name=file_name),
    }
    return steps, wizard.line_for(model, look)


async def _probe(data: bytes) -> None:
    """Refuse a file whose header is unreadable or too big, off the loop.

    Reading "only the header" is not bounded work on untrusted bytes: Pillow
    walks JPEG markers and PNG chunks in Python, and a 15 MB file of a few
    million empty ones takes seconds to open. On the event loop that would
    stall every embed and speech request on every customer's site. A plain
    thread rather than run_cpu: the probe is what decides whether a job is
    worth queueing, so it must not wait behind the jobs already queued.
    """
    from app.services.photo_io import probe_photo

    await asyncio.to_thread(probe_photo, data)


async def create_from_upload(
    db: AsyncSession,
    org_id: str,
    user_id: str,
    data: bytes,
    content_type: str | None,
    face_type: str | None,
    steps: dict | None,
) -> Creation:
    """A creation for an uploaded photo (already checked for type and size),
    its ingest job admitted and launched. Refused past the draft limit, by
    the job admission, and for a header that cannot be read."""
    await check_draft_limit(db, org_id)

    creation_id = new_id()
    # Admitted before the header is read, so the per-org cap (429) and the
    # queue cap (503) bound how many probes can run at once, not only how
    # many jobs.
    job = runner.reserve(org_id, creation_id, "ingest", 0)
    storage = get_storage()
    incoming = incoming_key(org_id, creation_id)
    try:
        await _probe(data)
        await storage.put_bytes(incoming, data, content_type or "application/octet-stream")
        creation = Creation(
            id=creation_id,
            org_id=org_id,
            created_by_id=user_id,
            face_type=face_type,
            status=CreationStatus.draft,
            revision=0,
            steps=steps,
            job=job_record(job, QUEUED, {}),
        )
        db.add(creation)
        await db.commit()
    except BaseException:
        runner.release(job)
        await storage.delete(incoming)
        raise
    launch(job, {})
    return creation


async def create_generated(
    db: AsyncSession, org: Organization, user_id: str, body: GenerateCreationRequest
) -> Creation:
    """A creation whose original the image model makes, its generate job
    admitted and launched. Refusals: the organization's switch (403
    third_party_ai_disabled), an incomplete plan or a plan with a source
    (422), no line (422 face_type_required), the consent a source photo
    needs (403), a source that is not one of the org's photo avatars (404,
    409), no image model (409), the draft limit (409), the image limit
    (429), and the job admission."""
    from app.services import consent, imagegen
    from app.services.ai_models import PROVIDER
    from app.services.usage import check_image_limit

    consent.require_ai_enabled(org)
    plan = None
    steps = None
    face_type = body.face_type
    if (body.model is None) != (body.look is None):
        raise Validation422("Send both the model and the look", code="plan_incomplete")
    if body.model is not None and body.look is not None:
        if body.source_avatar_id:
            raise Validation422(
                "A character described in words is made from the words only",
                code="plan_with_source",
            )
        plan = wizard.make_plan(body.model, body.look, "generate", body.prompt)
        # The name it proposes, from the description, decided here once.
        steps = {
            "current": None,
            "items": {},
            wizard.PLAN: plan,
            wizard.NAME: wizard.default_name(description=body.prompt),
        }
        face_type = wizard.line_for(body.model, body.look)
    if face_type is None:
        raise Validation422("Say what kind of face to make", code="face_type_required")
    consent_ids: list[str] = []
    if body.source_avatar_id or body.consent_id:
        agreed = await consent.require(
            db, body.consent_id, org, user_id, consent.THIRD_PARTY_AI,
            PROVIDER,
        )
        consent_ids.append(agreed.id)
    if body.source_avatar_id:
        origin = (
            await db.execute(
                select(Avatar).where(
                    Avatar.id == body.source_avatar_id, Avatar.org_id == org.id
                )
            )
        ).scalar_one_or_none()
        if origin is None:
            raise NotFound404("Avatar not found", code="avatar_not_found")
        if origin.kind != AvatarKind.photo or not origin.image_key:
            raise Conflict409("The source avatar is not a photo", code="not_a_photo")
    if not imagegen.configured():
        raise Conflict409(
            "Image generation is not configured on this server", code="imagegen_unavailable"
        )
    await check_draft_limit(db, org.id)
    await check_image_limit(db, org.id)

    creation_id = new_id()
    job = runner.reserve(org.id, creation_id, "generate", 0)
    params = {
        "style": wizard.STYLE_OF_LOOK[plan["look"]] if plan else body.style,
        "prompt": body.prompt,
        "source_avatar_id": body.source_avatar_id,
        # What a retry checks again: sending the source photo out needs the
        # retrying member's own consent under the current wording. With a
        # plan, it also lets the job ask the vision model for the points of
        # a face the detector cannot see.
        "consent_id": consent_ids[0] if consent_ids else None,
    }
    try:
        creation = Creation(
            id=creation_id,
            org_id=org.id,
            created_by_id=user_id,
            face_type=face_type,
            status=CreationStatus.draft,
            revision=0,
            steps=steps,
            consent_ids=consent_ids or None,
            job=job_record(job, QUEUED, params),
        )
        db.add(creation)
        await db.commit()
    except BaseException:
        runner.release(job)
        raise
    launch(job, params)
    return creation
