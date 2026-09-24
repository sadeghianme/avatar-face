"""The creation wizard: upload, frame, background, points, finish.

Heavy work (ingest, background removal, detection, finishing) is a job
(services.jobs): the route validates, admits the job and answers 202 with
the creation, and the client follows `job` on GET until it is done. The
rest answers at once.

Every query filters on the creation id AND the org from the path, so another
org's creation id is simply not found. Clients name images by step id
("original", "framed", "cutout"), never by storage key.

The staging routes (api.staging) and /avatars/from-candidate still serve
generation, AI restyle and the stock gallery until those become creations
too (M4); nothing here calls them.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Annotated

from fastapi import APIRouter, Form, Response, UploadFile
from sqlalchemy import func, select, update

from app.api.deps import DB, OrgMember
from app.core.config import get_settings
from app.core.errors import Conflict409, NotFound404, Validation422
from app.models import Avatar, AvatarKind, AvatarStatus, Creation, CreationStatus
from app.models.base import new_id
from app.schemas.avatar import FaceType, FitReason
from app.schemas.creation import (
    AnchorsOut,
    BackgroundOffer,
    BackgroundRequest,
    ChooseRequest,
    CreationMarks,
    CreationOut,
    CreationStatusName,
    CreationUpdate,
    FinishOut,
    FinishRequest,
    JobOut,
    PreviewRigOut,
    PreviewRigRequest,
    StepOut,
)
from app.services import creations as svc
from app.services.jobs import ACTIVE_STATES, FAILED, INTERRUPTED, QUEUED, run_cpu, runner
from app.services.storage import get_storage

logger = logging.getLogger("liveface.creations")
router = APIRouter(prefix="/orgs/{org_id}/creations", tags=["creations"])

LIST_LIMIT = 50


# --- Loading and checks ---------------------------------------------------------


async def _get(db: DB, org_id: str, creation_id: str) -> Creation:
    creation = (
        await db.execute(
            select(Creation)
            .where(Creation.id == creation_id, Creation.org_id == org_id)
            # Always the row as stored: updates here are statements, not
            # attribute edits, and the identity map would otherwise answer
            # with what this session saw before them.
            .execution_options(populate_existing=True)
        )
    ).scalar_one_or_none()
    if creation is None:
        raise NotFound404("Creation not found", code="creation_not_found")
    return creation


def _require_draft(creation: Creation) -> None:
    if creation.status != CreationStatus.draft:
        raise Conflict409(
            f"This creation is {creation.status.value} and can no longer change",
            code="creation_not_draft",
        )


def _require_image(creation: Creation) -> None:
    if "original" not in svc.step_items(creation.steps):
        raise Conflict409("The photo is still being prepared", code="creation_not_ready")


def _require_face_type(creation: Creation) -> str:
    if creation.face_type is None:
        raise Validation422(
            "Choose whether this is a person, an animal or an animation first",
            code="face_type_required",
        )
    return creation.face_type


async def _update(db: DB, creation: Creation, **values) -> None:
    """A content change: bumps the revision, and applies only to the state
    the caller read. A concurrent change wins; this one is refused."""
    result = await db.execute(
        update(Creation)
        .where(
            Creation.id == creation.id,
            Creation.org_id == creation.org_id,
            Creation.revision == creation.revision,
            Creation.status == CreationStatus.draft,
        )
        .values(**values, revision=Creation.revision + 1)
    )
    if result.rowcount != 1:
        await db.rollback()
        raise Conflict409("The creation changed; reload it", code="creation_changed")
    await db.commit()


def _check_marks(marks: CreationMarks | None, face_type: str, size: list[int]) -> dict | None:
    """The marks as a dict, refused where the line or the image rules them
    out (the same refusals as the avatar rig-fit endpoint)."""
    from app.services.anchor_fit import marks_mouth_as_line

    if marks is None:
        return None
    data = marks.model_dump(exclude_none=True)
    if ("mouth_line" in data or "chin" in data) and not marks_mouth_as_line(face_type):
        raise Validation422(
            "A human mouth is marked by its edges, not as a line with a chin",
            code="mouth_line_not_for_face_type",
        )
    width, height = size

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

    if any(not (0 <= p["x"] <= width and 0 <= p["y"] <= height) for p in points(data)):
        raise Validation422("Every mark must be inside the image", code="mark_outside_image")
    return data


def _anchors_for(creation: Creation, anchors_id: str) -> dict:
    # No anchors at all is stale too: the client holds an id, so it placed
    # marks on something that has since been cleared (reframed, line switched).
    anchors = creation.anchors
    if not anchors or anchors.get("id") != anchors_id or not svc.anchors_are_current(creation):
        raise Conflict409(
            "These marks belong to another image; place them again", code="anchors_stale"
        )
    return anchors


# --- Output ---------------------------------------------------------------------


def _job_out(record: dict | None) -> JobOut | None:
    if not record:
        return None
    live = runner.get(record.get("id"))
    return JobOut(
        id=record["id"],
        step=record["step"],
        state=record["state"],
        error=record.get("error"),
        started_at=record["started_at"],
        progress=live.progress() if live and record["state"] in ACTIVE_STATES else None,
        retryable=record["state"] in (FAILED, INTERRUPTED)
        and (record.get("error") or {}).get("code") not in NOT_RETRYABLE,
    )


# A retry would fail the same way: the file, the marks or the line is the
# problem, and only the owner can change it.
NOT_RETRYABLE = frozenset(
    {"unreadable_image", "image_too_large", "anchors_stale", "fit_invalid"}
)


def _background_offer(creation: Creation) -> BackgroundOffer:
    if creation.face_type is None:
        return BackgroundOffer(available=False, reason="face_type_required")
    if not svc.rules_for(creation.face_type).background_removal:
        return BackgroundOffer(available=False, reason="not_for_face_type")
    if not get_settings().segment_model_path:
        return BackgroundOffer(available=False, reason="segmentation_unavailable")
    return BackgroundOffer(available=True)


async def _out(creation: Creation) -> CreationOut:
    storage = get_storage()
    items = svc.step_items(creation.steps)
    steps = [
        StepOut(
            id=step_id,
            url=await storage.presign_get(items[step_id]["key"]),
            width=items[step_id]["width"],
            height=items[step_id]["height"],
            from_=items[step_id].get("from"),
            crop=items[step_id].get("crop"),
            roll=items[step_id].get("roll"),
        )
        for step_id in svc.STEP_ORDER
        if step_id in items
    ]
    anchors = None
    if creation.anchors:
        frame = creation.anchors.get("frame")
        anchors = AnchorsOut(
            id=creation.anchors["id"],
            image=next((s for s, item in items.items() if item["key"] == frame), None),
            image_size=creation.anchors["image_size"],
            detected=bool(creation.anchors.get("detected")),
            marks=creation.anchors.get("marks") or {},
            validation=creation.anchors["validation"],
        )
    return CreationOut(
        id=creation.id,
        face_type=creation.face_type,
        status=creation.status.value,
        revision=creation.revision,
        current=svc.current_step(creation.steps),
        steps=steps,
        analysis=creation.analysis,
        anchors=anchors,
        job=_job_out(creation.job),
        avatar_id=creation.avatar_id,
        background_removal=_background_offer(creation),
        created_at=creation.created_at,
        updated_at=creation.updated_at,
    )


async def _reloaded(db: DB, creation: Creation) -> CreationOut:
    return await _out(await _get(db, creation.org_id, creation.id))


# --- Routes -----------------------------------------------------------------------


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


@router.post("", response_model=CreationOut, status_code=202)
async def create_creation(
    file: UploadFile,
    ctx: OrgMember,
    db: DB,
    face_type: Annotated[FaceType | None, Form()] = None,
) -> CreationOut:
    """Upload a photo and start a creation.

    Refusals that need no decoding happen here (type, size, the draft limit,
    the job admission, the header's pixel count); the decode, clean-up and
    analysis run as the creation's first job.
    """
    settings = get_settings()
    if file.content_type not in settings.allowed_image_types:
        raise Validation422("Choose a JPEG, PNG or WebP photo", code="unsupported_image_type")
    data = await file.read(svc.MAX_UPLOAD_BYTES + 1)
    if len(data) > svc.MAX_UPLOAD_BYTES:
        raise Validation422("Photo must be 15 MB or smaller", code="image_too_large")

    # A soft limit: two uploads racing past it make eleven, which is fine.
    drafts = (
        await db.execute(
            select(func.count())
            .select_from(Creation)
            .where(Creation.org_id == ctx.org.id, Creation.status == CreationStatus.draft)
        )
    ).scalar_one()
    if drafts >= svc.MAX_DRAFTS_PER_ORG:
        raise Conflict409(
            f"You have {drafts} unfinished avatars; finish or delete one first",
            code="too_many_drafts",
        )

    creation_id = new_id()
    # Admitted before the header is read, so the per-org cap (429) and the
    # queue cap (503) bound how many probes can run at once, not only how
    # many jobs.
    job = runner.reserve(ctx.org.id, creation_id, "ingest", 0)
    storage = get_storage()
    incoming = svc.incoming_key(ctx.org.id, creation_id)
    try:
        await _probe(data)
        await storage.put_bytes(incoming, data, file.content_type or "application/octet-stream")
        creation = Creation(
            id=creation_id,
            org_id=ctx.org.id,
            created_by_id=ctx.membership.user_id,
            face_type=face_type,
            status=CreationStatus.draft,
            revision=0,
            job=svc.job_record(job, QUEUED, {}),
        )
        db.add(creation)
        await db.commit()
    except BaseException:
        runner.release(job)
        await storage.delete(incoming)
        raise
    svc.launch(job, {})
    return await _reloaded(db, creation)


@router.get("", response_model=list[CreationOut])
async def list_creations(
    ctx: OrgMember, db: DB, status: CreationStatusName | None = None
) -> list[CreationOut]:
    """Newest activity first. `?status=draft` is the resume list."""
    query = select(Creation).where(Creation.org_id == ctx.org.id)
    if status is not None:
        query = query.where(Creation.status == CreationStatus(status))
    rows = (
        await db.execute(query.order_by(Creation.updated_at.desc()).limit(LIST_LIMIT))
    ).scalars().all()
    return [await _out(creation) for creation in rows]


@router.get("/{creation_id}", response_model=CreationOut)
async def get_creation(creation_id: str, ctx: OrgMember, db: DB) -> CreationOut:
    return await _out(await _get(db, ctx.org.id, creation_id))


@router.patch("/{creation_id}", response_model=CreationOut)
async def update_creation(
    creation_id: str, body: CreationUpdate, ctx: OrgMember, db: DB
) -> CreationOut:
    """Switch the line, or frame the photo.

    Framing is a new step made from the original, never an edit of it.
    Either change invalidates what was made after it: the cut-out (made
    from the old frame, or by the old line's segmenter) and the marks.
    """
    from app.services.photo_io import frame_photo, png_bytes

    creation = await _get(db, ctx.org.id, creation_id)
    _require_draft(creation)
    _require_image(creation)
    steps = svc.copied(creation.steps)
    items = steps["items"]
    changed = False
    clear_anchors = False
    new_keys: list[str] = []
    old_keys: list[str] = []

    if body.crop is not None or body.roll is not None:
        previous = items.get("framed")
        crop = body.crop.model_dump() if body.crop else (previous or {}).get("crop", svc.FULL_FRAME)
        roll = body.roll if body.roll is not None else (previous or {}).get("roll", 0.0)
        if crop["x"] + crop["w"] > 1.0 + 1e-6 or crop["y"] + crop["h"] > 1.0 + 1e-6:
            raise Validation422("The crop falls outside the photo", code="crop_out_of_bounds")
        if crop["w"] < svc.MIN_CROP_FRACTION or crop["h"] < svc.MIN_CROP_FRACTION:
            raise Validation422(
                f"The crop must keep at least {int(svc.MIN_CROP_FRACTION * 100)}% of each side",
                code="crop_too_small",
            )
        unframed = crop == svc.FULL_FRAME and not roll
        if previous and previous.get("crop") == crop and previous.get("roll") == roll:
            pass  # the framing it already has
        elif unframed and previous is None:
            pass  # never framed, and still not
        else:
            changed = clear_anchors = True
            cutout = svc.drop_cutout(steps)
            if cutout:
                old_keys.append(cutout)
            if previous:
                old_keys.append(items.pop("framed")["key"])
            if unframed:
                # Framing back to the whole, level photo IS the original.
                steps["current"] = "original"
            else:
                original = await get_storage().get_bytes(items["original"]["key"])

                def frame() -> tuple[bytes, tuple[int, int]]:
                    image = frame_photo(original, crop, roll)
                    return png_bytes(image), image.size

                data, (width, height) = await run_cpu(frame)
                key = svc.step_key(creation.org_id, creation.id, "framed")
                await get_storage().put_bytes(key, data, "image/png")
                new_keys.append(key)
                items["framed"] = {
                    "key": key, "width": width, "height": height, "from": "original",
                    "crop": crop, "roll": roll,
                }
                steps["current"] = "framed"

    values: dict = {}
    if body.face_type is not None and body.face_type != creation.face_type:
        changed = clear_anchors = True
        values["face_type"] = body.face_type
        # Cut out by the old line's segmenter (or offered to it): gone.
        cutout = svc.drop_cutout(steps)
        if cutout:
            old_keys.append(cutout)

    if not changed:
        return await _out(creation)
    if clear_anchors:
        values["anchors"] = None
    storage = get_storage()
    try:
        await _update(db, creation, steps=steps, **values)
    except Conflict409:
        for key in new_keys:
            await storage.delete(key)
        raise
    for key in old_keys:
        await storage.delete(key)
    return await _reloaded(db, creation)


@router.post("/{creation_id}/choose", response_model=CreationOut)
async def choose_step(
    creation_id: str, body: ChooseRequest, ctx: OrgMember, db: DB
) -> CreationOut:
    """Make one of the step outputs the current image. Marks placed on
    another pixel frame are cleared; an image and its cut-out share one."""
    creation = await _get(db, ctx.org.id, creation_id)
    _require_draft(creation)
    _require_image(creation)
    if body.choice not in svc.step_items(creation.steps):
        raise Validation422("There is no such image to choose", code="unknown_choice")
    if body.choice == svc.current_step(creation.steps):
        return await _out(creation)
    steps = svc.copied(creation.steps)
    steps["current"] = body.choice
    values: dict = {"steps": steps}
    anchors = creation.anchors
    if anchors and anchors.get("frame") != svc.frame_key(steps, body.choice):
        values["anchors"] = None
    await _update(db, creation, **values)
    return await _reloaded(db, creation)


async def _start_background(db: DB, creation: Creation, mode: str) -> tuple[CreationOut, int]:
    _require_draft(creation)
    _require_image(creation)
    face_type = _require_face_type(creation)
    source = svc.background_source(creation.steps)
    current = svc.current_step(creation.steps)
    cutout = svc.step_items(creation.steps).get("cutout")
    if mode == "keep":
        # Nothing to compute: the image the cut-out would come from is the
        # answer. The cut-out, if any, stays choosable.
        if current != source:
            steps = svc.copied(creation.steps)
            steps["current"] = source
            await _update(db, creation, steps=steps)
        return await _reloaded(db, creation), 200

    if not svc.rules_for(face_type).background_removal:
        raise Validation422(
            "Background removal only understands people so far; keep the background "
            "for animals and animations",
            code="background_not_for_face_type",
        )
    if cutout and cutout.get("from") == source:
        # Already cut from this image: choosing it is enough.
        if current != "cutout":
            steps = svc.copied(creation.steps)
            steps["current"] = "cutout"
            await _update(db, creation, steps=steps)
        return await _reloaded(db, creation), 200
    if not get_settings().segment_model_path:
        raise Conflict409(
            "Background removal is not configured on this server",
            code="segmentation_unavailable",
        )
    await svc.start_job(db, creation, "background", {"source": source})
    return await _reloaded(db, creation), 202


@router.post("/{creation_id}/background", response_model=CreationOut)
async def set_background(
    creation_id: str, body: BackgroundRequest, ctx: OrgMember, db: DB, response: Response
) -> CreationOut:
    """Remove the background (a job: 202), or keep it (200). Applies to the
    current image, or to the one a current cut-out was made from. Marks
    survive either way: no pixel moves."""
    creation = await _get(db, ctx.org.id, creation_id)
    out, status = await _start_background(db, creation, body.mode)
    response.status_code = status
    return out


async def _start_detect(db: DB, creation: Creation) -> CreationOut:
    _require_draft(creation)
    _require_image(creation)
    _require_face_type(creation)
    await svc.start_job(db, creation, "detect", {})
    return await _reloaded(db, creation)


@router.post("/{creation_id}/detect", response_model=CreationOut, status_code=202)
async def detect_face(creation_id: str, ctx: OrgMember, db: DB) -> CreationOut:
    """Find the face on the current image (the line's detector, else the
    face template) and open the marks on it, with the validator's verdict."""
    return await _start_detect(db, await _get(db, ctx.org.id, creation_id))


@router.post("/{creation_id}/preview-rig", response_model=PreviewRigOut)
async def preview_rig(
    creation_id: str, body: PreviewRigRequest, ctx: OrgMember, db: DB
) -> PreviewRigOut:
    """The rig finish would build from these marks, with the validator's
    reasons. Nothing is saved.

    Computed inline rather than as a job: a fit is tens of milliseconds, the
    same call the avatar rig-fit preview makes on every drag, and queueing it
    behind someone's background removal would make the handles lag.
    """
    creation = await _get(db, ctx.org.id, creation_id)
    _require_draft(creation)
    face_type = _require_face_type(creation)
    anchors = _anchors_for(creation, body.anchors_id)
    marks = _check_marks(body.marks, face_type, anchors["image_size"])
    rig, problems = svc.fit_from_anchors(anchors, marks, face_type)
    return PreviewRigOut(
        rig=rig,
        reasons=[FitReason(code=p.code, detail=p.detail, count=p.count) for p in problems],
    )


async def _idempotent_finish(db: DB, creation: Creation) -> FinishOut | None:
    ended = creation.status in (CreationStatus.finishing, CreationStatus.finished)
    if ended and creation.avatar_id:
        return FinishOut(avatar_id=creation.avatar_id, creation=await _out(creation))
    return None


async def _start_finish(
    db: DB, creation: Creation, body: FinishRequest, user_id: str
) -> FinishOut:
    repeated = await _idempotent_finish(db, creation)
    if repeated:
        return repeated
    _require_draft(creation)
    _require_image(creation)
    face_type = _require_face_type(creation)
    anchors = _anchors_for(creation, body.anchors_id)
    marks = _check_marks(body.marks, face_type, anchors["image_size"])
    required = svc.required_marks(face_type, bool(anchors.get("detected")))
    missing = [name for name in required if name not in (marks or {})]
    if missing:
        raise Validation422(
            "These points were placed on a guess, not found on the face: place each "
            "one by hand before saving",
            code="marks_required",
            extra={"missing": missing},
        )
    _, problems = svc.fit_from_anchors(anchors, marks, face_type)
    if problems:
        reasons = [FitReason(code=p.code, detail=p.detail, count=p.count) for p in problems]
        raise Validation422(
            "These marks would distort the face: " + "; ".join(r.detail for r in reasons),
            code="fit_invalid",
            extra={"reasons": [r.model_dump() for r in reasons]},
        )

    avatar = Avatar(
        id=new_id(),
        org_id=creation.org_id,
        created_by_id=user_id,
        name=body.name,
        kind=AvatarKind.photo,
        content_type="image/png",
        face_type=face_type,
        status=AvatarStatus.processing,
    )
    db.add(avatar)
    params = {"name": body.name, "anchors_id": body.anchors_id, "marks": marks}
    try:
        await svc.start_job(
            db,
            creation,
            "finish",
            params,
            values={"status": CreationStatus.finishing, "avatar_id": avatar.id},
        )
    except Conflict409:
        # Drops the pending avatar, which the query below would otherwise
        # flush into the table.
        await db.rollback()
        # A second Finish racing the first: answer with the first's avatar
        # once it is recorded, rather than an error the owner did not cause.
        repeated = await _idempotent_finish(db, await _get(db, creation.org_id, creation.id))
        if repeated:
            return repeated
        raise
    creation = await _get(db, creation.org_id, creation.id)
    return FinishOut(avatar_id=avatar.id, creation=await _out(creation))


@router.post("/{creation_id}/finish", response_model=FinishOut, status_code=202)
async def finish_creation(
    creation_id: str, body: FinishRequest, ctx: OrgMember, db: DB
) -> FinishOut:
    """Build the avatar from the confirmed marks and publish it.

    Pressing Finish is the owner confirming the points, so the avatar goes
    live. The creation moves draft → finishing once (atomically); pressing
    again answers with the same avatar id. Marks placed on another image are
    refused (409 anchors_stale), as is a fit that would fold (422 with the
    reasons). Follow the creation until `status` is finished; if the job
    fails the creation is a draft again and Finish can be pressed again.
    """
    creation = await _get(db, ctx.org.id, creation_id)
    return await _start_finish(db, creation, body, ctx.membership.user_id)


@router.post("/{creation_id}/retry", response_model=CreationOut, status_code=202)
async def retry_job(creation_id: str, ctx: OrgMember, db: DB) -> CreationOut:
    """Run a failed or interrupted job again, with what it was given."""
    creation = await _get(db, ctx.org.id, creation_id)
    record = creation.job or {}
    job = _job_out(record)
    if job is None or not job.retryable:
        raise Conflict409("There is nothing to retry", code="nothing_to_retry")
    params = record.get("params") or {}
    if job.step == "ingest":
        _require_draft(creation)
        if "original" in svc.step_items(creation.steps):
            raise Conflict409("There is nothing to retry", code="nothing_to_retry")
        if not await get_storage().exists(svc.incoming_key(creation.org_id, creation.id)):
            raise Conflict409("The upload is gone; upload the photo again", code="upload_gone")
        await svc.start_job(db, creation, "ingest", {})
        return await _reloaded(db, creation)
    if job.step == "background":
        return (await _start_background(db, creation, "remove"))[0]
    if job.step == "detect":
        return await _start_detect(db, creation)
    finish = FinishRequest(
        name=params.get("name") or "Avatar",
        anchors_id=params.get("anchors_id") or "",
        marks=params.get("marks"),
    )
    return (await _start_finish(db, creation, finish, ctx.membership.user_id)).creation


@router.delete("/{creation_id}", status_code=204)
async def delete_creation(creation_id: str, ctx: OrgMember, db: DB) -> Response:
    """Delete the creation and its files now. A job still running for it
    finds the row gone and throws its result away.

    Files first: the row is the only thing that leads anyone (the owner, the
    expiry sweep) back to them. Deleted after the row, a failed delete would
    orphan the photos for good, the raw upload with its EXIF included; this
    way it fails the request with the row intact, and pressing Delete again
    (or expiry) finishes the job.
    """
    creation = await _get(db, ctx.org.id, creation_id)
    if creation.status == CreationStatus.finishing:
        raise Conflict409(
            "The avatar is being built from this; wait a moment", code="creation_finishing"
        )
    storage = get_storage()
    prefix = svc.creation_prefix(ctx.org.id, creation_id)
    await storage.delete_prefix(prefix)
    await db.delete(creation)
    await db.commit()
    # Once more, for a job that stored its result between the first pass and
    # the commit. A job storing after the commit finds no row and deletes its
    # own file, so this pass is tidying only; a failure here is not the
    # owner's problem.
    try:
        await storage.delete_prefix(prefix)
    except Exception:
        logger.exception("second file pass failed for deleted creation %s", creation_id)
    return Response(status_code=204)
