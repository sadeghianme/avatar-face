"""The creation wizard's work: images, analysis, marks, jobs and finishing.

A creation (app.models.creation) is one photo's way to an avatar:

    ingest → [frame] → [background] → detect → finish
    original   framed     cutout       anchors   avatar, published

Each image the wizard makes is a new STEP with its own storage key; nothing
overwrites the upload, and clients name steps by id ("original", "framed",
"cutout"), never by key. AI adjust (M4) slots in as "adjusted:N" between
framed and cutout.

Three rules carry the module.

**A result lands only on the state it was computed from.** Every job records
the creation's revision when it was accepted, and stores its result with
`UPDATE … WHERE revision = :rev`. If the owner re-framed, switched line or
chose another image meanwhile, the result describes a state that no longer
exists; it is discarded, and its files deleted, rather than grafted on.

**Marks belong to a pixel frame.** Anchors are stored with the key of the
image whose pixels they were placed on. Framing makes a new frame and clears
them; a cut-out does not (no pixel moves), so they survive background
removal and choosing between an image and its cut-out.

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
FULL_FRAME = {"x": 0.0, "y": 0.0, "w": 1.0, "h": 1.0}


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


def frame_key(steps: dict | None, step_id: str | None) -> str | None:
    """The key of the image whose pixel grid `step_id` shares. A cut-out
    shares its source's (no pixel moved); every other step is its own."""
    items = step_items(steps)
    seen = set()
    while step_id in items and step_id not in seen:
        seen.add(step_id)
        item = items[step_id]
        if step_id != "cutout" or not item.get("from"):
            return item["key"]
        step_id = item["from"]
    return None


def background_source(steps: dict | None) -> str | None:
    """The image background removal applies to: the current one, or when
    that is already a cut-out, the image it was cut from."""
    current = current_step(steps)
    if current == "cutout":
        return step_items(steps)["cutout"].get("from")
    return current


def copied(steps: dict | None) -> dict:
    """A deep copy to edit: JSON columns are replaced, never mutated."""
    return copy.deepcopy(steps or {"current": None, "items": {}})


def drop_cutout(steps: dict) -> str | None:
    """Remove the cut-out step (its source changed); its key, to delete."""
    items = steps["items"]
    cutout = items.pop("cutout", None)
    if cutout is None:
        return None
    if steps.get("current") == "cutout":
        steps["current"] = cutout.get("from") if cutout.get("from") in items else "original"
    return cutout["key"]


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
) -> Job:
    """Accept a job for `creation` and launch it.

    Admission first (runner.reserve: 409, 429 or 503), then the queued state
    is written with the same revision condition every mutation uses, so a
    job is never accepted against a state that already changed. `values`
    rides along in that write (finish uses it for draft → finishing), and
    anything the caller added to `db` is committed with it.
    """
    job = runner.reserve(creation.org_id, creation.id, step, creation.revision)
    try:
        result = await db.execute(
            update(Creation)
            .where(
                Creation.id == creation.id,
                Creation.org_id == creation.org_id,
                Creation.revision == creation.revision,
                Creation.status == CreationStatus.draft,
            )
            .values(job=job_record(job, QUEUED, params), **(values or {}))
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
        "items": {"original": {"key": key, "width": width, "height": height, "from": None}},
    }
    stored = await _store_result(
        job,
        params,
        {
            "steps": steps,
            "analysis": analysis,
            # The owner's choice at upload stands; otherwise the suggestion,
            # which is null when no face was found (the wizard then asks).
            "face_type": func.coalesce(Creation.face_type, analysis["suggested_face_type"]),
        },
        [key],
    )
    if stored:
        await storage.delete(incoming)


# --- Background -------------------------------------------------------------------


async def _background(job: Job, params: dict) -> None:
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
    key = step_key(job.org_id, job.subject_id, "cutout")
    await storage.put_bytes(key, cut_out, "image/png")
    steps = copied(creation.steps)
    previous = steps["items"].get("cutout")
    steps["items"]["cutout"] = {
        "key": key, "width": source["width"], "height": source["height"], "from": source_id,
    }
    steps["current"] = "cutout"
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
    from app.services.riggable import check_landmarks
    from app.services.rig import build_rig

    image = Image.open(io.BytesIO(png)).convert("RGB")
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


async def _detect(job: Job, params: dict) -> None:
    creation = await _load(job)
    if creation is None:
        return
    current = current_step(creation.steps)
    image = step_items(creation.steps).get(current)
    if image is None or creation.face_type is None:
        await _write_job(job, FAILED, params, SUPERSEDED)
        return
    job.report(0.2, "finding the face")
    data = await get_storage().get_bytes(image["key"])
    found = await run_cpu(detect_anchors, data, creation.face_type)
    anchors = {
        "id": uuid4().hex,
        "frame": frame_key(creation.steps, current),
        "face_type": creation.face_type,
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
    if current == "cutout" and items["cutout"].get("from") in items:
        # The photo before its background came off, so the avatar page can
        # offer to put the background back, as for any other cut-out.
        avatar.original_image_key, _ = await copy_step(items["cutout"]["from"], "source-original")
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
    "background": _background,
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
