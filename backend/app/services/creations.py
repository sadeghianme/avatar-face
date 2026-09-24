"""The creation wizard's work: images, analysis, marks, jobs and finishing.

A creation (app.models.creation) is one photo's way to an avatar, in the
owner's order (docs/avatar-lines.md, "The creation flow"):

    ingest   → [frame] → [background] → [AI adjust]  → detect → finish
    generate
    original    framed     cutout         adjusted:N     anchors   avatar, published
                                          (→ cutout:N)

Each image the wizard makes is a new STEP with its own storage key; nothing
overwrites the upload, and clients name steps by id ("original", "framed",
"cutout", "adjusted:0", "cutout:0"), never by key. AI adjust works on the
current image, usually a cut-out by then: the model is shown it on a flat
grey (never the removed background), a touch-up is pasted back into the
cut-out and stays one, and a regenerated picture, opaque, is cut out again
("cutout:N") when the owner chose to remove the background.

Every image carries its photo CHECK (photo_analysis.check_photo), made when
the image is: what step 3 recommends is the check of the current image, so
it follows every change of image (framing, an AI result, going back).

Three rules carry the module.

**A result lands only on the state it was computed from.** Every job records
the creation's revision when it was accepted, and stores its result with
`UPDATE … WHERE revision = :rev`. If the owner re-framed, switched line or
chose another image meanwhile, the result describes a state that no longer
exists; it is discarded, and its files deleted, rather than grafted on.

**Marks belong to a pixel frame.** Anchors are stored with the key of the
image whose pixels they were placed on. Framing makes a new frame and clears
them, and so does choosing an AI result (its pixels moved); a cut-out does
not (no pixel moves), so they survive background removal and choosing
between an image and its cut-out.

**Finishing is the owner's confirmation.** It is the only way a creation
becomes an avatar, it is atomic (draft → finishing happens once), repeatable
(a second press answers with the same avatar), and it publishes: the owner
has just looked at the points and said they are right, which is exactly the
confirmation a first build otherwise waits for.
"""

from __future__ import annotations

import asyncio
import copy
import io
import json
import logging
from collections.abc import Callable
from dataclasses import dataclass
from datetime import timedelta
from typing import Any
from uuid import uuid4

import numpy as np
from sqlalchemy import delete, func, or_, select, update

from app.core.errors import AppError, Conflict409, Validation422
from app.db import get_session_factory
from app.models import Avatar, AvatarStatus, Creation, CreationStatus
from app.models.base import utcnow
from app.services.jobs import (
    ACTIVE_STATES,
    DONE,
    FAILED,
    INTERRUPTED,
    QUEUED,
    RUNNING,
    Job,
    run_cpu,
    runner,
)
from app.services.storage import get_storage

logger = logging.getLogger("liveface.creations")

# An org's unfinished creations. A resume list longer than this is a pile,
# not work in progress, and each one holds a few MB of images.
MAX_DRAFTS_PER_ORG = 10
MAX_UPLOAD_BYTES = 15 * 1024 * 1024
# A draft untouched this long is abandoned: its files go, its row stays a
# while (as expired) so a stale tab gets "expired" rather than "not found".
IDLE_EXPIRY = timedelta(days=7)
# Finished and expired rows are kept this long, then deleted.
ENDED_RETENTION = timedelta(days=30)
# A bigger turn than this is not levelling a photo, it is a different photo.
MAX_ROLL_DEGREES = 45.0
MIN_CROP_FRACTION = 0.15

STEP_ORDER = ("original", "framed", "cutout")
# AI point finding per creation (the vision model; cached answers are free).
AI_DETECTIONS_PER_CREATION = 1
ADJUSTED_PREFIX = "adjusted:"
CUTOUT = "cutout"
# The cut-out of an AI result "adjusted:N" is "cutout:N".
CUTOUT_PREFIX = "cutout:"
# The keys of photo_analysis.check_photo kept on each step.
CHECK_KEYS = (
    "detector", "detected", "face_box", "roll", "face_state", "checks", "recommendations",
)
FULL_FRAME = {"x": 0.0, "y": 0.0, "w": 1.0, "h": 1.0}
# In `steps`: {face_type, background} as they were before a stylised
# version was chosen, restored when the owner goes back to a picture that
# is not a drawing ("Keep my photo"). Dropped when the owner picks a line.
BEFORE_STYLISE = "before_stylise"


# --- Lines ----------------------------------------------------------------------


@dataclass(frozen=True)
class LineRules:
    """What the wizard does per line. M4's app/lines modules replace this
    table (detectors gain Gemini points behind consent, lines gain AI
    presets); until then it is the whole of the difference."""

    # "mediapipe": detect, and fall back to the face template when nothing
    # is found. "template": the face template, placed where a face usually is.
    detector: str
    # The person segmenter is trained on people. On a muzzle or a drawing it
    # cuts ears, whiskers and outlines, so only humans are offered it until
    # a general segmenter has been measured.
    background_removal: bool
    # Head/body layers depend on the same segmenter.
    layers: bool
    # May "Looks right" finish on the pre-filled marks? Never for an animal:
    # its marks are always a template guess.
    one_click: bool
    # The parts this line's owner marks (anchor_fit's scheme for the line).
    marks: tuple[str, ...]


LINES: dict[str, LineRules] = {
    "human": LineRules(
        detector="mediapipe", background_removal=True, layers=True, one_click=True,
        marks=("head", "left_eye", "right_eye", "mouth", "left_pupil", "right_pupil"),
    ),
    "cartoon": LineRules(
        detector="mediapipe", background_removal=False, layers=False, one_click=True,
        marks=(
            "head", "left_eye", "right_eye", "mouth_line", "chin", "left_pupil", "right_pupil",
        ),
    ),
    "animal": LineRules(
        detector="template", background_removal=False, layers=False, one_click=False,
        marks=("head", "left_eye", "right_eye", "mouth_line", "chin"),
    ),
}


def rules_for(face_type: str) -> LineRules:
    return LINES[face_type]


def required_marks(face_type: str, detected: bool) -> tuple[str, ...]:
    """The parts finish must be sent, because nothing but the owner vouches
    for where they sit.

    Every part, when the marks opened on the face template (an animal
    always; a person or a drawing the detector missed): a template is a
    guess, and nothing goes live on a guess. None when a detection on a
    one-click line put them there, since the owner may confirm it as found.
    """
    if detected and rules_for(face_type).one_click:
        return ()
    return rules_for(face_type).marks


# --- Storage layout ---------------------------------------------------------------


def creation_prefix(org_id: str, creation_id: str) -> str:
    return f"orgs/{org_id}/creations/{creation_id}/"


def incoming_key(org_id: str, creation_id: str) -> str:
    """The upload as received, until ingest has cleaned it. Private, and
    deleted as soon as the clean copy is stored; kept only so an ingest a
    restart interrupted can be retried without asking for the file again."""
    return f"{creation_prefix(org_id, creation_id)}incoming"


def step_key(org_id: str, creation_id: str, step: str) -> str:
    # A fresh key per image: a presigned URL a browser still holds keeps
    # pointing at the image it was issued for, and a discarded result can be
    # deleted without touching the one that replaced it.
    return f"{creation_prefix(org_id, creation_id)}{step}-{uuid4().hex[:12]}.png"


def avatar_prefix(org_id: str, avatar_id: str) -> str:
    return f"orgs/{org_id}/avatars/{avatar_id}/"


# --- Steps ----------------------------------------------------------------------


def step_items(steps: dict | None) -> dict[str, dict]:
    return (steps or {}).get("items") or {}


def current_step(steps: dict | None) -> str | None:
    return (steps or {}).get("current")


def adjusted_index(step_id: str) -> int | None:
    """N of "adjusted:N", or None for any other step id."""
    if not step_id.startswith(ADJUSTED_PREFIX):
        return None
    tail = step_id[len(ADJUSTED_PREFIX):]
    return int(tail) if tail.isdigit() else None


def is_cutout_id(step_id: str | None) -> bool:
    """A background removal's output: "cutout", or "cutout:N" (of adjusted:N)."""
    return bool(step_id) and (step_id == CUTOUT or step_id.startswith(CUTOUT_PREFIX))


def cutout_id_for(source_id: str) -> str:
    """The id the cut-out of `source_id` is stored under."""
    index = adjusted_index(source_id)
    return CUTOUT if index is None else f"{CUTOUT_PREFIX}{index}"


def is_cut_out(items: dict, step_id: str | None) -> bool:
    """Is the image transparent around the subject? A background removal's
    output, and a touch-up made from one (it keeps the cut-out's alpha)."""
    return is_cutout_id(step_id) or bool((items.get(step_id) or {}).get("cutout"))


def ordered_step_ids(items: dict) -> list[str]:
    """The steps in the wizard's order: original, framed, cut-out, then each
    AI result followed by its own cut-out."""
    adjusted = sorted(
        (i for i in items if adjusted_index(i) is not None), key=lambda i: adjusted_index(i)
    )
    ordered = [i for i in ("original", "framed", CUTOUT) if i in items]
    for step_id in adjusted:
        ordered.append(step_id)
        cut = cutout_id_for(step_id)
        if cut in items:
            ordered.append(cut)
    # Anything else (nothing today) still shows, last.
    return ordered + sorted(i for i in items if i not in ordered)


def _remove_steps(steps: dict, doomed: set[str]) -> list[str]:
    """Remove the steps `doomed` (in place); their keys, to delete.

    A surviving step made from a removed one now names what that one was
    made from, so every lineage stays walkable (an AI result made from a
    cut-out outlives the cut-out when the line changes). A removed current
    image hands over to its nearest surviving ancestor.
    """
    items = steps["items"]
    doomed = {i for i in doomed if i in items}
    if not doomed:
        return []

    def surviving(step_id: str | None) -> str | None:
        seen: set[str] = set()
        while step_id in doomed and step_id not in seen:
            seen.add(step_id)
            step_id = items[step_id].get("from")
        return step_id if step_id in items else None

    current = steps.get("current")
    if current in doomed:
        steps["current"] = surviving(current) or "original"
    for step_id, item in items.items():
        if step_id not in doomed and item.get("from") in doomed:
            item["from"] = surviving(item["from"])
    return [items.pop(i)["key"] for i in sorted(doomed)]


def drop_adjusted(steps: dict) -> list[str]:
    """Remove every AI adjust candidate and its cut-out (the frame they were
    made from changed); their keys, to delete."""
    items = steps["items"]
    return _remove_steps(
        steps,
        {i for i in items if adjusted_index(i) is not None or i.startswith(CUTOUT_PREFIX)},
    )


def drop_cutouts(steps: dict) -> list[str]:
    """Remove every cut-out, a touch-up of one included (the line changed,
    so the segmenter that made them no longer applies); their keys."""
    items = steps["items"]
    return _remove_steps(steps, {i for i in items if is_cut_out(items, i)})


def lineage(steps: dict | None, step_id: str | None) -> list[dict]:
    """The step `step_id` and every step it was made from, newest first."""
    items = step_items(steps)
    chain: list[dict] = []
    seen: set[str] = set()
    while step_id in items and step_id not in seen:
        seen.add(step_id)
        chain.append(items[step_id])
        step_id = items[step_id].get("from")
    return chain


def ai_edited_of(steps: dict | None, step_id: str | None) -> dict | None:
    """{mode, model} when an AI made or changed the image `step_id` shows:
    the latest adjust in its lineage, else a generated original. None for
    a photo as its owner gave it (framing and cut-outs are not AI edits)."""
    for item in lineage(steps, step_id):
        adjust = item.get("adjust")
        if adjust:
            return {"mode": adjust["mode"], "model": adjust.get("model")}
        generated = item.get("generated")
        if generated:
            return {"mode": "generate", "model": generated.get("model")}
    return None


def _detected_a_person(item: dict) -> bool:
    """Did the photo check find a human face on this image? MediaPipe's
    face landmarker is trained on people: a detection is a person's face,
    or a drawing close enough to one to be a likeness."""
    check = item.get("check") or {}
    return bool(check.get("detected")) and check.get("detector") == "mediapipe"


def statement_for(creation: Creation) -> str | None:
    """The uploader's statement finishing needs (a consent scope), or None.

    Tied to where the pixels came from, not to the line the creation is on
    now: a person's photo stays a person's photo when it is stylised into an
    animation, switched to another line, or chosen again after a stylise.
    So the lineage of the current image decides:

    - made from words by the image model: "generated_face" when it is a
      face of a person (on the human line, or one the check found), since
      "I am this person" cannot be true of it and a prompt can still ask
      for someone real; a picture redrawn from one of the org's avatars
      needs "depiction", like the photo it came from;
    - an upload: "depiction" when it is on the human line, or when the
      photo check found a human face on an image in its lineage that no AI
      made (the upload, its framing, its cut-out);
    - otherwise (an animal, a drawing the detector does not read as a
      face) nothing.
    """
    from app.services import consent

    steps = creation.steps
    chain = lineage(steps, current_step(steps))
    human_line = creation.face_type == "human"
    if not chain:
        return consent.DEPICTION if human_line else None
    root = chain[-1]
    generated = root.get("generated")
    if generated:
        if not (human_line or _detected_a_person(root)):
            return None
        return consent.DEPICTION if generated.get("source_avatar_id") else consent.GENERATED_FACE
    photographed = [item for item in chain if not item.get("adjust")]
    if human_line or any(_detected_a_person(item) for item in photographed):
        return consent.DEPICTION
    # A draft made before checks were kept per step: the upload's analysis.
    if all(item.get("check") is None for item in photographed):
        if (creation.analysis or {}).get("suggested_face_type") == "human":
            return consent.DEPICTION
    return None


def round_source(steps: dict | None, last_round: dict | None) -> str | None:
    """The image the last adjust round was made from, as a step that still
    exists.

    A round records its source's id, but that step can go later: choosing a
    stylised version drops the cut-outs (the animation line keeps its drawn
    backdrop), and the round may have been made from one. The candidates'
    `from` links were moved to the nearest surviving ancestor then
    (_remove_steps), so the first surviving candidate says where the round
    now comes from; without one, the original.
    """
    if not last_round:
        return None
    items = step_items(steps)
    source = last_round.get("source")
    if source in items:
        return source
    for candidate in last_round.get("candidates") or []:
        made = items.get(candidate.get("step") or "")
        if made and made.get("from") in items:
            return made["from"]
    return "original" if "original" in items else None


def stylised(steps: dict | None, step_id: str | None) -> bool:
    """Is the image `step_id` shows a stylised version (a drawing made by
    AI adjust from the photo), or made from one?"""
    return any(
        (item.get("adjust") or {}).get("mode") == "stylise" for item in lineage(steps, step_id)
    )


def _through_cutouts(steps: dict | None, step_id: str | None) -> str | None:
    """`step_id`, or when it is a background removal's output, the image it
    was cut from (repeatedly): the step whose pixels it shows."""
    items = step_items(steps)
    seen: set[str] = set()
    while is_cutout_id(step_id) and step_id in items and step_id not in seen:
        seen.add(step_id)
        source = items[step_id].get("from")
        if source not in items:
            break
        step_id = source
    return step_id if step_id in items else None


def frame_key(steps: dict | None, step_id: str | None) -> str | None:
    """The key of the image whose pixel grid `step_id` shares. A cut-out
    shares its source's (no pixel moved); every other step is its own, an
    AI result included (the model redrew it)."""
    source = _through_cutouts(steps, step_id)
    return step_items(steps)[source]["key"] if source else None


def check_of(steps: dict | None, step_id: str | None) -> dict | None:
    """The photo check of the image `step_id` shows (a cut-out shows its
    source's face, so it has its source's check). None for images made
    before checks were kept per step."""
    source = _through_cutouts(steps, step_id)
    return step_items(steps)[source].get("check") if source else None


def background_source(steps: dict | None) -> str | None:
    """The opaque image behind the current one: the current image, or when
    that is a cut-out (a touch-up of one included), the image it was cut
    from. What "keep the background" goes back to."""
    items = step_items(steps)
    step_id = current_step(steps)
    seen: set[str] = set()
    while is_cut_out(items, step_id) and step_id not in seen:
        seen.add(step_id)
        source = items[step_id].get("from")
        if source not in items:
            break
        step_id = source
    return step_id


def copied(steps: dict | None) -> dict:
    """A deep copy to edit: JSON columns are replaced, never mutated."""
    return copy.deepcopy(steps or {"current": None, "items": {}})


def step_check(check: dict) -> dict:
    """The part of a photo check (or of an analysis) a step keeps."""
    return {k: check.get(k) for k in CHECK_KEYS}


def recommendation_of(steps: dict | None, face_type: str | None) -> dict | None:
    """{image, mode, reasons}: what step 3 recommends for the CURRENT image
    on the creation's line (photo_analysis.recommend). None until the line
    is known, and for an image made before checks were kept per step."""
    from app.services.photo_analysis import recommend

    current = current_step(steps)
    check = check_of(steps, current)
    if face_type is None or check is None:
        return None
    found = (check.get("recommendations") or {}).get(face_type) or recommend(check, face_type)
    return {"image": current, "mode": found["mode"], "reasons": list(found["reasons"])}


# --- Job records --------------------------------------------------------------------


def error_record(code: str, detail: str) -> dict:
    return {"code": code, "detail": detail}


def job_record(
    job: Job, state: str, params: dict | None = None, error: dict | None = None
) -> dict:
    """What the row keeps of a job: its state transitions, and the
    parameters a retry needs while it may still be retried."""
    record = {
        "id": job.id,
        "step": job.step,
        "state": state,
        "error": error,
        "started_at": job.started_at,
    }
    if state != DONE:
        record["params"] = params or {}
    return record


async def _write_job(job: Job, state: str, params: dict, error: dict | None = None) -> None:
    """A state transition. Never touches the revision: a job must not
    invalidate its own result by reporting that it runs."""
    async with get_session_factory()() as db:
        await db.execute(
            update(Creation)
            .where(Creation.id == job.subject_id, Creation.org_id == job.org_id)
            .values(job=job_record(job, state, params, error))
        )
        await db.commit()


SUPERSEDED = error_record(
    "superseded", "The creation changed while this was running, so its result was discarded"
)


async def _store_result(job: Job, params: dict, values: dict, new_keys: list[str]) -> bool:
    """Store a job's result if the creation is still the one it started
    from; otherwise delete what the job wrote and say so. See the module
    docstring for why the revision decides."""
    async with get_session_factory()() as db:
        result = await db.execute(
            update(Creation)
            .where(
                Creation.id == job.subject_id,
                Creation.org_id == job.org_id,
                Creation.revision == job.revision,
                Creation.status == CreationStatus.draft,
            )
            .values(**values, revision=Creation.revision + 1, job=job_record(job, DONE))
        )
        await db.commit()
    if result.rowcount == 1:
        return True
    storage = get_storage()
    for key in new_keys:
        await storage.delete(key)
    await _write_job(job, FAILED, params, SUPERSEDED)
    logger.info("job %s (%s) discarded: creation %s changed", job.id, job.step, job.subject_id)
    return False


def ai_usage_of(creation: Creation) -> dict:
    """A copy of the creation's AI budget and cache, with every field."""
    usage = copy.deepcopy(creation.ai_usage or {})
    usage.setdefault("adjust_rounds", 0)
    usage.setdefault("detections", 0)
    usage.setdefault("next_adjusted", 0)
    usage.setdefault("vision_cache", [])
    return usage


async def _update_ai_usage(job: Job, change: Callable[[dict], None]) -> None:
    """Apply `change` to the stored AI usage, outside the revision rule.

    The budget and the cache record money already spent, which stays spent
    whether or not the job's image result is kept; tying them to the
    revision would let a reframe mid-call refund a paid request, or lose a
    paid answer. Safe without a condition because the only other writer is
    job admission, which cannot happen while this job is active.
    """
    async with get_session_factory()() as db:
        row = (
            await db.execute(
                select(Creation).where(
                    Creation.id == job.subject_id, Creation.org_id == job.org_id
                )
            )
        ).scalar_one_or_none()
        if row is None:
            return
        usage = ai_usage_of(row)
        change(usage)
        await db.execute(
            update(Creation)
            .where(Creation.id == job.subject_id, Creation.org_id == job.org_id)
            .values(ai_usage=usage)
        )
        await db.commit()


async def _ai_switched_off(org_id: str) -> bool:
    """Has the organization turned third-party AI off since the job was
    admitted?

    Admission checks the switch, but a job can wait in the queue for
    minutes and an adjust round makes two calls 90 s apart: an owner who
    turns AI off (after a complaint, say) means no pixel leaves from then
    on, not from the next request. So it is read again before every
    provider call, next to the image limit.
    """
    from app.models import Organization

    async with get_session_factory()() as db:
        enabled = (
            await db.execute(
                select(Organization.third_party_ai_enabled).where(Organization.id == org_id)
            )
        ).scalar_one_or_none()
    return not enabled


def _ai_disabled_error() -> AppError:
    from app.core.errors import Forbidden403

    return Forbidden403(
        "Your organization turned off third-party AI, so nothing was sent",
        code="third_party_ai_disabled",
    )


async def _load(job: Job) -> Creation | None:
    async with get_session_factory()() as db:
        return (
            await db.execute(
                select(Creation).where(
                    Creation.id == job.subject_id, Creation.org_id == job.org_id
                )
            )
        ).scalar_one_or_none()


# --- Starting jobs ------------------------------------------------------------------


async def start_job(
    db,
    creation: Creation,
    step: str,
    params: dict,
    values: dict | None = None,
    bump: bool = False,
) -> Job:
    """Accept a job for `creation` and launch it.

    Admission first (runner.reserve: 409, 429 or 503), then the queued state
    is written with the same revision condition every mutation uses, so a
    job is never accepted against a state that already changed. `values`
    rides along in that write (finish uses it for draft → finishing), and
    anything the caller added to `db` is committed with it.

    `bump`: `values` change the content (choosing an AI result, whose
    cut-out the job makes), so the revision moves on in the same write and
    the job belongs to the state after it. Either both happen or neither:
    a refused admission leaves the choice unmade.
    """
    revision = creation.revision + (1 if bump else 0)
    job = runner.reserve(creation.org_id, creation.id, step, revision)
    extra = {"revision": Creation.revision + 1} if bump else {}
    try:
        result = await db.execute(
            update(Creation)
            .where(
                Creation.id == creation.id,
                Creation.org_id == creation.org_id,
                Creation.revision == creation.revision,
                Creation.status == CreationStatus.draft,
            )
            .values(job=job_record(job, QUEUED, params), **(values or {}), **extra)
        )
        if result.rowcount != 1:
            await db.rollback()
            raise Conflict409("The creation changed; reload it", code="creation_changed")
        await db.commit()
    except BaseException:
        runner.release(job)
        raise
    launch(job, params)
    return job


def launch(job: Job, params: dict) -> None:
    runner.start(job, lambda j: _run(j, params))


async def _run(job: Job, params: dict) -> None:
    """Run a job's work and record how it ended. The work records success
    itself, in the same write as its result."""
    await _write_job(job, RUNNING, params)
    try:
        await WORKS[job.step](job, params)
    except AppError as exc:
        logger.info("job %s (%s) failed: %s", job.id, job.step, exc.detail)
        await _write_job(job, FAILED, params, error_record(exc.code, exc.detail))
    except Exception:
        logger.exception("job %s (%s) crashed", job.id, job.step)
        await _write_job(
            job, FAILED, params, error_record("job_failed", "Something went wrong; try again")
        )


# --- Ingest -----------------------------------------------------------------------


async def _ingest(job: Job, params: dict) -> None:
    from app.services.photo_analysis import analyse
    from app.services.photo_io import STORED_MAX_EDGE, ingest_photo

    storage = get_storage()
    incoming = incoming_key(job.org_id, job.subject_id)
    raw = await storage.get_bytes(incoming)
    job.report(0.1, "reading")
    try:
        clean = await run_cpu(ingest_photo, raw, STORED_MAX_EDGE)
    except Validation422:
        # The file itself is the problem; retrying cannot help, and the raw
        # upload (EXIF and all) has no reason to stay.
        await storage.delete(incoming)
        raise
    job.report(0.5, "analysing")
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
            }
        },
    }
    stored = await _store_result(
        job,
        params,
        {
            "steps": steps,
            "analysis": _stored_analysis(analysis),
            # The owner's choice at upload stands; otherwise the suggestion,
            # which is null when no face was found (the wizard then asks).
            "face_type": func.coalesce(Creation.face_type, analysis["suggested_face_type"]),
        },
        [key],
    )
    if stored:
        await storage.delete(incoming)


def _stored_analysis(analysis: dict) -> dict:
    """The upload's analysis as the creation keeps it: what step 1 reads.
    The per-line recommendations live on each step's check, so the one the
    wizard shows is always the current image's (api.creations)."""
    return {k: v for k, v in analysis.items() if k != "recommendations"}


# --- Background -------------------------------------------------------------------


async def _background(job: Job, params: dict) -> None:
    """Cut the subject out of `params["source"]` and make the cut-out the
    current image. Also what choosing an AI result runs, chained, when the
    owner chose to remove the background: the new picture is opaque."""
    from app.services import segment

    creation = await _load(job)
    if creation is None:
        return
    source_id = params["source"]
    source = step_items(creation.steps).get(source_id)
    if source is None:
        await _write_job(job, FAILED, params, SUPERSEDED)
        return
    storage = get_storage()
    data = await storage.get_bytes(source["key"])
    job.report(0.2, "removing background")
    try:
        # segment.remove_background writes through photo_io.png_bytes, which
        # zeroes the colour under alpha 0: the room is removed from the file,
        # not hidden in it.
        cut_out = await run_cpu(segment.remove_background, data)
    except segment.SegmentationUnavailable as exc:
        raise Conflict409(
            "Background removal is not configured on this server",
            code="segmentation_unavailable",
        ) from exc
    job.report(0.8, "saving")
    cut_id = cutout_id_for(source_id)
    key = step_key(job.org_id, job.subject_id, cut_id.replace(":", ""))
    await storage.put_bytes(key, cut_out, "image/png")
    steps = copied(creation.steps)
    previous = steps["items"].get(cut_id)
    steps["items"][cut_id] = {
        "key": key, "width": source["width"], "height": source["height"], "from": source_id,
        "cutout": True,
    }
    steps["current"] = cut_id
    # The owner's step 2 answer, which choosing an AI result later follows.
    steps["background"] = "remove"
    if await _store_result(job, params, {"steps": steps}, [key]) and previous:
        await storage.delete(previous["key"])


# --- Detection and fitting --------------------------------------------------------


def detect_anchors(png: bytes, face_type: str) -> dict:
    """The base mesh and the marks the wizard opens on. CPU work.

    The base is what every fit of these marks starts from, exactly as an
    avatar's fit-base.json is: the detection, else the face template placed
    where a face usually is. The marks sit on the very landmarks they attach
    to (anchor_fit.marks_from_mesh, in the line's scheme), so a good
    detection means dragging nothing. M4 adds Gemini points here, behind
    consent, for the lines MediaPipe cannot see.
    """
    from PIL import Image

    from app.services import face_template, landmarks
    from app.services.anchor_fit import (
        FaceMarks,
        fit_rig,
        marks_from_dict,
        marks_from_mesh,
        marks_to_dict,
    )
    from app.services.photo_io import on_backdrop
    from app.services.riggable import check_landmarks
    from app.services.rig import build_rig

    # A cut-out on the neutral grey, as the photo check and the AI see it.
    with Image.open(io.BytesIO(png)) as opened:
        image = on_backdrop(opened)
    size = image.size
    points, detected = None, False
    if rules_for(face_type).detector == "mediapipe":
        try:
            found = landmarks.detect(image)
        except landmarks.LandmarkerUnavailable:
            found = None
        if found is not None:
            points, detected = found.points, True
    if points is None:
        points = face_template.place(face_template.default_box(*size))
    # Rounded as stored, so the fit reported now is the fit finish repeats.
    base = np.round(np.asarray(points, dtype=np.float64), 3)

    skeleton = build_rig(base, size, None, face_type=face_type)
    opened, _ = fit_rig(skeleton, base, FaceMarks(), face_type)
    stored = marks_to_dict(marks_from_mesh(np.array(opened["points"]), face_type))
    _, problems = fit_rig(skeleton, base, marks_from_dict(stored, face_type), face_type)

    warnings = []
    if face_type == "human" and detected:
        verdict = check_landmarks(base, size, detected=True)
        if not verdict.ok:
            warnings.append(error_record(verdict.code or "photo_check", verdict.reason or ""))
    ok = not problems
    return {
        "image_size": list(size),
        "detected": detected,
        "base": base.tolist(),
        "marks": stored,
        "validation": {
            "ok": ok,
            "reasons": [
                {"code": p.code, "detail": p.detail, "count": p.count} for p in problems
            ],
            "warnings": warnings,
            "detected": detected,
            # "Looks right" in one click: the validator is happy with a real
            # detection on a line that allows it, and nothing looks off.
            "one_click": ok and detected and rules_for(face_type).one_click and not warnings,
        },
    }


def fit_from_anchors(anchors: dict, sent: dict | None, face_type: str):
    """(rig, problems): the rig finish would build from these anchors and
    the marks the client sent, merged over the stored ones (a region left
    out keeps its stored marking). Always fitted from the stored base, so
    preview and finish cannot disagree."""
    from app.services.anchor_fit import fit_rig, marks_from_dict, merge
    from app.services.rig import build_rig

    base = np.array(anchors["base"], dtype=np.float64)
    size = tuple(anchors["image_size"])
    skeleton = build_rig(base, size, None, face_type=face_type)
    marks = merge(
        marks_from_dict(anchors.get("marks"), face_type), marks_from_dict(sent, face_type)
    )
    return fit_rig(skeleton, base, marks, face_type)


# How many point-finder answers a creation keeps: the image it is on, and
# the one before (choosing back and forth between two costs nothing).
VISION_CACHE_SIZE = 2


def vision_cache_hit(usage: dict, digest: str, face_type: str) -> dict | None:
    """Cached point-finder answer for these pixels, this line, this model."""
    from app.services.vision_points import MODEL

    for entry in usage.get("vision_cache") or []:
        if (entry.get("sha256"), entry.get("face_type"), entry.get("model")) == (
            digest, face_type, MODEL
        ):
            return entry["points"]
    return None


def wants_ai_points(face_type: str, detected: bool) -> bool:
    """Is the point finder worth asking? For an animal always (MediaPipe
    never sees one), for an animation only when MediaPipe found nothing, and
    never for a person, whom MediaPipe fits better than any pointer."""
    return face_type == "animal" or (face_type == "cartoon" and not detected)


def source_on_backdrop(data: bytes) -> tuple[bytes, str]:
    """An image as it may be sent to a model: opaque, a cut-out on the
    neutral grey (photo_io.on_backdrop, never the black under alpha 0 nor
    the removed background), shrunk to imagegen.SOURCE_MAX_EDGE, as JPEG.
    CPU work."""
    from PIL import Image

    from app.services.imagegen import SOURCE_MAX_EDGE, SOURCE_QUALITY
    from app.services.photo_io import on_backdrop

    with Image.open(io.BytesIO(data)) as opened:
        image = on_backdrop(opened)
    if max(image.size) > SOURCE_MAX_EDGE:
        image.thumbnail((SOURCE_MAX_EDGE, SOURCE_MAX_EDGE), Image.Resampling.LANCZOS)
    out = io.BytesIO()
    image.save(out, format="JPEG", quality=SOURCE_QUALITY, optimize=True)
    return out.getvalue(), "image/jpeg"


async def _ai_points(job: Job, params: dict, data: bytes, face_type: str, size) -> tuple[
    dict | None, dict | None
]:
    """(anchors, warning): the point finder's anchors, or why not.

    Never fails the detection: a refused, failed or implausible answer
    falls back to what the detector found (or the template), with the
    reason shown beside it. Only an answer the provider actually gave
    spends the detection budget; everything else refunds it.
    """
    from app.services import vision_points
    from app.services.usage import check_vision_limit, record_vision

    creation = await _load(job)
    digest = params.get("sha256")
    points = vision_cache_hit(ai_usage_of(creation), digest, face_type) if creation else None
    if points is None:
        called = False
        warning = None
        try:
            if await _ai_switched_off(job.org_id):
                raise _ai_disabled_error()
            async with get_session_factory()() as db:
                await check_vision_limit(db, job.org_id)
            job.report(0.4, "asking the AI for the points")
            payload, mime = await run_cpu(source_on_backdrop, data)
            points = await vision_points.request_points(payload, mime, face_type)
            called = True
        except AppError as exc:  # the monthly limit, or AI switched off
            warning = error_record(exc.code, exc.detail)
        except vision_points.VisionError as exc:
            called = exc.answered
            warning = error_record(exc.code, exc.detail)
        if called:
            async with get_session_factory()() as db:
                await record_vision(db, job.org_id, vision_points.PROVIDER)
        answered = points

        def settle(usage: dict) -> None:
            # Only a call the provider answered spends the detection.
            if not called and params.get("charged"):
                usage["detections"] = max(0, usage["detections"] - 1)
            if answered is not None:
                entry = {
                    "sha256": digest, "face_type": face_type,
                    "model": vision_points.MODEL, "points": answered,
                }
                usage["vision_cache"] = (usage["vision_cache"] + [entry])[-VISION_CACHE_SIZE:]

        await _update_ai_usage(job, settle)
    else:
        warning = None
    if points is None:
        return None, warning
    job.report(0.7, "checking the points")
    result = await run_cpu(vision_points.anchors_from_points, points, size, face_type)
    if result.anchors is None:
        return None, error_record(
            "ai_points_implausible",
            "The AI's points did not fit this face (" + "; ".join(result.problems)
            + "); they were placed from the template instead",
        )
    return result.anchors, None


async def _detect(job: Job, params: dict) -> None:
    creation = await _load(job)
    if creation is None:
        return
    current = current_step(creation.steps)
    image = step_items(creation.steps).get(current)
    if image is None or creation.face_type is None:
        await _write_job(job, FAILED, params, SUPERSEDED)
        return
    face_type = creation.face_type
    job.report(0.2, "finding the face")
    data = await get_storage().get_bytes(image["key"])
    found = await run_cpu(detect_anchors, data, face_type)
    source = "mediapipe" if found["detected"] else "template"
    if params.get("use_ai"):
        ai, warning = None, None
        if wants_ai_points(face_type, found["detected"]):
            ai, warning = await _ai_points(
                job, params, data, face_type, tuple(found["image_size"])
            )
        else:
            # MediaPipe found this face; the budget admission took is returned.
            def refund(usage: dict) -> None:
                usage["detections"] = max(0, usage["detections"] - 1)

            if params.get("charged"):
                await _update_ai_usage(job, refund)
        if ai is not None:
            found, source = ai, "ai"
        elif warning is not None:
            found["validation"]["warnings"].append(warning)
    anchors = {
        "id": uuid4().hex,
        "frame": frame_key(creation.steps, current),
        "face_type": face_type,
        "source": source,
        **found,
    }
    await _store_result(job, params, {"anchors": anchors}, [])


def anchors_are_current(creation: Creation) -> bool:
    anchors = creation.anchors
    return bool(
        anchors
        and anchors.get("face_type") == creation.face_type
        and anchors.get("frame") == frame_key(creation.steps, current_step(creation.steps))
    )


# --- AI adjust ------------------------------------------------------------------

# What each mode is recorded as in usage (usage.IMAGE_CALLS).
ADJUST_CALLS = {
    "touchup": "adjust_touchup",
    "stylise": "adjust_stylise",
    "regenerate": "adjust_regen",
}


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


# --- Generation ---------------------------------------------------------------------


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
    await _store_result(
        job, params, {"steps": steps, "analysis": _stored_analysis(analysis)}, [key]
    )


# --- Finish -----------------------------------------------------------------------


async def _finish(job: Job, params: dict) -> None:
    """Build the avatar from the confirmed marks, publish it, and let the
    creation go. Any failure puts the creation back to draft and removes
    the half-built avatar, so pressing Finish again starts clean."""
    storage = get_storage()
    async with get_session_factory()() as db:
        creation = (
            await db.execute(
                select(Creation).where(
                    Creation.id == job.subject_id,
                    Creation.org_id == job.org_id,
                    Creation.status == CreationStatus.finishing,
                )
            )
        ).scalar_one_or_none()
        if creation is None:
            return
        # Read now: a rollback expires the instance, and an async session
        # cannot lazily reload it inside the handler below.
        org_id, creation_id, avatar_id = creation.org_id, creation.id, creation.avatar_id
        generated = (step_items(creation.steps).get("original") or {}).get("generated")
        avatar = (
            await db.execute(select(Avatar).where(Avatar.id == avatar_id, Avatar.org_id == org_id))
        ).scalar_one_or_none()
        try:
            if avatar is None:
                raise RuntimeError("the avatar being finished is gone")
            await _build_avatar(job, creation, avatar, params, storage)
            result = await db.execute(
                update(Creation)
                .where(Creation.id == creation_id, Creation.status == CreationStatus.finishing)
                .values(status=CreationStatus.finished, job=job_record(job, DONE))
            )
            if result.rowcount != 1:
                raise RuntimeError("the creation left finishing while it was built")
            await db.commit()
        except Exception:
            await db.rollback()
            await _undo_finish_retrying(org_id, creation_id, avatar_id)
            raise
    # The avatar has its own copies now. Deleted after the commit, so a crash
    # in between leaves files the retention sweep removes, never an avatar
    # pointing at nothing.
    await storage.delete_prefix(creation_prefix(org_id, creation_id))
    if generated:
        # A generated picture someone kept: what the usage page counts as a
        # generated avatar (attempts are counted as they are made).
        from app.services.usage import record_generated_avatar

        try:
            async with get_session_factory()() as db:
                await record_generated_avatar(db, org_id, generated.get("provider") or "gemini")
        except Exception:
            logger.exception("could not record the kept generation of %s", creation_id)


async def _build_avatar(
    job: Job, creation: Creation, avatar: Avatar, params: dict, storage
) -> None:
    from app.services.anchor_fit import fit_base_key, fit_base_record, write_fit_base
    from app.services.layers import store_layers
    from app.services.publishing import publish
    from app.services.rig import make_thumbnail, write_thumbnail_key

    face_type = creation.face_type
    steps = creation.steps
    items = step_items(steps)
    current = current_step(steps)
    anchors = creation.anchors
    # Re-checked here, not only at the request: a retry after a restart
    # runs on whatever the row holds now.
    if not anchors_are_current(creation) or anchors.get("id") != params.get("anchors_id"):
        raise Conflict409(
            "The marks belong to another image; place them again", code="anchors_stale"
        )
    rig, problems = fit_from_anchors(anchors, params.get("marks"), face_type)
    if problems:
        raise Validation422(
            "These marks would distort the face: " + "; ".join(p.detail for p in problems),
            code="fit_invalid",
        )

    prefix = avatar_prefix(avatar.org_id, avatar.id)
    stamp = uuid4().hex[:8]
    job.report(0.1, "copying images")

    async def copy_step(step_id: str, name: str) -> tuple[str, bytes]:
        data = await storage.get_bytes(items[step_id]["key"])
        key = f"{prefix}{name}-{stamp}.png"
        await storage.put_bytes(key, data, "image/png")
        return key, data

    avatar.image_key, image = await copy_step(current, "source")
    behind = background_source(steps)
    if behind != current and behind in items:
        # The photo before its background came off, so the avatar page can
        # offer to put the background back, as for any other cut-out.
        if is_cutout_id(current):
            avatar.original_image_key, _ = await copy_step(behind, "source-original")
        else:
            # A touch-up of a cut-out: its new eyes and lips over the photo
            # it was cut from, so putting the background back keeps them.
            backdrop = await storage.get_bytes(items[behind]["key"])
            opaque = await run_cpu(_over, image, backdrop)
            if opaque is not None:
                key = f"{prefix}source-original-{stamp}.png"
                await storage.put_bytes(key, opaque, "image/png")
                avatar.original_image_key = key
    avatar.upload_image_key, _ = await copy_step("original", "upload")

    job.report(0.35, "building the rig")
    rig_key = f"{prefix}rig.json"
    await storage.put_bytes(rig_key, json.dumps(rig).encode(), "application/json")
    base = np.array(anchors["base"], dtype=np.float64)
    await write_fit_base(
        storage,
        fit_base_key(avatar.org_id, avatar.id),
        fit_base_record(base, rig, bool(anchors.get("detected"))),
    )
    thumb, thumb_type = await run_cpu(make_thumbnail, image)
    thumb_key = write_thumbnail_key(avatar.org_id, avatar.id, thumb_type)
    await storage.put_bytes(thumb_key, thumb, thumb_type)

    avatar.has_layers = False
    if rules_for(face_type).layers:
        job.report(0.55, "building layers")
        # Optional by contract, as in the first build: no layers is a
        # working single-photo avatar.
        avatar.has_layers = await store_layers(avatar, storage, image, rig["face_box"])

    warnings = (anchors.get("validation") or {}).get("warnings") or []
    avatar.rig_key = rig_key
    avatar.thumbnail_key = thumb_key
    avatar.content_type = "image/png"
    avatar.status = AvatarStatus.ready
    avatar.error = None
    avatar.quality_note = warnings[0]["detail"] if warnings else None
    job.report(0.8, "publishing")
    await publish(avatar, storage)


def _over(cut_out: bytes, backdrop: bytes) -> bytes | None:
    """`cut_out` composited over `backdrop` (same size), as an opaque PNG;
    None when their sizes differ. CPU work."""
    from PIL import Image

    from app.services.photo_io import png_bytes

    with Image.open(io.BytesIO(cut_out)) as top, Image.open(io.BytesIO(backdrop)) as below:
        if top.size != below.size:
            return None
        merged = Image.alpha_composite(below.convert("RGBA"), top.convert("RGBA"))
        return png_bytes(merged.convert("RGB"))


async def _undo_finish(org_id: str, creation_id: str, avatar_id: str | None) -> None:
    """Back to a draft, without the avatar that was being built."""
    async with get_session_factory()() as db:
        if avatar_id:
            await db.execute(
                delete(Avatar).where(
                    Avatar.id == avatar_id,
                    Avatar.org_id == org_id,
                    Avatar.status != AvatarStatus.ready,
                )
            )
        await db.execute(
            update(Creation)
            .where(Creation.id == creation_id, Creation.status == CreationStatus.finishing)
            .values(status=CreationStatus.draft, avatar_id=None)
        )
        await db.commit()
    if avatar_id:
        await get_storage().delete_prefix(avatar_prefix(org_id, avatar_id))


# Waits between attempts to put a failed finish back to draft. What failed
# the finish is often what fails the undo (SQLite still locked after its busy
# timeout), and that clears in seconds.
UNDO_FINISH_BACKOFF_SECONDS = (1.0, 3.0)


async def _undo_finish_retrying(org_id: str, creation_id: str, avatar_id: str | None) -> None:
    """_undo_finish, tried again a couple of times before giving up.

    Given up, the creation stays `finishing` with no task working on it, and
    nothing the owner can press moves it (Finish answers with the avatar,
    Delete refuses). recover_stranded, on the sweeper's timer and at startup,
    is what puts it back then; retrying here keeps that the rare case rather
    than an hour-long spinner.
    """
    for delay in (*UNDO_FINISH_BACKOFF_SECONDS, None):
        try:
            await _undo_finish(org_id, creation_id, avatar_id)
            return
        except Exception:
            if delay is None:
                logger.exception(
                    "could not put creation %s back to draft; the sweeper will", creation_id
                )
                return
            logger.warning("undoing finish of creation %s failed; retrying", creation_id)
            await asyncio.sleep(delay)


WORKS = {
    "ingest": _ingest,
    "generate": _generate,
    "background": _background,
    "adjust": _adjust,
    "detect": _detect,
    "finish": _finish,
}


# --- Restart and expiry ------------------------------------------------------------

INTERRUPTED_ERROR = error_record(
    "interrupted", "This was interrupted by a server restart; try again"
)


async def recover_interrupted(db, running: Callable[[str], bool] = lambda _id: False) -> int:
    """Creations no task is working on any more, put where the owner can act.

    Two states need a live task to ever leave them: a job record left queued
    or running, and the `finishing` status. At startup no task is live (the
    previous process's died with it), so every such row is stranded. Later,
    `running` says which creations still have a task in this process, and a
    row in either state without one was stranded by a failure in the failure
    path (the undo of a finish, or the job's FAILED write, could not reach
    the database). Without this the wizard would wait forever.

    The job becomes interrupted and retryable (a job that did record its
    failure keeps that record). A creation caught finishing goes back to
    draft, and the avatar it was building (never published: the final
    commit publishes and finishes in one transaction) is removed with its
    files. Returns the number of creations recovered.
    """
    stranded = or_(
        Creation.job["state"].as_string().in_(sorted(ACTIVE_STATES)),
        Creation.status == CreationStatus.finishing,
    )
    rows = (await db.execute(select(Creation).where(stranded))).scalars().all()
    orphans: list[tuple[str, str]] = []
    recovered = 0
    for creation in rows:
        if running(creation.id):
            continue
        # Read before the update, which synchronises the loaded row with the
        # values it sets (avatar_id becomes None).
        org_id, avatar_id, status = creation.org_id, creation.avatar_id, creation.status
        record = creation.job or {}
        values: dict[str, Any] = {}
        # Only the state as read: a job accepted since then (a new record id,
        # a new status) is live and not this pass's to touch.
        where = [Creation.id == creation.id, Creation.status == status]
        if record.get("id"):
            where.append(Creation.job["id"].as_string() == record["id"])
        if record.get("state") in ACTIVE_STATES:
            values["job"] = {**record, "state": INTERRUPTED, "error": INTERRUPTED_ERROR}
        finishing = status == CreationStatus.finishing
        if finishing:
            values.update(status=CreationStatus.draft, avatar_id=None)
        result = await db.execute(update(Creation).where(*where).values(**values))
        if result.rowcount != 1:
            continue
        recovered += 1
        if finishing and avatar_id:
            await db.execute(
                delete(Avatar).where(
                    Avatar.id == avatar_id,
                    Avatar.org_id == org_id,
                    Avatar.status != AvatarStatus.ready,
                )
            )
            orphans.append((org_id, avatar_id))
    await db.commit()
    storage = get_storage()
    for org_id, avatar_id in orphans:
        await storage.delete_prefix(avatar_prefix(org_id, avatar_id))
    return recovered


async def recover_stranded() -> int:
    """recover_interrupted while this process runs: only creations with no
    task in the runner. The sweeper calls it on its timer."""
    async with get_session_factory()() as db:
        recovered = await recover_interrupted(
            db, running=lambda creation_id: runner.active_for(creation_id) is not None
        )
    if recovered:
        logger.warning("recovered %d stranded creation(s)", recovered)
    return recovered


async def expire_idle() -> int:
    """Expire drafts idle past IDLE_EXPIRY and delete their files; purge
    finished and expired rows past ENDED_RETENTION. The number expired.

    By rows, not by file age: a draft someone resumes today keeps images
    uploaded a week ago. A draft with a job running is never expired under it.
    """
    now = utcnow()
    storage = get_storage()
    expired: list[str] = []
    async with get_session_factory()() as db:
        idle = (
            await db.execute(
                select(Creation.id, Creation.org_id, Creation.job).where(
                    Creation.status == CreationStatus.draft,
                    Creation.updated_at < now - IDLE_EXPIRY,
                )
            )
        ).all()
        for creation_id, org_id, job in idle:
            if runner.active_for(creation_id) or (job or {}).get("state") in ACTIVE_STATES:
                continue
            result = await db.execute(
                update(Creation)
                .where(
                    Creation.id == creation_id,
                    Creation.status == CreationStatus.draft,
                    Creation.updated_at < now - IDLE_EXPIRY,
                )
                .values(status=CreationStatus.expired, steps=None, anchors=None)
            )
            if result.rowcount == 1:
                expired.append(creation_prefix(org_id, creation_id))
        ended = (
            await db.execute(
                select(Creation.id, Creation.org_id).where(
                    Creation.status.in_([CreationStatus.finished, CreationStatus.expired]),
                    Creation.updated_at < now - ENDED_RETENTION,
                )
            )
        ).all()
        if ended:
            await db.execute(delete(Creation).where(Creation.id.in_([row[0] for row in ended])))
        await db.commit()
    # Idempotent, so a finish that crashed before deleting its files is
    # cleaned up here too.
    for prefix in expired + [creation_prefix(org_id, cid) for cid, org_id in ended]:
        await storage.delete_prefix(prefix)
    if expired:
        logger.info("expired %d idle creation(s)", len(expired))
    return len(expired)
