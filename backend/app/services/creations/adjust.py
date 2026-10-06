"""AI adjust: a round of edits of the current image (touch-up, stylise,
regenerate) as candidates for the owner to compare, the touch-up the wizard
may start by itself, and what the picture will show around the mouth."""

from __future__ import annotations

import logging


from app.core.errors import AppError, Conflict409, Validation422
from app.db import get_session_factory
from app.models import Creation
from app.services.jobs import (
    FAILED,
    Job,
    run_cpu,
)
from app.services.storage import get_storage
from app.services.creations.records import (
    SUPERSEDED,
    _ai_disabled_error,
    _ai_switched_off,
    _load,
    _store_result,
    _update_ai_usage,
    _write_job,
    ai_usage_of,
    error_record,
)
from app.services.creations.rules import ADJUSTED_PREFIX, step_key
from app.services.creations.steps import (
    ai_edited_of,
    check_of,
    copied,
    current_step,
    frame_key,
    lineage,
    recommendation_of,
    round_source,
    step_check,
    step_items,
)

logger = logging.getLogger("liveface.creations")


# What each mode is recorded as in usage (usage.IMAGE_CALLS).
ADJUST_CALLS = {
    "touchup": "adjust_touchup",
    "stylise": "adjust_stylise",
    "regenerate": "adjust_regen",
}


# What the wizard may fix without being asked: a person whose lips are
# parted over their teeth. Those teeth are pixels of the photo, painted on
# the lips, so the photographic mouth shows them on closed lips as it talks;
# a touch-up closes the lips (and fixes the eyes when the check found them
# wanting too, as it recommends). Nothing else the check finds (eyes alone,
# pose, light) starts by itself: it stays a recommendation the owner acts on.
AUTO_ADJUST_REASON = "teeth_showing"


def source_photo_key(steps: dict | None, step_id: str | None) -> str | None:
    """The key of the photo `step_id` comes from, through every framing
    and cut-out of it: the root of its lineage (the upload, or the
    generated original). The same for a photo re-cropped any number of
    times, where each crop is a new pixel frame (frame_key)."""
    chain = lineage(steps, step_id)
    return chain[-1]["key"] if chain else None


def auto_adjust_of(creation: Creation) -> dict | None:
    """{mode, image, reasons}: the touch-up the wizard may start by itself
    on the current image, or None.

    Only on a person's photo whose check recommends a touch-up because the
    teeth show between parted lips: the check found a need the photographic
    mouth cannot live with, and the owner's flow runs such a fix by itself
    on the member's remembered consent. With the eyes flagged too (closed,
    half closed, looking away) the same touch-up closes the lips and fixes
    the eyes, which the check recommends as well; the reasons say so, and
    the owner still chooses the result or keeps the photo. Only while a
    round is left, and at most once per source photo: never on a picture an
    AI already made (the result is the owner's to judge, even if its lips
    are still parted), nor on a photo the owner has already adjusted, nor
    again on one it was started for (`auto_adjusted`, the source photos it
    ran on), however it is re-cropped since. The organization's switch, the
    server's image model and the member's consent are the caller's to check.
    """
    from app.services.photo_adjust import ROUNDS_PER_CREATION, TOUCHUP

    if creation.face_type != "human":
        return None
    steps = creation.steps
    recommendation = recommendation_of(steps, "human")
    if (
        not recommendation
        or recommendation["mode"] != TOUCHUP
        or AUTO_ADJUST_REASON not in recommendation["reasons"]
    ):
        return None
    current = current_step(steps)
    if ai_edited_of(steps, current) is not None:
        return None
    usage = ai_usage_of(creation)
    if usage["adjust_rounds"] >= ROUNDS_PER_CREATION:
        return None
    source = source_photo_key(steps, current)
    started = usage.get("auto_adjusted") or []
    # Frame keys are what was recorded before sources were: still honoured.
    if source in started or frame_key(steps, current) in started:
        return None
    last = usage.get("last_round")
    if last and source_photo_key(steps, round_source(steps, last)) == source:
        return None
    return {"mode": TOUCHUP, "image": current, "reasons": list(recommendation["reasons"])}


def mouth_warnings(creation: Creation) -> list[dict]:
    """What finishing the current image will look like around the mouth, as
    {code, detail} warnings: an open mouth rests open, and parted lips keep
    the photo's teeth painted on them. Empty when the check found neither,
    or has not looked (no face, a draft from before checks were kept).

    The human line only: both are about the photographic mouth, which is the
    picture's own lips moving. An animal's muzzle and a drawing's mouth are
    drawn over the picture, so what its lips do at rest does not show; and
    the check that measured them is MediaPipe's face landmarker reading a
    dog's muzzle as a mouth, which says nothing."""
    if creation.face_type != "human":
        return []
    state = (check_of(creation.steps, current_step(creation.steps)) or {}).get("face_state") or {}
    if state.get("mouth_open"):
        return [error_record(
            "mouth_open",
            "The mouth is open in this picture, so the avatar rests with it open; "
            "regenerate the photo or use one with the lips closed",
        )]
    if state.get("teeth_showing"):
        return [error_record(
            "teeth_showing",
            "The lips are parted in this picture, so its own teeth stay painted on them "
            "as the avatar talks; a touch-up closes them",
        )]
    return []


def _refund_round(usage: dict) -> None:
    usage["adjust_rounds"] = max(0, usage["adjust_rounds"] - 1)


async def _adjust(job: Job, params: dict) -> None:
    """One AI adjust round on the current image (params["source"], a cut-out
    more often than not): up to `count` candidates from the provider, each
    checked, stored as "adjusted:N" steps for the owner to compare, each
    with its own photo check. Never chosen here: the current image stays
    what it was.

    Admission spent the round (the budget is taken atomically with the job).
    It is given back when no provider call was answered, so a photo that
    cannot be touched up, or a provider that is down, costs nothing.
    """
    from app.services import imagegen, photo_adjust
    from app.services.photo_analysis import check_png
    from app.services.usage import check_image_limit, record_generation

    creation = await _load(job)
    if creation is None:
        return
    source_id = params["source"]
    source = step_items(creation.steps).get(source_id)
    if source is None or creation.face_type is None:
        await _write_job(job, FAILED, params, SUPERSEDED)
        return
    mode, face_type = params["mode"], creation.face_type
    storage = get_storage()
    data = await storage.get_bytes(source["key"])

    job.report(0.05, "preparing the photo")
    try:
        prepared = await run_cpu(photo_adjust.prepare, data, mode, face_type, params.get("style"))
    except photo_adjust.AdjustSkipped as exc:
        await _update_ai_usage(job, _refund_round)
        raise Validation422(exc.detail, code=exc.code) from exc

    count = int(params.get("count") or photo_adjust.MAX_CANDIDATES)
    outcomes: list[tuple[photo_adjust.Candidate, str | None]] = []
    answered = 0
    limit_error: AppError | None = None
    attempt = -1
    tried_crop = False
    while attempt + 1 < count:
        attempt += 1
        job.report(0.1 + 0.8 * attempt / count, "asking the AI")
        if await _ai_switched_off(job.org_id):
            if answered == 0:
                await _update_ai_usage(job, _refund_round)
                raise _ai_disabled_error()
            # One answer is in, and paid for: the owner keeps it, and
            # nothing more is sent.
            break
        try:
            async with get_session_factory()() as db:
                await check_image_limit(db, job.org_id)
        except AppError as exc:
            limit_error = exc
            break
        try:
            generated = await imagegen.edit_image(prepared.prompt, prepared.payload, prepared.mime)
        except imagegen.ImageGenNoImage as exc:
            # Answered, so billed: metered and the round stays spent. Not
            # asked again this round; the same photo tends to be declined
            # the same way, and every attempt is paid.
            answered += 1
            async with get_session_factory()() as db:
                await record_generation(db, job.org_id, "gemini", ADJUST_CALLS[mode])
            outcomes.append((
                photo_adjust.Candidate(None, rejected=photo_adjust.reason(
                    "no_image", "The AI answered without an image, so it was not asked again",
                )),
                imagegen.MODEL,
            ))
            logger.info("adjust %s answered without an image (%s)", job.id, exc.reason)
            break
        except imagegen.ImageGenRefused as exc:
            answered += 1
            async with get_session_factory()() as db:
                await record_generation(db, job.org_id, "gemini", ADJUST_CALLS[mode])
            # A declined whole-photo edit gets one more chance on a
            # head-and-shoulders crop (see photo_adjust.head_crop_fallback):
            # a different input, not the same request again, and still the
            # same candidate being asked for.
            if not tried_crop:
                tried_crop = True
                fallback = await run_cpu(
                    photo_adjust.head_crop_fallback, data, mode, face_type, params.get("style")
                )
                if fallback is not None:
                    logger.info(
                        "adjust %s refused (%s); asking once more with the head crop",
                        job.id, exc.reason,
                    )
                    prepared = fallback
                    attempt -= 1
                    continue
            outcomes.append((
                photo_adjust.Candidate(None, rejected=photo_adjust.reason(
                    "safety_refused",
                    "The AI declined to edit this photo, so it was not asked again",
                )),
                imagegen.MODEL,
            ))
            logger.info("adjust %s refused (%s); not retried", job.id, exc.reason)
            break
        except imagegen.ImageGenUnavailable as exc:
            if answered == 0:
                await _update_ai_usage(job, _refund_round)
            raise Conflict409(
                "AI editing is not configured on this server", code="imagegen_unavailable"
            ) from exc
        except Exception:
            logger.exception("adjust %s: the provider call failed", job.id)
            outcomes.append((
                photo_adjust.Candidate(None, rejected=photo_adjust.reason(
                    "provider_error", "The AI service did not return an image"
                )),
                None,
            ))
            continue
        answered += 1
        async with get_session_factory()() as db:
            await record_generation(db, job.org_id, "gemini", ADJUST_CALLS[mode])
        job.report(0.1 + 0.8 * (attempt + 0.6) / count, "checking the result")
        candidate = await run_cpu(
            photo_adjust.finish_candidate, data, prepared, generated.image, mode, face_type
        )
        outcomes.append((candidate, generated.model))

    if answered == 0:
        await _update_ai_usage(job, _refund_round)
        if limit_error is not None:
            raise limit_error
        raise AppError("The AI service did not answer; try again", code="provider_error")

    # Every candidate with pixels becomes a step, rejected ones too (with
    # their reason, and not choosable): the owner sees what went wrong.
    usage = ai_usage_of(creation)
    number = usage["next_adjusted"]
    steps = copied(creation.steps)
    new_keys: list[str] = []
    report: list[dict] = []
    for candidate, model in outcomes:
        entry = {
            "step": None,
            "ok": candidate.rejected is None,
            "reason": candidate.rejected,
            "generated_eyes": candidate.generated_eyes,
        }
        if candidate.png is not None:
            step_id = f"{ADJUSTED_PREFIX}{number}"
            number += 1
            key = step_key(job.org_id, job.subject_id, f"adjusted{step_id[len(ADJUSTED_PREFIX):]}")
            await storage.put_bytes(key, candidate.png, "image/png")
            new_keys.append(key)
            # Checked like any image the owner may use, so step 3 can say
            # whether the result still needs something. Not for a rejected
            # one: it cannot be chosen.
            check = (
                step_check(await run_cpu(check_png, candidate.png))
                if candidate.rejected is None else None
            )
            steps["items"][step_id] = {
                "key": key,
                "width": candidate.width,
                "height": candidate.height,
                "from": source_id,
                "cutout": candidate.cutout,
                "check": check,
                "adjust": {
                    "mode": mode,
                    "style": params.get("style"),
                    "model": model,
                    "generated_eyes": candidate.generated_eyes,
                    "rejected": candidate.rejected,
                    "checks": candidate.checks,
                },
            }
            entry["step"] = step_id
        report.append(entry)
    last_round = {
        "mode": mode,
        "style": params.get("style"),
        "source": source_id,
        "candidates": report,
        "limit_reached": limit_error is not None,
    }

    def settle(u: dict) -> None:
        u["next_adjusted"] = number
        u["last_round"] = last_round

    await _update_ai_usage(job, settle)
    await _store_result(job, params, {"steps": steps}, new_keys)
