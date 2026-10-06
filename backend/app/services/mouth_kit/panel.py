"""The Mouth panel's job: a kit made for an existing avatar, followed by
the panel until it ends (the last end of each avatar is kept here, in
this process)."""

from __future__ import annotations

import json
import logging
from collections import OrderedDict

from app.core.errors import AppError, Conflict409, Forbidden403, NotFound404
from app.services import imagegen, mouth, performance_kit
from app.services.jobs import DONE, FAILED, QUEUED, Job, run_cpu, runner
from app.services.mouth_kit.calls import (
    FIT_LABEL,
    SAVE_LABEL,
    SHAPE_COUNT,
    SHAPES_LABEL,
    TEETH_LABEL,
    _note,
    generated_count,
    make,
    progress_to,
)
from app.services.mouth_kit.records import _TEETH_NOTE_CODES
from app.services.mouth_kit.storing import _load_avatar, store

logger = logging.getLogger("liveface.mouth_kit")


JOB_STEP = "mouth_kit"
# The last kit job of each avatar that ended in this process, for the
# panel to learn how it ended (GET /avatars/{id}/mouth-kit). Progress lives
# in memory like every job's (services.jobs); what a job leaves is in the
# draft. A restart forgets both, and the panel, holding the job id it
# started, reads a record that is not its job's as "interrupted".
_ended: OrderedDict[str, dict] = OrderedDict()
ENDED_KEPT = 256

# A failure asking again would repeat, until something changes.
NOT_RETRYABLE = frozenset({
    "third_party_ai_disabled", "imagegen_unavailable", "landmarks_unavailable",
    "mouth_not_for_face_type", "not_a_photo", "source_gone", "avatar_not_found",
    "safety_refused", "image_limit_reached",
})


def _job_out(job: Job, state: str, error: dict | None = None) -> dict:
    """A job as JobOut shows it (schemas.creation)."""
    active = state not in (DONE, FAILED)
    return {
        "id": job.id,
        "step": JOB_STEP,
        "state": state,
        "error": error,
        "started_at": job.started_at,
        "progress": job.progress() if active else None,
        "retryable": state == FAILED and (error or {}).get("code") not in NOT_RETRYABLE,
    }


def job_view(avatar_id: str) -> dict | None:
    """The avatar's kit job: live while it is queued or running, then how
    it ended, or None when this process ran none for it."""
    live = runner.active_for(avatar_id)
    if live is not None and live.step == JOB_STEP:
        return _job_out(live, live.state)
    return _ended.get(avatar_id)


def _end(job: Job, state: str, error: dict | None = None) -> None:
    _ended[job.subject_id] = _job_out(job, state, error)
    _ended.move_to_end(job.subject_id)
    while len(_ended) > ENDED_KEPT:
        _ended.popitem(last=False)


def start(avatar, consent_id: str) -> dict:
    """Admit and launch the avatar's kit job (runner.reserve: 409, 429 or
    503 as for any job), on `consent_id` (checked by the caller). Returns
    its JobOut."""
    if runner.active_for(avatar.id) is not None:
        raise Conflict409(
            "The mouth is already being made for this avatar; wait for it to finish",
            code="mouth_kit_in_progress",
        )
    job = runner.reserve(avatar.org_id, avatar.id, JOB_STEP, 0)
    params = {"consent_id": consent_id}
    _ended.pop(avatar.id, None)
    runner.start(job, lambda j: _run(j, params))
    return _job_out(job, QUEUED)


async def _run(job: Job, params: dict) -> None:
    try:
        await _make_for_avatar(job, params)
    except AppError as exc:
        logger.info("mouth kit %s for avatar %s failed: %s", job.id, job.subject_id, exc.detail)
        _end(job, FAILED, {"code": exc.code, "detail": exc.detail})
    except Exception:
        # Broad on purpose: the job boundary; the panel is told it failed.
        logger.exception("mouth kit %s for avatar %s crashed", job.id, job.subject_id)
        _end(job, FAILED, {"code": "job_failed", "detail": "Something went wrong; try again"})
    else:
        _end(job, DONE)


def _require_person(avatar) -> None:
    """What the panel's action needs of the avatar, again at run time: a
    ready photo avatar of a person, with its picture and rig."""
    from app.core.errors import Validation422
    from app.models import AvatarKind, AvatarStatus

    if avatar is None:
        raise NotFound404("Avatar not found", code="avatar_not_found")
    if avatar.kind != AvatarKind.photo or avatar.status != AvatarStatus.ready:
        raise Conflict409("Only a ready photo avatar can take a mouth kit", code="not_a_photo")
    if not mouth.renderer_allowed("continuous", avatar.face_type):
        raise Validation422(
            "The photographic mouth draws human teeth, so it is only for human faces",
            code="mouth_not_for_face_type",
        )
    if not avatar.image_key or not avatar.rig_key:
        raise Conflict409("The avatar's picture is gone", code="source_gone")


async def _make_for_avatar(job: Job, params: dict) -> None:
    """The Mouth panel's action on an existing avatar: its kit, made from
    its picture and its rig as they are now, and stored as a draft edit
    (the owner publishes). Teeth the owner uploaded are kept, and not asked
    for. Where the kit cannot be made on this server, the single "ee" photo
    instead (unless the owner has their own teeth: then there is nothing it
    could bring). A kit with no shape of the person's own fails: the owner
    asked for their mouth shapes, and the draft keeps the ones it has."""
    from app.db import get_session_factory
    from app.services import consent
    from app.services.consent import ai_switched_off
    from app.services.edit_locks import avatar_edits
    from app.services.publishing import mark_dirty
    from app.services.storage import get_storage
    from app.services.usage import check_image_limit

    org_id, avatar_id, consent_id = job.org_id, job.subject_id, params["consent_id"]
    storage = get_storage()
    # Read again now: the job may have waited behind others.
    async with get_session_factory()() as db:
        avatar = await _load_avatar(db, org_id, avatar_id)
        _require_person(avatar)
        picture_key, rig_key = avatar.image_key, avatar.rig_key
        config = mouth.load(avatar.mouth_config) or {}
        own_teeth = bool(config.get("oral_image_key")) and (
            (config.get("teeth") or {}).get("source") or "upload"
        ) == "upload"
        if await ai_switched_off(org_id):
            raise Forbidden403(
                "Your organization turned off third-party AI, so nothing was sent",
                code="third_party_ai_disabled",
            )
        if not imagegen.configured():
            raise Conflict409(
                "AI editing is not configured on this server", code="imagegen_unavailable"
            )
        await check_image_limit(db, org_id)
    if not await storage.exists(picture_key) or not await storage.exists(rig_key):
        raise Conflict409("The avatar's picture is gone", code="source_gone")
    picture = await storage.get_bytes(picture_key)
    points = json.loads(await storage.get_bytes(rig_key)).get("points")

    async def sending() -> None:
        # The consent that lets the picture go is on the avatar as it goes:
        # a refusal or a rejected answer still sent a photo, and an audit
        # must find what allowed it. Not a change a visitor sees.
        async with avatar_edits.hold(avatar_id), get_session_factory()() as db:
            row = await _load_avatar(db, org_id, avatar_id)
            if row is not None:
                row.consent_ids = consent.with_consent(row.consent_ids, consent_id)
                await db.commit()

    job.report(0.05, SHAPES_LABEL, count=(0, SHAPE_COUNT + (0 if own_teeth else 1)))
    try:
        result = await make(
            org_id, picture, points, teeth=not own_teeth, job=job, on_first_send=sending,
            on_progress=progress_to(job, 0.05, 0.85),
        )
    except (performance_kit.KitUnavailable, ValueError) as exc:
        code = getattr(exc, "code", "kit_unavailable")
        if own_teeth:
            raise Conflict409(
                getattr(exc, "detail", None) or str(exc), code=code
            ) from exc
        logger.info("mouth kit %s: no kit on this server (%s); the teeth alone", job.id, code)
        await _teeth_alone(job, org_id, avatar_id, picture, sending)
        return
    if generated_count(result) == 0:
        # None of the person's own shapes: the owner's request failed, and
        # the draft keeps what it has (shapes of an earlier kit on this
        # face are better than none; its teeth, whatever came back).
        raise _nothing_made(result)

    job.report(0.88, FIT_LABEL)
    async with avatar_edits.hold(avatar_id), get_session_factory()() as db:
        avatar = await _load_avatar(db, org_id, avatar_id)
        if avatar is None:
            return
        _require_mouth(avatar)
        rig = json.loads(await storage.get_bytes(avatar.rig_key))
        if rig.get("points") != points or rig.get("image_size") != manifest_size(result):
            # Re-marked, re-detected or cropped meanwhile: the same face,
            # and the kit follows it (follow_points).
            result.manifest = await run_cpu(
                performance_kit.rebase_manifest, result.manifest, rig["points"], None,
                tuple(rig["image_size"]),
            )
        stale = await store(avatar, storage, result, source="mouth_panel")
        mark_dirty(avatar)
        await db.commit()
    job.report(1.0, SAVE_LABEL)
    for key in stale:
        await storage.delete(key)


def manifest_size(result: performance_kit.KitResult) -> list[int]:
    """The picture size a kit's manifest was made on."""
    return list(result.manifest["frame"]["image_size"])


def _require_mouth(avatar) -> None:
    """What storing a kit needs of the avatar, however long its calls took:
    a face the photographic mouth is for, with its picture and rig. Its
    picture may have been cropped meanwhile, or its points re-marked or
    re-detected: the kit follows the face, which is the same."""
    from app.core.errors import Validation422

    if not mouth.renderer_allowed("continuous", avatar.face_type):
        raise Validation422(
            "The photographic mouth draws human teeth, so it is only for human faces",
            code="mouth_not_for_face_type",
        )
    if not avatar.image_key or not avatar.rig_key:
        raise Conflict409("The avatar's picture is gone", code="source_gone")


def _nothing_made(result: performance_kit.KitResult) -> AppError:
    """The job's failure when the kit made none of the six shapes: why the
    calls stopped or were refused, else the first shape's reason (a check
    every answer failed)."""
    reasons = [reason for entry in result.report.values() if (reason := entry.get("reason"))]
    stopped = next((r for r in reasons if r["code"] in _TEETH_NOTE_CODES), None)
    reason = stopped or (reasons[0] if reasons else _note(
        "provider_error", "The AI service did not return an image"))
    return AppError(
        f"None of the mouth shapes could be made: {reason['detail']}", code=reason["code"]
    )


async def _teeth_alone(job: Job, org_id: str, avatar_id: str, picture: bytes, sending) -> None:
    """The single "ee" photo (mouth_photo.make_teeth), as a draft edit: what
    the panel can still make where the kit cannot be made. The photo is
    registered by its own landmarks, so whatever happened to the portrait
    meanwhile, it is the person's teeth."""
    from app.db import get_session_factory
    from app.services import mouth_photo
    from app.services.edit_locks import avatar_edits
    from app.services.publishing import mark_dirty
    from app.services.storage import get_storage

    storage = get_storage()
    job.report(0.1, TEETH_LABEL)
    try:
        async with runner.outside_slot(job):
            made = await mouth_photo.make_teeth(org_id, picture, on_send=sending)
    except mouth_photo.TeethFailure as exc:
        raise AppError(exc.detail, code=exc.code) from exc
    job.report(0.9, SAVE_LABEL)
    async with avatar_edits.hold(avatar_id), get_session_factory()() as db:
        avatar = await _load_avatar(db, org_id, avatar_id)
        if avatar is None:
            return
        _require_mouth(avatar)
        previous = await mouth_photo.store(
            avatar, storage, made.photo, made.rig, mouth_photo.ai_teeth_record(made.model)
        )
        avatar.ai_edited = mouth_photo.with_ai_teeth(avatar.ai_edited, made.model)
        mark_dirty(avatar)
        await db.commit()
    job.report(1.0, SAVE_LABEL)
    for key in previous:
        await storage.delete(key)
