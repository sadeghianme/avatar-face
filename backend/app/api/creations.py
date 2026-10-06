"""The creation wizard: upload or generate, frame, background, AI adjust,
points, finish (the owner's order, docs/avatar-lines.md "The creation flow").

Heavy work (ingest, generation, AI adjust, background removal, detection,
finishing) is a job (services.jobs): the route validates, admits the job and
answers 202 with the creation, and the client follows `job` on GET until it
is done. The rest answers at once.

Every query filters on the creation id AND the org from the path, so another
org's creation id is simply not found (services.creations.repo). Clients
name images by step id ("original", "framed", "cutout", "adjusted:N",
"cutout:N"), never by storage key.

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

The routes do HTTP only: what each request does is services.creations
(new, edits, requests, repo); what is answered is built here.
"""

from __future__ import annotations

from typing import Annotated, cast

from fastapi import APIRouter, Form, Response, UploadFile

from app.api.deps import DB, OrgMember
from app.core.config import get_settings
from app.core.errors import Validation422
from app.models import Creation, CreationStatus, Organization
from app.schemas.avatar import FaceType, FitReason
from app.schemas.creation import (
    AdjustRequest,
    AdjustRoundOut,
    AiOut,
    AnchorsOut,
    AutoAdjustOut,
    AvatarLook,
    AvatarModel,
    BackgroundOffer,
    BackgroundRequest,
    ChooseRequest,
    CreationOut,
    CreationStatusName,
    CreationUpdate,
    DetectRequest,
    FinishOut,
    FinishRequest,
    FinishWarning,
    GenerateCreationRequest,
    JobOut,
    JobProgress,
    PlanOut,
    PrepareRequest,
    PreviewRigOut,
    PreviewRigRequest,
    RetryRequest,
    StepOut,
    VersionRequest,
)
from app.services import creations as svc
from app.services import orgs, wizard
from app.services.creations import edits, new, repo, requests
from app.services.jobs import ACTIVE_STATES, runner
from app.services.storage import get_storage

router = APIRouter(prefix="/orgs/{org_id}/creations", tags=["creations"])

LIST_LIMIT = 50


# --- Output ---------------------------------------------------------------------


def _job_out(record: dict | None) -> JobOut | None:
    if not record:
        return None
    live = runner.get(record["id"])
    progress = live.progress() if live and record["state"] in ACTIVE_STATES else None
    return JobOut(
        id=record["id"],
        step=record["step"],
        state=record["state"],
        error=record.get("error"),
        started_at=record["started_at"],
        progress=JobProgress.model_validate(progress) if progress is not None else None,
        retryable=svc.retryable(record),
    )


def _background_offer(creation: Creation) -> BackgroundOffer:
    return BackgroundOffer(**edits.background_offer(creation.face_type))


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
        prepare_rounds_left=max(0, wizard.PREPARE_ROUNDS_PER_CREATION - usage["prepare_rounds"]),
        free_clears_left=max(0, wizard.FREE_CLEARS_PER_CREATION - usage["free_clears"]),
        last_prepare=usage.get("last_prepare"),
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
            **{"from": items[step_id].get("from")},
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
    plan = wizard.plan_of(creation.steps)
    return CreationOut(
        id=creation.id,
        # The column holds a line name: requests are checked against FaceType.
        face_type=cast("FaceType | None", creation.face_type),
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
        ai=_ai_out(creation, await orgs.loaded_org(db, creation.org_id), recommendation),
        statement=svc.statement_for(creation),
        plan=PlanOut.model_validate(plan) if plan is not None else None,
        name=wizard.name_of(creation.steps),
        created_at=creation.created_at,
        updated_at=creation.updated_at,
    )


async def _reloaded(db: DB, creation: Creation) -> CreationOut:
    return await _out(db, await repo.reloaded(db, creation))


async def _finish_out(db: DB, creation: Creation, avatar_id: str) -> FinishOut:
    return FinishOut(
        avatar_id=avatar_id,
        creation=await _out(db, creation),
        # About the picture being finished, so the same on a repeated press.
        warnings=[FinishWarning(**w) for w in svc.mouth_warnings(creation)],
    )


# --- Routes -----------------------------------------------------------------------


@router.post("", response_model=CreationOut, status_code=202)
async def create_creation(
    file: UploadFile,
    ctx: OrgMember,
    db: DB,
    face_type: Annotated[FaceType | None, Form()] = None,
    model: Annotated[AvatarModel | None, Form()] = None,
    look: Annotated[AvatarLook | None, Form()] = None,
) -> CreationOut:
    """Upload a photo and start a creation.

    Refusals that need no decoding happen here (type, size, the draft limit,
    the job admission, the header's pixel count); the decode, clean-up and
    analysis run as the creation's first job.

    The four-step wizard sends `model` and `look` (both, or neither): the
    line follows from them (services.wizard.line_for) and the creation keeps
    them as its `plan`, with the `name` it proposes (from the file name when
    that means something; wizard.default_name), decided here once so every
    screen and the finish say the same; step 3 then prepares the photo
    (POST /prepare).
    """
    steps, line = new.upload_plan(model, look, file.filename)
    line_or_given = line if line is not None else face_type
    if file.content_type not in get_settings().allowed_image_types:
        raise Validation422("Choose a JPEG, PNG or WebP photo", code="unsupported_image_type")
    data = await file.read(svc.MAX_UPLOAD_BYTES + 1)
    if len(data) > svc.MAX_UPLOAD_BYTES:
        raise Validation422("Photo must be 15 MB or smaller", code="image_too_large")
    creation = await new.create_from_upload(
        db, ctx.org.id, ctx.membership.user_id, data, file.content_type, line_or_given, steps
    )
    return await _reloaded(db, creation)


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
    creation = await new.create_generated(db, ctx.org, ctx.membership.user_id, body)
    return await _reloaded(db, creation)


@router.get("", response_model=list[CreationOut])
async def list_creations(
    ctx: OrgMember, db: DB, status: CreationStatusName | None = None
) -> list[CreationOut]:
    """Newest activity first. `?status=draft` is the resume list."""
    rows = await repo.recent(
        db, ctx.org.id, CreationStatus(status) if status is not None else None, LIST_LIMIT
    )
    return [await _out(db, creation) for creation in rows]


@router.get("/{creation_id}", response_model=CreationOut)
async def get_creation(creation_id: str, ctx: OrgMember, db: DB) -> CreationOut:
    return await _out(db, await repo.get(db, ctx.org.id, creation_id))


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
    creation = await repo.get(db, ctx.org.id, creation_id)
    crop = body.crop.model_dump() if body.crop else None
    if not await edits.frame_or_line(db, creation, crop, body.roll, body.face_type):
        return await _out(db, creation)
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
    creation = await repo.get(db, ctx.org.id, creation_id)
    status = await edits.choose(db, creation, body.choice)
    if status is None:
        return await _out(db, creation)
    if status == 202:
        response.status_code = 202
    return await _reloaded(db, creation)


@router.post("/{creation_id}/background", response_model=CreationOut)
async def set_background(
    creation_id: str, body: BackgroundRequest, ctx: OrgMember, db: DB, response: Response
) -> CreationOut:
    """Remove the background of the current image (a job: 202; 200 when it
    is a cut-out already, or its cut-out exists), or keep it (200: back to
    the opaque image behind a current cut-out). The answer is remembered as
    `background`. Marks survive either way: no pixel moves."""
    creation = await repo.get(db, ctx.org.id, creation_id)
    response.status_code = await edits.set_background(db, creation, body.mode)
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
    creation = await repo.get(db, ctx.org.id, creation_id)
    await requests.start_detect(
        db, creation, body or DetectRequest(), ctx.org, ctx.membership.user_id
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
    creation = await repo.get(db, ctx.org.id, creation_id)
    await requests.start_adjust(db, creation, body, ctx.org, ctx.membership.user_id)
    return await _reloaded(db, creation)


@router.post("/{creation_id}/prepare", response_model=CreationOut, status_code=202)
async def prepare_photo(
    creation_id: str, body: PrepareRequest, ctx: OrgMember, db: DB
) -> CreationOut:
    """Step 3 of the four-step wizard (a job): make the picture the avatar is
    built from, in the plan's look, take its background off and find its
    face (services.wizard). `mode`:

    - `ai`: the upload, made by the AI in the look, frontal and lit, eyes
      open on the camera, mouth closed; `instruction` is added to it;
    - `change`: `instruction` applied to the current AI picture;
    - `generate`: a new picture from a generated creation's description;
    - `original`: the photo itself, framed and cut out, no AI (realistic
      uploads only; 422 original_not_for_look).

    The AI modes need a third_party_ai consent (403 consent_required /
    third_party_ai_disabled), a try left (six per creation, 409
    budget_spent) and the monthly image limit (429). The picture before is
    kept: every result is a step, and the upload stays.
    """
    creation = await repo.get(db, ctx.org.id, creation_id)
    await requests.start_prepare(db, creation, body, ctx.org, ctx.membership.user_id)
    return await _reloaded(db, creation)


@router.post("/{creation_id}/version", response_model=CreationOut)
async def use_version(
    creation_id: str, body: VersionRequest, ctx: OrgMember, db: DB
) -> CreationOut:
    """Step 3 of the four-step wizard: make one of the pictures already made
    the one the avatar is built from (200). Nothing is lost by a Retry, a
    change, its removal or the original photo: every one is a version, and
    any of them can be taken back. Free: no AI runs.

    The version's cut-out is used when it has one, its points come back as
    they were found (found again, by the detector only, on a version made
    before points were kept with it), and `ai.last_prepare` becomes the try
    that made it, so Retry and "describe a change" carry on from it.

    409 creation_busy while a picture is being made; 422 unknown_version,
    candidate_rejected, original_not_for_look; 409 version_not_prepared for
    an upload "use my original photo" has not prepared yet.
    """
    creation = await repo.get(db, ctx.org.id, creation_id)
    if not await requests.use_version(db, creation, body.version):
        return await _out(db, creation)
    return await _reloaded(db, creation)


@router.post("/{creation_id}/preview-rig", response_model=PreviewRigOut)
async def preview_rig(
    creation_id: str, body: PreviewRigRequest, ctx: OrgMember, db: DB
) -> PreviewRigOut:
    """The rig finish would build from these marks, with the validator's
    reasons. Nothing is saved.

    Computed per request rather than as a job: a fit is milliseconds, the
    same call the avatar rig-fit preview makes on every drag, and queueing it
    behind someone's background removal would make the handles lag.
    """
    creation = await repo.get(db, ctx.org.id, creation_id)
    rig, problems = await requests.preview_rig(creation, body)
    return PreviewRigOut(
        rig=rig,
        reasons=[FitReason(code=p.code, detail=p.detail, count=p.count) for p in problems],
    )


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
    The avatar takes `name`, or without one the name kept with the creation
    (`CreationOut.name`, decided when it was made), else "Avatar".

    When `statement` is set, it needs that statement by this user, recorded
    for this creation (403 consent_required, with its `scope`): a person's
    photo on any line ("depiction"), or a face generated from words
    ("generated_face"). The avatar records `ai_edited` when the chosen
    image came from AI adjust or generation.

    A person's avatar starts with the photographic mouth, and, when the
    organization allows third-party AI and this member has agreed to send
    photos to Google, is "prepared" before it is published: its own mouth
    shapes, its teeth and a mouth profile fitted to it, made by AI from the
    chosen picture and the confirmed points (services.creations._own_mouth,
    services.mouth_kit; the job's progress counts the shapes, and the
    avatar's `mouth.kit` and `mouth.teeth` say what was made, or why not).
    `warnings` names what the picture will still show around the mouth
    (mouth_open, teeth_showing): information, not a refusal.
    """
    creation = await repo.get(db, ctx.org.id, creation_id)
    creation, avatar_id = await requests.start_finish(
        db, creation, body, ctx.org, ctx.membership.user_id
    )
    return await _finish_out(db, creation, avatar_id)


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
    creation = await repo.get(db, ctx.org.id, creation_id)
    given = body.consent_id if body else None
    retried = await requests.retry(db, creation, given, ctx.org, ctx.membership.user_id)
    return await _out(db, retried)


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
    creation = await repo.get(db, ctx.org.id, creation_id)
    await repo.delete(db, creation)
    return Response(status_code=204)
