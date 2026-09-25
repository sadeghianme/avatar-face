"""The creation wizard: upload or generate, frame, background, AI adjust,
points, finish (the owner's order, docs/avatar-lines.md "The creation flow").

Heavy work (ingest, generation, AI adjust, background removal, detection,
finishing) is a job (services.jobs): the route validates, admits the job and
answers 202 with the creation, and the client follows `job` on GET until it
is done. The rest answers at once.

Every query filters on the creation id AND the org from the path, so another
org's creation id is simply not found. Clients name images by step id
("original", "framed", "cutout", "adjusted:N", "cutout:N"), never by storage
key.

Step 3's recommendation (`analysis.recommendation`) is the photo check of
the CURRENT image on the creation's line, so it changes whenever the image
does: framing, removing the background of a new picture, choosing an AI
result or going back.

Every step that sends pixels to Google (adjust, AI points, generation from
a source photo) takes a third_party_ai consent id and is refused when the
organization has switched third-party AI off, and so is a retry of one (on
the retrying member's consent). Finishing takes the uploader's statement
`statement` names, made for this creation (services.consent): "depiction"
for a person's photo, whatever line it is on now, "generated_face" for a
face made from words.
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
from app.models import Avatar, AvatarKind, AvatarStatus, Creation, CreationStatus, Organization
from app.models.base import new_id
from app.schemas.avatar import FaceType, FitReason
from app.schemas.creation import (
    AdjustRequest,
    AdjustRoundOut,
    AiOut,
    AnchorsOut,
    AutoAdjustOut,
    BackgroundOffer,
    BackgroundRequest,
    ChooseRequest,
    CreationMarks,
    CreationOut,
    CreationStatusName,
    CreationUpdate,
    DetectRequest,
    FinishOut,
    FinishRequest,
    FinishWarning,
    GenerateCreationRequest,
    JobOut,
    PreviewRigOut,
    PreviewRigRequest,
    RetryRequest,
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
    {
        "unreadable_image", "image_too_large", "anchors_stale", "fit_invalid",
        # AI: a refusal is never asked again, and a photo the touch-up
        # cannot use stays unusable.
        "safety_refused", "face_turned", "no_face_for_touchup", "landmarks_unavailable",
        "imagegen_unavailable", "source_gone",
        # The organization turned third-party AI off while the job waited.
        "third_party_ai_disabled",
    }
)


def _background_offer(creation: Creation) -> BackgroundOffer:
    return _background_offer_for(creation.face_type)


def _background_offer_for(face_type: str | None) -> BackgroundOffer:
    if face_type is None:
        return BackgroundOffer(available=False, reason="face_type_required")
    if not svc.rules_for(face_type).background_removal:
        return BackgroundOffer(available=False, reason="not_for_face_type")
    if not get_settings().segment_model_path:
        return BackgroundOffer(available=False, reason="segmentation_unavailable")
    return BackgroundOffer(available=True)


def _ai_out(creation: Creation, org: Organization | None, recommendation: dict | None) -> AiOut:
    from app.services.photo_adjust import MODES_BY_LINE, ROUNDS_PER_CREATION

    usage = svc.ai_usage_of(creation)
    face_type = creation.face_type
    modes = list(MODES_BY_LINE.get(face_type, ())) if face_type else []
    # The recommended mode, pre-selected by the wizard; empty when the
    # photo needs nothing (AI stays available, never pushed).
    mode = (recommendation or {}).get("mode")
    suggested = [mode] if mode in modes else []
    last = usage.get("last_round")
    if last:
        # The round's source may have gone since (a stylised version taken
        # drops the cut-outs); the before shown beside the results is then
        # the image it was cut from.
        last = {**last, "source": svc.round_source(creation.steps, last)}
    enabled = bool(org.third_party_ai_enabled) if org is not None else True
    return AiOut(
        enabled=enabled,
        modes=modes,
        suggested=suggested,
        adjust_rounds_left=max(0, ROUNDS_PER_CREATION - usage["adjust_rounds"]),
        ai_detections_left=max(0, svc.AI_DETECTIONS_PER_CREATION - usage["detections"]),
        last_round=AdjustRoundOut(**last) if last and last["source"] else None,
        auto_adjust=_auto_adjust(creation) if enabled else None,
    )


def _auto_adjust(creation: Creation) -> AutoAdjustOut | None:
    """services.creations.auto_adjust_of, while nothing else runs and the
    server can make it."""
    from app.services import imagegen

    if (creation.job or {}).get("state") in ACTIVE_STATES or creation.status != CreationStatus.draft:
        return None
    offer = svc.auto_adjust_of(creation)
    if offer is None or not imagegen.configured():
        return None
    return AutoAdjustOut(**offer)


async def _out(db: DB, creation: Creation) -> CreationOut:
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
            adjust=items[step_id].get("adjust"),
            generated=items[step_id].get("generated"),
            cutout=svc.is_cut_out(items, step_id),
        )
        for step_id in svc.ordered_step_ids(items)
    ]
    recommendation = svc.recommendation_of(creation.steps, creation.face_type)
    analysis = None
    if creation.analysis is not None:
        analysis = {**creation.analysis, "recommendation": recommendation}
    anchors = None
    if creation.anchors:
        frame = creation.anchors.get("frame")
        anchors = AnchorsOut(
            id=creation.anchors["id"],
            source=creation.anchors.get("source"),
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
        analysis=analysis,
        anchors=anchors,
        job=_job_out(creation.job),
        avatar_id=creation.avatar_id,
        background_removal=_background_offer(creation),
        background=(creation.steps or {}).get("background"),
        # The org was loaded by the route's membership check, in this
        # session: this is an identity-map read, not a query.
        ai=_ai_out(creation, await db.get(Organization, creation.org_id), recommendation),
        statement=svc.statement_for(creation),
        created_at=creation.created_at,
        updated_at=creation.updated_at,
    )


async def _reloaded(db: DB, creation: Creation) -> CreationOut:
    return await _out(db, await _get(db, creation.org_id, creation.id))


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

    await _count_drafts(db, ctx.org.id)

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


async def _count_drafts(db: DB, org_id: str) -> None:
    # A soft limit: two requests racing past it make eleven, which is fine.
    drafts = (
        await db.execute(
            select(func.count())
            .select_from(Creation)
            .where(Creation.org_id == org_id, Creation.status == CreationStatus.draft)
        )
    ).scalar_one()
    if drafts >= svc.MAX_DRAFTS_PER_ORG:
        raise Conflict409(
            f"You have {drafts} unfinished avatars; finish or delete one first",
            code="too_many_drafts",
        )


@router.post("/generate", response_model=CreationOut, status_code=202)
async def generate_creation(
    body: GenerateCreationRequest, ctx: OrgMember, db: DB
) -> CreationOut:
    """Start a creation whose original is made by the image model (a job).

    The generated picture becomes the creation's "original" and the wizard
    continues from framing, exactly as for an upload: the same points, the
    same confirmation, the same consent at finish. Needs the organization's
    third-party AI switch on (403 third_party_ai_disabled). Starting from an
    existing avatar's photo (`source_avatar_id`) sends that photo to Google
    and needs a third_party_ai consent (403 consent_required). Metered
    against the monthly image limit (429). A safety refusal fails the job
    with code safety_refused, which is not retried.
    """
    from app.services import consent, imagegen
    from app.services.ai_models import PROVIDER
    from app.services.usage import check_image_limit

    consent.require_ai_enabled(ctx.org)
    consent_ids: list[str] = []
    if body.source_avatar_id or body.consent_id:
        agreed = await consent.require(
            db, body.consent_id, ctx.org, ctx.membership.user_id, consent.THIRD_PARTY_AI,
            PROVIDER,
        )
        consent_ids.append(agreed.id)
    if body.source_avatar_id:
        origin = (
            await db.execute(
                select(Avatar).where(
                    Avatar.id == body.source_avatar_id, Avatar.org_id == ctx.org.id
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
    await _count_drafts(db, ctx.org.id)
    await check_image_limit(db, ctx.org.id)

    creation_id = new_id()
    job = runner.reserve(ctx.org.id, creation_id, "generate", 0)
    params = {
        "style": body.style,
        "prompt": body.prompt,
        "source_avatar_id": body.source_avatar_id,
        # What a retry checks again: sending the source photo out needs the
        # retrying member's own consent under the current wording.
        "consent_id": consent_ids[0] if consent_ids else None,
    }
    try:
        creation = Creation(
            id=creation_id,
            org_id=ctx.org.id,
            created_by_id=ctx.membership.user_id,
            face_type=body.face_type,
            status=CreationStatus.draft,
            revision=0,
            consent_ids=consent_ids or None,
            job=svc.job_record(job, QUEUED, params),
        )
        db.add(creation)
        await db.commit()
    except BaseException:
        runner.release(job)
        raise
    svc.launch(job, params)
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
    return [await _out(db, creation) for creation in rows]


@router.get("/{creation_id}", response_model=CreationOut)
async def get_creation(creation_id: str, ctx: OrgMember, db: DB) -> CreationOut:
    return await _out(db, await _get(db, ctx.org.id, creation_id))


@router.patch("/{creation_id}", response_model=CreationOut)
async def update_creation(
    creation_id: str, body: CreationUpdate, ctx: OrgMember, db: DB
) -> CreationOut:
    """Switch the line, or frame the photo.

    Framing is a new step made from the original, never an edit of it, with
    its own photo check. Either change invalidates what was made after it:
    the cut-outs (made from the old frame, or by the old line's segmenter),
    the AI results (made from the old frame) and the marks.
    """
    from app.services.photo_analysis import check_photo
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
            old_keys.extend(svc.drop_cutouts(steps))
            # AI candidates were made from the old frame: a new frame is a
            # new photo to adjust. (The rounds they cost stay spent.)
            old_keys.extend(svc.drop_adjusted(steps))
            if previous:
                old_keys.append(items.pop("framed")["key"])
            if unframed:
                # Framing back to the whole, level photo IS the original.
                steps["current"] = "original"
            else:
                original = await get_storage().get_bytes(items["original"]["key"])

                def frame() -> tuple[bytes, tuple[int, int], dict]:
                    image = frame_photo(original, crop, roll)
                    return png_bytes(image), image.size, svc.step_check(check_photo(image))

                data, (width, height), check = await run_cpu(frame)
                key = svc.step_key(creation.org_id, creation.id, "framed")
                await get_storage().put_bytes(key, data, "image/png")
                new_keys.append(key)
                items["framed"] = {
                    "key": key, "width": width, "height": height, "from": "original",
                    "crop": crop, "roll": roll, "check": check,
                }
                steps["current"] = "framed"

    values: dict = {}
    if body.face_type is not None and body.face_type != creation.face_type:
        changed = clear_anchors = True
        values["face_type"] = body.face_type
        # Cut out by the old line's segmenter (or offered to it): gone, and
        # the background is asked again for the new line.
        old_keys.extend(svc.drop_cutouts(steps))
        steps.pop("background", None)
        # The owner chose the line: going back from a stylised version no
        # longer restores the one it had before.
        steps.pop(svc.BEFORE_STYLISE, None)

    if not changed:
        return await _out(db, creation)
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
    creation_id: str, body: ChooseRequest, ctx: OrgMember, db: DB, response: Response
) -> CreationOut:
    """Make one of the step outputs the current image (200). Marks placed on
    another pixel frame are cleared: an AI result is new pixels, so points
    are found again; an image and its cut-out share one frame.

    An AI candidate that failed its checks is refused (422
    candidate_rejected). A regenerated picture comes back opaque: when the
    owner chose to remove the background, choosing it cuts it out as well,
    a background job (202) that makes "cutout:N" the current image (at once,
    200, if that cut-out exists already). Choosing a stylised candidate
    moves the creation to the animation line (face_type "cartoon"), whose
    background is kept. Nothing is ever chosen for the owner: the images
    before AI stay, and stay choosable.
    """
    creation = await _get(db, ctx.org.id, creation_id)
    _require_draft(creation)
    _require_image(creation)
    items = svc.step_items(creation.steps)
    item = items.get(body.choice)
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
    if body.choice == svc.current_step(creation.steps):
        return await _out(db, creation)
    steps = svc.copied(creation.steps)
    steps["current"] = body.choice
    values: dict = {"steps": steps}
    stale: list[str] = []
    chained: dict | None = None
    face_type = creation.face_type
    restored = False
    before = steps.get(svc.BEFORE_STYLISE)
    if adjust.get("mode") == "stylise" and face_type != "cartoon":
        # A stylised person is an animation now: rigged, marked and
        # rendered as one. The cut-outs belonged to the photo line, whose
        # segmenter the animation line does not use, so its backdrop (the
        # plain one the model drew) is kept. What the creation was before
        # is remembered, for going back to the photo.
        steps[svc.BEFORE_STYLISE] = {"face_type": face_type, "background": steps.get("background")}
        face_type = values["face_type"] = "cartoon"
        stale = svc.drop_cutouts(steps)
        steps["current"] = body.choice
        steps["background"] = "keep"
    elif before and face_type == "cartoon" and not svc.stylised(steps, body.choice):
        # Back from a stylised version to a picture that is not one ("Keep
        # my photo"): a person's photo is not rigged as a drawing, so the
        # line and the background answer it had before the stylise return.
        face_type = values["face_type"] = before.get("face_type") or "human"
        steps.pop(svc.BEFORE_STYLISE)
        if before.get("background"):
            steps["background"] = before["background"]
        else:
            steps.pop("background", None)
        restored = True
    if (
        (adjust or restored)
        and not svc.is_cut_out(items, steps["current"])
        and steps.get("background") == "remove"
    ):
        # An opaque AI result, or the photo whose cut-out the stylise
        # dropped, on a creation whose background comes off.
        cut = svc.cutout_id_for(steps["current"])
        if cut in items and items[cut].get("from") == steps["current"]:
            steps["current"] = cut
        elif _background_offer_for(face_type).available:
            chained = {"source": steps["current"]}
    anchors = creation.anchors
    if anchors and (
        face_type != creation.face_type
        or anchors.get("frame") != svc.frame_key(steps, steps["current"])
    ):
        values["anchors"] = None
    if chained is not None:
        # The choice and the job in one write: a refused admission (a job
        # already running, the queue full) leaves the choice unmade.
        await svc.start_job(db, creation, "background", chained, values=values, bump=True)
        response.status_code = 202
    else:
        await _update(db, creation, **values)
    for key in stale:
        await get_storage().delete(key)
    return await _reloaded(db, creation)


async def _start_background(db: DB, creation: Creation, mode: str) -> tuple[CreationOut, int]:
    """Step 2. The answer is remembered (`background`): choosing an AI result
    later follows it, cutting the new picture out when it is "remove"."""
    _require_draft(creation)
    _require_image(creation)
    face_type = _require_face_type(creation)
    items = svc.step_items(creation.steps)
    current = svc.current_step(creation.steps)
    chosen = (creation.steps or {}).get("background")
    if mode == "keep":
        # Nothing to compute: the opaque image behind the current one is
        # the answer. The cut-outs, if any, stay choosable.
        behind = svc.background_source(creation.steps)
        if current != behind or chosen != "keep":
            steps = svc.copied(creation.steps)
            steps["current"] = behind
            steps["background"] = "keep"
            await _update(db, creation, steps=steps)
        return await _reloaded(db, creation), 200

    if not svc.rules_for(face_type).background_removal:
        raise Validation422(
            "Background removal only understands people so far; keep the background "
            "for animals and animations",
            code="background_not_for_face_type",
        )
    if svc.is_cut_out(items, current):
        # Already a cut-out (a touch-up of one included): nothing to remove.
        if chosen != "remove":
            steps = svc.copied(creation.steps)
            steps["background"] = "remove"
            await _update(db, creation, steps=steps)
        return await _reloaded(db, creation), 200
    cut = svc.cutout_id_for(current)
    if cut in items and items[cut].get("from") == current:
        # Already cut from this image: choosing it is enough.
        steps = svc.copied(creation.steps)
        steps["current"] = cut
        steps["background"] = "remove"
        await _update(db, creation, steps=steps)
        return await _reloaded(db, creation), 200
    if not get_settings().segment_model_path:
        raise Conflict409(
            "Background removal is not configured on this server",
            code="segmentation_unavailable",
        )
    await svc.start_job(db, creation, "background", {"source": current})
    return await _reloaded(db, creation), 202


@router.post("/{creation_id}/background", response_model=CreationOut)
async def set_background(
    creation_id: str, body: BackgroundRequest, ctx: OrgMember, db: DB, response: Response
) -> CreationOut:
    """Remove the background of the current image (a job: 202; 200 when it
    is a cut-out already, or its cut-out exists), or keep it (200: back to
    the opaque image behind a current cut-out). The answer is remembered as
    `background`. Marks survive either way: no pixel moves."""
    creation = await _get(db, ctx.org.id, creation_id)
    out, status = await _start_background(db, creation, body.mode)
    response.status_code = status
    return out


async def _image_digest(creation: Creation) -> str:
    """SHA-256 of the current image's pixels file: the point finder's cache
    key. Hashed off the loop (a 2048 px PNG is several MB)."""
    import hashlib

    key = svc.step_items(creation.steps)[svc.current_step(creation.steps)]["key"]
    data = await get_storage().get_bytes(key)
    return await asyncio.to_thread(lambda: hashlib.sha256(data).hexdigest())


async def _start_detect(
    db: DB, creation: Creation, body: DetectRequest, org: Organization, user_id: str
) -> CreationOut:
    from app.services import consent, vision_points

    _require_draft(creation)
    _require_image(creation)
    face_type = _require_face_type(creation)
    params: dict = {"use_ai": body.use_ai}
    values: dict = {}
    if body.use_ai:
        if face_type == "human":
            raise Validation422(
                "People are found by the face detector; AI points are for animals and "
                "animations",
                code="ai_points_not_for_face_type",
            )
        agreed = await consent.require(
            db, body.consent_id, org, user_id, consent.THIRD_PARTY_AI, vision_points.PROVIDER
        )
        if not vision_points.configured():
            raise Conflict409(
                "AI point finding is not configured on this server",
                code="ai_points_unavailable",
            )
        digest = await _image_digest(creation)
        usage = svc.ai_usage_of(creation)
        params.update(sha256=digest, consent_id=agreed.id, charged=False)
        if svc.vision_cache_hit(usage, digest, face_type) is None:
            if usage["detections"] >= svc.AI_DETECTIONS_PER_CREATION:
                raise Conflict409(
                    "The AI has already looked for this avatar's points; place them by hand",
                    code="budget_spent",
                )
            # Taken with the job, atomically: two clicks cannot both pass.
            usage["detections"] += 1
            params["charged"] = True
        values = {
            "ai_usage": usage,
            "consent_ids": consent.with_consent(creation.consent_ids, agreed.id),
        }
    await svc.start_job(db, creation, "detect", params, values=values)
    return await _reloaded(db, creation)


@router.post("/{creation_id}/detect", response_model=CreationOut, status_code=202)
async def detect_face(
    creation_id: str, ctx: OrgMember, db: DB, body: DetectRequest | None = None
) -> CreationOut:
    """Find the face on the current image (the line's detector, else the
    face template) and open the marks on it, with the validator's verdict.

    With `use_ai` (and a third_party_ai consent), an animal, or an animation
    the detector finds nothing on, gets the vision model's points instead of
    the template's guess: `anchors.source` is "ai". They are a pre-fill; the
    owner still places or ticks every part. Any failure of the model falls
    back to the template with a warning. One AI detection per creation (409
    budget_spent), answers cached by image hash.
    """
    creation = await _get(db, ctx.org.id, creation_id)
    return await _start_detect(
        db, creation, body or DetectRequest(), ctx.org, ctx.membership.user_id
    )


async def _start_adjust(
    db: DB, creation: Creation, body: AdjustRequest, org: Organization, user_id: str
) -> CreationOut:
    from app.services import consent, imagegen, photo_adjust
    from app.services.ai_models import PROVIDER
    from app.services.usage import check_image_limit

    _require_draft(creation)
    _require_image(creation)
    face_type = _require_face_type(creation)
    if body.mode not in photo_adjust.MODES_BY_LINE[face_type]:
        raise Validation422(
            f"{body.mode} is not offered for this kind of face",
            code="adjust_not_for_face_type",
        )
    auto_frame: str | None = None
    if body.auto:
        # The wizard acting on its own: only the offer as it stands now
        # (a stale tab, a second tab, a result that still shows teeth: none
        # of them starts another paid round).
        offer = svc.auto_adjust_of(creation)
        if offer is None or offer["mode"] != body.mode:
            raise Conflict409(
                "Nothing here is fixed automatically; choose the fix yourself",
                code="auto_adjust_not_applicable",
            )
        auto_frame = svc.frame_key(creation.steps, svc.current_step(creation.steps))
    if body.mode == photo_adjust.STYLISE and body.style is None:
        raise Validation422("Choose a style", code="style_required")
    agreed = await consent.require(
        db, body.consent_id, org, user_id, consent.THIRD_PARTY_AI, PROVIDER
    )
    if not imagegen.configured():
        raise Conflict409(
            "AI editing is not configured on this server", code="imagegen_unavailable"
        )
    usage = svc.ai_usage_of(creation)
    if usage["adjust_rounds"] >= photo_adjust.ROUNDS_PER_CREATION:
        raise Conflict409(
            "This avatar has used its AI adjustments; choose one of the results or the "
            "original",
            code="budget_spent",
        )
    # Refused now rather than failing in the job: nothing is spent.
    await check_image_limit(db, creation.org_id)
    usage["adjust_rounds"] += 1
    if auto_frame is not None:
        # Taken with the job, atomically: the offer is spent for this photo
        # whatever the round brings.
        usage["auto_adjusted"] = [*(usage.get("auto_adjusted") or []), auto_frame]
    params = {
        "mode": body.mode,
        "style": body.style,
        "count": body.count,
        "consent_id": agreed.id,
        # The current image, a cut-out included: the model is shown it on
        # a neutral grey (photo_adjust), never the removed background.
        "source": svc.current_step(creation.steps),
    }
    await svc.start_job(
        db,
        creation,
        "adjust",
        params,
        values={
            "ai_usage": usage,
            "consent_ids": consent.with_consent(creation.consent_ids, agreed.id),
        },
    )
    return await _reloaded(db, creation)


@router.post("/{creation_id}/adjust", response_model=CreationOut, status_code=202)
async def adjust_photo(
    creation_id: str, body: AdjustRequest, ctx: OrgMember, db: DB
) -> CreationOut:
    """One AI adjust round (a job) on the current image: up to `count`
    candidates, each checked, stored as "adjusted:N" steps. Nothing is
    chosen: the owner compares and picks with /choose, and the images
    before AI always stay. `analysis.recommendation` says which mode the
    photo check recommends, and why.

    touchup (human): only the eyes and lips change, pasted onto the image
    (into a cut-out's own pixels, transparency untouched). stylise (human):
    the whole picture in `style`; choosing it makes the creation an
    animation. regenerate (every line): a clean frontal picture of the same
    subject, opaque, cut out when chosen if the background is removed. Needs a third_party_ai consent (403
    consent_required / third_party_ai_disabled); two rounds per creation
    (409 budget_spent); metered against the monthly image limit (429).
    `ai.last_round` reports every candidate, including refusals and failed
    checks with their reasons.

    `auto: true` is the wizard starting the touch-up `ai.auto_adjust`
    offers (a person whose parted lips show their teeth) without a press,
    on the member's own consent: 409 auto_adjust_not_applicable unless that
    offer stands for the current image, and then never again for it.
    """
    creation = await _get(db, ctx.org.id, creation_id)
    return await _start_adjust(db, creation, body, ctx.org, ctx.membership.user_id)


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


async def _finish_out(db: DB, creation: Creation, avatar_id: str) -> FinishOut:
    return FinishOut(
        avatar_id=avatar_id,
        creation=await _out(db, creation),
        # About the picture being finished, so the same on a repeated press.
        warnings=[FinishWarning(**w) for w in svc.mouth_warnings(creation)],
    )


async def _idempotent_finish(db: DB, creation: Creation) -> FinishOut | None:
    ended = creation.status in (CreationStatus.finishing, CreationStatus.finished)
    if ended and creation.avatar_id:
        return await _finish_out(db, creation, creation.avatar_id)
    return None


async def _start_finish(
    db: DB, creation: Creation, body: FinishRequest, org: Organization, user_id: str
) -> FinishOut:
    from app.services import consent

    repeated = await _idempotent_finish(db, creation)
    if repeated:
        return repeated
    _require_draft(creation)
    _require_image(creation)
    face_type = _require_face_type(creation)
    consent_ids = list(creation.consent_ids or [])
    statement = svc.statement_for(creation)
    if statement is not None:
        # A person's face, talking on someone's site: the uploader states
        # they are that person or have their permission, and that the
        # person is an adult (or, for a face made from words, that it is
        # no real person). Decided by where the pixels came from, not by
        # the line (a stylised photo is still that person), and made for
        # this creation. Checked first, before any other refusal, so the
        # dashboard asks for it once.
        agreed = await consent.require(
            db, body.consent_id, org, user_id, statement, subject_id=creation.id
        )
        consent_ids = consent.with_consent(consent_ids, agreed.id)
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
        # The disclosure visitors see: set when the chosen picture (or what
        # it was cut from) was made or edited by an AI.
        ai_edited=svc.ai_edited_of(creation.steps, svc.current_step(creation.steps)),
        consent_ids=consent_ids or None,
    )
    db.add(avatar)
    params = {
        "name": body.name,
        "anchors_id": body.anchors_id,
        "marks": marks,
        "consent_id": body.consent_id,
    }
    try:
        await svc.start_job(
            db,
            creation,
            "finish",
            params,
            values={
                "status": CreationStatus.finishing,
                "avatar_id": avatar.id,
                "consent_ids": consent_ids or None,
            },
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
    return await _finish_out(db, creation, avatar.id)


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

    When `statement` is set, it needs that statement by this user, recorded
    for this creation (403 consent_required, with its `scope`): a person's
    photo on any line ("depiction"), or a face generated from words
    ("generated_face"). The avatar records `ai_edited` when the chosen
    image came from AI adjust or generation.

    A person's avatar starts with the photographic mouth, and, when the
    organization allows third-party AI and this member has agreed to send
    photos to Google, with their own teeth made by AI from the chosen
    picture before it is published (services.creations._own_teeth; the
    avatar's `mouth.teeth` says which, or why not). `warnings` names what
    the picture will still show around the mouth (mouth_open,
    teeth_showing): information, not a refusal.
    """
    creation = await _get(db, ctx.org.id, creation_id)
    return await _start_finish(db, creation, body, ctx.org, ctx.membership.user_id)


@router.post("/{creation_id}/retry", response_model=CreationOut, status_code=202)
async def retry_job(
    creation_id: str, ctx: OrgMember, db: DB, body: RetryRequest | None = None
) -> CreationOut:
    """Run a failed or interrupted job again, with what it was given.

    A job that sends pixels to Google (adjust, AI points, generation from a
    photo) is a new call on the RETRYING member's word: it needs their own
    third_party_ai consent under the current wording (`consent_id`, else
    the one the job was started with if it is theirs; 403 consent_required
    otherwise), and the organization's switch on."""
    creation = await _get(db, ctx.org.id, creation_id)
    given = body.consent_id if body else None
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
    if job.step == "generate":
        _require_draft(creation)
        if "original" in svc.step_items(creation.steps):
            raise Conflict409("There is nothing to retry", code="nothing_to_retry")
        from app.services import consent
        from app.services.ai_models import PROVIDER

        consent.require_ai_enabled(ctx.org)
        values: dict = {}
        if params.get("source_avatar_id"):
            # The source photo goes to Google again.
            agreed = await consent.require(
                db, given or params.get("consent_id"), ctx.org, ctx.membership.user_id,
                consent.THIRD_PARTY_AI, PROVIDER,
            )
            params = {**params, "consent_id": agreed.id}
            values["consent_ids"] = consent.with_consent(creation.consent_ids, agreed.id)
        await svc.start_job(db, creation, "generate", params, values=values)
        return await _reloaded(db, creation)
    if job.step == "background":
        return (await _start_background(db, creation, "remove"))[0]
    if job.step == "detect":
        detect = DetectRequest(
            use_ai=bool(params.get("use_ai")), consent_id=given or params.get("consent_id")
        )
        return await _start_detect(db, creation, detect, ctx.org, ctx.membership.user_id)
    if job.step == "adjust":
        adjust = AdjustRequest(
            mode=params["mode"],
            style=params.get("style"),
            consent_id=given or params.get("consent_id") or "-",
            count=params.get("count") or 2,
        )
        return await _start_adjust(db, creation, adjust, ctx.org, ctx.membership.user_id)
    finish = FinishRequest(
        name=params.get("name") or "Avatar",
        anchors_id=params.get("anchors_id") or "",
        marks=params.get("marks"),
        consent_id=params.get("consent_id"),
    )
    return (
        await _start_finish(db, creation, finish, ctx.org, ctx.membership.user_id)
    ).creation


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
