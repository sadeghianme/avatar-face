"""The owner's requests that start a creation's AI and finishing work:
finding the face (with the vision model's points where it applies), an AI
adjust round, the four-step wizard's step 3 and its versions, Finish, and
a retry of whichever job failed. Each checks what it needs (the state, the
consent, the budget, the server) before the job is admitted, so a refusal
spends nothing.

Every step that sends pixels to Google takes a third_party_ai consent id
and is refused when the organization has switched third-party AI off, and
so is a retry of one (on the retrying member's consent).
"""

from __future__ import annotations

import asyncio

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import Conflict409, Validation422
from app.models import Avatar, AvatarKind, AvatarStatus, Creation, CreationStatus, Organization
from app.models.base import new_id
from app.schemas.creation import (
    AdjustRequest,
    DetectRequest,
    FinishRequest,
    PrepareRequest,
    PreviewRigRequest,
)
from app.services import wizard
from app.services.creations.adjust import auto_adjust_of, source_photo_key
from app.services.creations.detect import (
    anchors_are_current,
    detect_anchors,
    fit_from_anchors,
    vision_cache_hit,
)
from app.services.creations.edits import set_background
from app.services.creations.guards import (
    anchors_for,
    check_marks,
    require_draft,
    require_face_type,
    require_image,
)
from app.services.creations.records import ai_usage_of, retryable
from app.services.creations.repo import get, reloaded, update_content
from app.services.creations.rules import (
    AI_DETECTIONS_PER_CREATION,
    incoming_key,
    required_marks,
)
from app.services.creations.runs import start_job
from app.services.creations.steps import (
    ai_edited_of,
    copied,
    current_step,
    frame_key,
    statement_for,
    step_items,
)
from app.services.jobs import ACTIVE_STATES, run_cpu
from app.services.storage import get_storage

# --- Finding the face --------------------------------------------------------------


async def _image_digest(creation: Creation) -> str:
    """SHA-256 of the current image's pixels file: the point finder's cache
    key. Hashed off the loop (a 2048 px PNG is several MB)."""
    import hashlib

    current = current_step(creation.steps)
    assert current is not None  # detection runs on a creation with an image
    key = step_items(creation.steps)[current]["key"]
    data = await get_storage().get_bytes(key)
    return await asyncio.to_thread(lambda: hashlib.sha256(data).hexdigest())


async def start_detect(
    db: AsyncSession, creation: Creation, body: DetectRequest, org: Organization, user_id: str
) -> None:
    """Admit the detect job. With `use_ai`, not for a person (422), on a
    third_party_ai consent, with the point finder configured (409) and the
    creation's AI detection unspent unless the answer is cached (409
    budget_spent); the budget is taken with the job."""
    from app.services import consent, vision_points

    require_draft(creation)
    require_image(creation)
    face_type = require_face_type(creation)
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
        usage = ai_usage_of(creation)
        params.update(sha256=digest, consent_id=agreed.id, charged=False)
        if vision_cache_hit(usage, digest, face_type) is None:
            if usage["detections"] >= AI_DETECTIONS_PER_CREATION:
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
    await start_job(db, creation, "detect", params, values=values)


# --- AI adjust ---------------------------------------------------------------------


async def start_adjust(
    db: AsyncSession, creation: Creation, body: AdjustRequest, org: Organization, user_id: str
) -> None:
    """Admit an AI adjust round: a mode the line offers (422), a style for
    stylise (422), the auto offer as it stands when `auto` (409
    auto_adjust_not_applicable), a third_party_ai consent, the image model
    (409), a round left (409 budget_spent) and the image limit (429). The
    round is taken with the job."""
    from app.services import consent, imagegen, photo_adjust
    from app.services.ai_models import PROVIDER
    from app.services.usage import check_image_limit

    require_draft(creation)
    require_image(creation)
    face_type = require_face_type(creation)
    if body.mode not in photo_adjust.MODES_BY_LINE[face_type]:
        raise Validation422(
            f"{body.mode} is not offered for this kind of face",
            code="adjust_not_for_face_type",
        )
    auto_source: str | None = None
    if body.auto:
        # The wizard acting on its own: only the offer as it stands now
        # (a stale tab, a second tab, a result that still shows teeth, the
        # same photo cropped again: none of them starts another paid round).
        offer = auto_adjust_of(creation)
        if offer is None or offer["mode"] != body.mode:
            raise Conflict409(
                "Nothing here is fixed automatically; choose the fix yourself",
                code="auto_adjust_not_applicable",
            )
        auto_source = source_photo_key(creation.steps, current_step(creation.steps))
    if body.mode == photo_adjust.STYLISE and body.style is None:
        raise Validation422("Choose a style", code="style_required")
    agreed = await consent.require(
        db, body.consent_id, org, user_id, consent.THIRD_PARTY_AI, PROVIDER
    )
    if not imagegen.configured():
        raise Conflict409(
            "AI editing is not configured on this server", code="imagegen_unavailable"
        )
    usage = ai_usage_of(creation)
    if usage["adjust_rounds"] >= photo_adjust.ROUNDS_PER_CREATION:
        raise Conflict409(
            "This avatar has used its AI adjustments; choose one of the results or the "
            "original",
            code="budget_spent",
        )
    # Refused now rather than failing in the job: nothing is spent.
    await check_image_limit(db, creation.org_id)
    usage["adjust_rounds"] += 1
    if auto_source is not None:
        # Taken with the job, atomically: the offer is spent for this photo
        # (every crop of it) whatever the round brings.
        usage["auto_adjusted"] = [*(usage.get("auto_adjusted") or []), auto_source]
    params = {
        "mode": body.mode,
        "style": body.style,
        "count": body.count,
        "consent_id": agreed.id,
        # The current image, a cut-out included: the model is shown it on
        # a neutral grey (photo_adjust), never the removed background.
        "source": current_step(creation.steps),
    }
    await start_job(
        db,
        creation,
        "adjust",
        params,
        values={
            "ai_usage": usage,
            "consent_ids": consent.with_consent(creation.consent_ids, agreed.id),
        },
    )


# --- The four-step wizard's step 3 -------------------------------------------------


async def start_prepare(
    db: AsyncSession, creation: Creation, body: PrepareRequest, org: Organization, user_id: str
) -> None:
    """Admit step 3's job (services.wizard): the picture the avatar is built
    from, in the plan's look. A creation the old wizard started gets the
    plan its line implies. `original` is for a realistic upload only (422);
    the AI modes need a third_party_ai consent, the image model (409), a try
    left (409 budget_spent; a free one for "remove this change" while they
    last) and the image limit (429). The try is taken with the job."""
    from app.services import consent, imagegen
    from app.services.ai_models import PROVIDER
    from app.services.usage import check_image_limit

    require_draft(creation)
    require_image(creation)
    face_type = require_face_type(creation)
    items = step_items(creation.steps)
    plan = wizard.plan_of(creation.steps)
    values: dict = {}
    if plan is None:
        # A creation the old wizard started: carried on with the plan its
        # line implies (a person's photo is realistic, a drawing a cartoon).
        plan = wizard.inferred_plan(face_type, bool(items["original"].get("generated")))
        steps = copied(creation.steps)
        steps[wizard.PLAN] = plan
        values["steps"] = steps
    instruction = (body.instruction or "").strip() or None
    params: dict = {"mode": body.mode, "instruction": instruction}
    if body.mode == wizard.ORIGINAL:
        if plan["look"] != "realistic":
            raise Validation422(
                "Your own photo is used as it is only for a realistic avatar",
                code="original_not_for_look",
            )
        if plan["source"] != "upload":
            raise Validation422("There is no photo of yours to use", code="original_not_for_look")
        # No AI makes the picture; the consent, when the member gave one, lets
        # the vision model find the points of a face the detector misses.
        # With the organization's AI switched off that help is not used, and
        # a consent the member's browser still remembers is not a reason to
        # refuse a step that needs no AI.
        if body.consent_id and org.third_party_ai_enabled:
            agreed = await consent.require(
                db, body.consent_id, org, user_id, consent.THIRD_PARTY_AI, PROVIDER
            )
            params["consent_id"] = agreed.id
            values["consent_ids"] = consent.with_consent(creation.consent_ids, agreed.id)
    else:
        if body.mode == wizard.CHANGE and not instruction:
            raise Validation422("Describe the change first", code="instruction_required")
        if body.again:
            if body.mode != wizard.CHANGE:
                raise Validation422("Only a change is tried again", code="again_not_a_change")
            params["again"] = True
        if body.clear and body.mode not in (wizard.AI, wizard.GENERATE):
            raise Validation422(
                "Only the plain picture can be asked for with the change removed",
                code="clear_not_plain",
            )
        if body.mode == wizard.GENERATE and plan["source"] != "generate":
            raise Validation422(
                "Only a character described in words is made again from its words",
                code="generate_not_for_upload",
            )
        agreed = await consent.require(
            db, body.consent_id, org, user_id, consent.THIRD_PARTY_AI, PROVIDER
        )
        if not imagegen.configured():
            raise Conflict409(
                "AI image making is not configured on this server", code="imagegen_unavailable"
            )
        usage = ai_usage_of(creation)
        # "Remove this change" gives its try back while the free ones last
        # (even with no tries left); still one metered image call.
        free = body.clear and usage["free_clears"] < wizard.FREE_CLEARS_PER_CREATION
        if not free and usage["prepare_rounds"] >= wizard.PREPARE_ROUNDS_PER_CREATION:
            raise Conflict409(
                "This avatar has used all its AI tries; continue with the picture you have",
                code="budget_spent",
            )
        # Refused now rather than failing in the job: nothing is spent.
        await check_image_limit(db, creation.org_id)
        # Taken with the job, atomically: two presses cannot both pass.
        if free:
            usage["free_clears"] += 1
            params["free"] = True
        else:
            usage["prepare_rounds"] += 1
        params["consent_id"] = agreed.id
        values["ai_usage"] = usage
        values["consent_ids"] = consent.with_consent(creation.consent_ids, agreed.id)
    await start_job(db, creation, "prepare", params, values=values, bump="steps" in values)


async def use_version(db: AsyncSession, creation: Creation, version: str) -> bool:
    """Make one of the pictures step 3 made the current one; whether
    anything changed (committed). Free: no AI runs. 409 creation_busy while
    a picture is being made; the version's own refusals are
    services.wizard.use_version's.

    The version's cut-out is used when it has one, its points come back as
    they were found (found again, by the detector only, on a version made
    before points were kept with it), and `ai.last_prepare` becomes the try
    that made it, so Retry and "describe a change" carry on from it.
    """
    require_draft(creation)
    require_image(creation)
    face_type = require_face_type(creation)
    if (creation.job or {}).get("state") in ACTIVE_STATES:
        raise Conflict409("Wait for the picture being made", code="creation_busy")
    items = step_items(creation.steps)
    plan = wizard.plan_of(creation.steps) or wizard.inferred_plan(
        face_type, bool(items["original"].get("generated"))
    )
    if wizard.version_of(creation.steps, current_step(creation.steps)) == version and (
        anchors_are_current(creation)
    ):
        return False
    steps, anchors, record = wizard.use_version(creation.steps, version, plan)
    current = steps["current"]
    if not (
        anchors
        and anchors.get("face_type") == face_type
        and anchors.get("frame") == frame_key(steps, current)
    ):
        data = await get_storage().get_bytes(items[current]["key"])
        found = await run_cpu(detect_anchors, data, face_type)
        anchors = {
            "id": new_id(),
            "frame": frame_key(steps, current),
            "face_type": face_type,
            "source": "mediapipe" if found["detected"] else "template",
            **found,
        }
    usage = ai_usage_of(creation)
    usage["last_prepare"] = record
    await update_content(db, creation, steps=steps, anchors=anchors, ai_usage=usage)
    return True


# --- Finishing ---------------------------------------------------------------------


async def preview_rig(creation: Creation, body: PreviewRigRequest):
    """(rig, problems): the rig finish would build from these marks. Nothing
    is saved.

    The fit (a Delaunay mesh and a thin-plate warp, several milliseconds on
    every drag) runs on a worker thread: off the loop, and not queued behind
    someone's upload on the CPU thread, which would make the handles lag.
    """
    require_draft(creation)
    face_type = require_face_type(creation)
    anchors = anchors_for(creation, body.anchors_id)
    marks = check_marks(body.marks, face_type, anchors["image_size"])
    return await asyncio.to_thread(fit_from_anchors, anchors, marks, face_type)


def finished_avatar(creation: Creation) -> str | None:
    """The avatar a Finish already pressed is building or built, or None."""
    ended = creation.status in (CreationStatus.finishing, CreationStatus.finished)
    if ended and creation.avatar_id:
        return creation.avatar_id
    return None


async def start_finish(
    db: AsyncSession, creation: Creation, body: FinishRequest, org: Organization, user_id: str
) -> tuple[Creation, str]:
    """Admit the finish (draft → finishing, once), or answer with the avatar
    a Finish already pressed made: (the creation as it is now, the avatar's
    id).

    The uploader's statement comes first (403 consent_required with its
    scope), then the marks: on the current image (409 anchors_stale),
    inside it, in the line's scheme, every part placed by hand that the
    detector did not find (422 marks_required), and a fit that does not
    fold (422 fit_invalid, with the reasons).
    """
    from app.schemas.avatar import FitReason
    from app.services import consent

    repeated = finished_avatar(creation)
    if repeated:
        return creation, repeated
    require_draft(creation)
    require_image(creation)
    face_type = require_face_type(creation)
    consent_ids = list(creation.consent_ids or [])
    statement = statement_for(creation)
    if statement is not None:
        # A person's face, talking on someone's site: the uploader states
        # they are that person or have their permission, and that the
        # person is an adult (or, for a face made from words, that it is
        # no real person). Decided by where the pixels came from, not by
        # the line (a stylised photo is still that person), and made for
        # this creation. Checked first, before any other refusal, so the
        # dashboard asks for it once. Without an id, the statement this
        # member already made for this creation (the four-step wizard asks
        # for it with the photo or the description).
        given = body.consent_id
        if not given:
            made = await consent.statement_about(db, org, user_id, statement, creation.id)
            given = made.id if made is not None else None
        agreed = await consent.require(
            db, given, org, user_id, statement, subject_id=creation.id
        )
        consent_ids = consent.with_consent(consent_ids, agreed.id)
        body = body.model_copy(update={"consent_id": agreed.id})
    anchors = anchors_for(creation, body.anchors_id)
    marks = check_marks(body.marks, face_type, anchors["image_size"])
    required = required_marks(face_type, bool(anchors.get("detected")))
    missing = [name for name in required if name not in (marks or {})]
    if missing:
        raise Validation422(
            "These points were placed on a guess, not found on the face: place each "
            "one by hand before saving",
            code="marks_required",
            extra={"missing": missing},
        )
    _, problems = await asyncio.to_thread(fit_from_anchors, anchors, marks, face_type)
    if problems:
        reasons = [FitReason(code=p.code, detail=p.detail, count=p.count) for p in problems]
        raise Validation422(
            "These marks would distort the face: " + "; ".join(r.detail for r in reasons),
            code="fit_invalid",
            extra={"reasons": [r.model_dump() for r in reasons]},
        )

    # The name the dashboard shows is the one kept with the creation (set
    # when it was made); a client that sends one has the last word, and a
    # creation the old wizard made has neither.
    name = (body.name or "").strip() or wizard.name_of(creation.steps) or "Avatar"
    avatar = Avatar(
        id=new_id(),
        org_id=creation.org_id,
        created_by_id=user_id,
        name=name,
        kind=AvatarKind.photo,
        content_type="image/png",
        face_type=face_type,
        status=AvatarStatus.processing,
        # The disclosure visitors see: set when the chosen picture (or what
        # it was cut from) was made or edited by an AI.
        ai_edited=ai_edited_of(creation.steps, current_step(creation.steps)),
        consent_ids=consent_ids or None,
    )
    db.add(avatar)
    params = {
        "name": name,
        "anchors_id": body.anchors_id,
        "marks": marks,
        "consent_id": body.consent_id,
    }
    try:
        await start_job(
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
        now = await get(db, creation.org_id, creation.id)
        repeated = finished_avatar(now)
        if repeated:
            return now, repeated
        raise
    return await reloaded(db, creation), avatar.id


# --- Retrying ----------------------------------------------------------------------


async def retry(
    db: AsyncSession, creation: Creation, consent_id: str | None, org: Organization, user_id: str
) -> Creation:
    """Run the creation's failed or interrupted job again, with what it was
    given (409 nothing_to_retry when there is none); the creation after.

    A job that sends pixels to Google (adjust, AI points, generation from a
    photo) is a new call on the RETRYING member's word: their own
    third_party_ai consent under the current wording (`consent_id`, else
    the one the job was started with if it is theirs), and the
    organization's switch on."""
    given = consent_id
    record = creation.job or {}
    if not record or not retryable(record):
        raise Conflict409("There is nothing to retry", code="nothing_to_retry")
    params = record.get("params") or {}
    step = record["step"]
    if step == "ingest":
        require_draft(creation)
        if "original" in step_items(creation.steps):
            raise Conflict409("There is nothing to retry", code="nothing_to_retry")
        if not await get_storage().exists(incoming_key(creation.org_id, creation.id)):
            raise Conflict409("The upload is gone; upload the photo again", code="upload_gone")
        await start_job(db, creation, "ingest", {})
        return await reloaded(db, creation)
    if step == "generate":
        require_draft(creation)
        if "original" in step_items(creation.steps):
            raise Conflict409("There is nothing to retry", code="nothing_to_retry")
        from app.services import consent
        from app.services.ai_models import PROVIDER

        consent.require_ai_enabled(org)
        values: dict = {}
        if params.get("source_avatar_id"):
            # The source photo goes to Google again.
            agreed = await consent.require(
                db, given or params.get("consent_id"), org, user_id,
                consent.THIRD_PARTY_AI, PROVIDER,
            )
            params = {**params, "consent_id": agreed.id}
            values["consent_ids"] = consent.with_consent(creation.consent_ids, agreed.id)
        await start_job(db, creation, "generate", params, values=values)
        return await reloaded(db, creation)
    if step == "background":
        await set_background(db, creation, "remove")
        return await reloaded(db, creation)
    if step == "prepare":
        prepare = PrepareRequest(
            mode=params.get("mode") or wizard.AI,
            instruction=params.get("instruction"),
            consent_id=given or params.get("consent_id"),
            clear=bool(params.get("free")),
        )
        await start_prepare(db, creation, prepare, org, user_id)
        return await reloaded(db, creation)
    if step == "detect":
        detect = DetectRequest(
            use_ai=bool(params.get("use_ai")), consent_id=given or params.get("consent_id")
        )
        await start_detect(db, creation, detect, org, user_id)
        return await reloaded(db, creation)
    if step == "adjust":
        adjust = AdjustRequest(
            mode=params["mode"],
            style=params.get("style"),
            consent_id=given or params.get("consent_id") or "-",
            count=params.get("count") or 2,
        )
        await start_adjust(db, creation, adjust, org, user_id)
        return await reloaded(db, creation)
    finish = FinishRequest(
        name=params.get("name") or "Avatar",
        anchors_id=params.get("anchors_id") or "",
        marks=params.get("marks"),
        consent_id=params.get("consent_id"),
    )
    finished, _ = await start_finish(db, creation, finish, org, user_id)
    return finished
