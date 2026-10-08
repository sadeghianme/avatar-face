"""The photographic mouth: the owner's teeth photo, and the AI mouth kit."""

from __future__ import annotations

from fastapi import UploadFile
from starlette.concurrency import run_in_threadpool

from app.api.avatars.routing import one_edit_at_a_time, router
from app.api.deps import DB, OrgMember
from app.core.config import get_settings
from app.core.errors import Validation422
from app.models import Avatar
from app.schemas.avatar import AvatarOut, MouthKitOut, MouthKitRequest
from app.schemas.job import JobOut
from app.services import mouth_kit, mouth_photo
from app.services.avatars import mouth_edits, repo
from app.services.portrait_photo import MAX_BYTES


@router.post("/{avatar_id}/mouth-photo", response_model=AvatarOut)
@one_edit_at_a_time
async def upload_mouth_photo(avatar_id: str, file: UploadFile, ctx: OrgMember, db: DB) -> Avatar:
    """A second photo of the same person with teeth showing.

    It supplies THEIR enamel to the continuous mouth instead of the
    standard teeth. Validated exactly as in the lab it graduated from (a real
    detected face, large enough, mouth actually open) and by the browser's
    own teeth test (422 mouth_teeth_unclear: the upper row too small, or
    only its tips), through services.mouth_photo, the path AI-made teeth
    take too. A draft edit like any other — visitors see it only after
    Publish.
    """
    avatar = await repo.require_in_org(db, ctx.org.id, avatar_id)
    mouth_edits.require_teeth_photo_allowed(avatar)
    if file.content_type not in get_settings().allowed_image_types:
        raise Validation422("Choose a JPEG, PNG or WebP photo", code="unsupported_image_type")
    data = await file.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise Validation422("Photo must be 15 MB or smaller", code="image_too_large")
    photo, rig = await run_in_threadpool(mouth_photo.prepare_mouth_photo, data)
    await mouth_edits.set_mouth_photo(db, avatar, photo, rig)
    return avatar


@router.post("/{avatar_id}/mouth-kit", response_model=MouthKitOut, status_code=202)
async def make_mouth_kit(
    avatar_id: str, body: MouthKitRequest, ctx: OrgMember, db: DB
) -> MouthKitOut:
    """Make the person's mouth shapes and teeth from this photo: the Mouth
    panel's one AI action, what finishing a person now does (the
    performance kit, services.mouth_kit), for avatars made before it, or
    whose kit could not be made then, or whose picture changed since.

    A job (202, `job`), followed with GET below: seven image-model calls
    (a shape per speech sound and the teeth photo) take tens of seconds,
    longer than a request may wait behind the proxy. 409
    mouth_kit_in_progress while one runs for this avatar (and the runner's
    429 too_many_jobs, 503 job_queue_full). Needs the caller's
    third_party_ai consent (403 consent_required) and the organization's
    switch on (403 third_party_ai_disabled); metered against the monthly
    image limit (429 image_limit_reached, and read again before each call).
    Teeth the owner uploaded are kept: the kit then asks for and brings
    its six shapes only. A DRAFT edit: visitors get the new mouth, and the
    disclosure that AI made it, when the owner publishes.
    """
    avatar = await repo.require_in_org(db, ctx.org.id, avatar_id)
    job = await mouth_edits.start_mouth_kit(
        db, avatar, ctx.org, ctx.membership.user_id, body.consent_id
    )
    return MouthKitOut(job=JobOut(**job))


@router.get("/{avatar_id}/mouth-kit", response_model=MouthKitOut)
async def mouth_kit_job(avatar_id: str, ctx: OrgMember, db: DB) -> MouthKitOut:
    """The avatar's mouth-kit job: its progress while it runs ("making the
    mouth shapes", with how many of its requests are settled (seven, or
    six when the owner's own teeth are kept), "fitting the
    mouth", "saving"; "making the teeth" where only the teeth can be made),
    then done or failed with the reason. Null when this server ran none for
    it (a restart forgets jobs). Once done, the avatar's draft has it."""
    await repo.require_in_org(db, ctx.org.id, avatar_id)
    view = mouth_kit.job_view(avatar_id)
    return MouthKitOut(job=JobOut(**view) if view else None)


@router.delete("/{avatar_id}/mouth-photo", response_model=AvatarOut)
@one_edit_at_a_time
async def remove_mouth_photo(avatar_id: str, ctx: OrgMember, db: DB) -> Avatar:
    """Back to the standard teeth (the Reference's own teeth photo, which
    every mouth without a photo of its own draws). The published snapshot
    keeps its own copy."""
    avatar = await repo.require_in_org(db, ctx.org.id, avatar_id)
    await mouth_edits.remove_mouth_photo(db, avatar)
    return avatar
