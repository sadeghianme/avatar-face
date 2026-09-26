"""The performance kit, wired: a person's own mouth shapes and teeth, made
at Finish (Step 5, "Preparing your avatar") and from the Mouth panel,
stored as the avatar's own motion, fitted, metered and disclosed.

services.performance_kit makes the kit from a picture and its confirmed
points with an injected edit function. This module is everything around
it: which calls may go, what they cost, where the result lives, what the
owner and visitors are told, and how it follows the avatar's later edits.

**Who may send.** As for every AI step: the organization's switch, the
server's image model, the monthly image limit, and the member's current
third_party_ai consent (checked by the caller before anything starts).
`CallGuard` is imagegen.edit_image as the kit calls it: before EACH call
the switch and the limit are read again, so a switch turned off or a limit
reached mid-kit stops it (every shape not yet answered is retargeted,
nothing more is sent), and calls still in flight count against the limit,
so three concurrent calls never pass its last unit together. The consent
is recorded (on the avatar, and for a finish on the creation) before the
first picture leaves, whatever the answers turn out to be; a kit that sent
nothing records nothing, and one whose consent could not be recorded sends
nothing.

**What it costs.** One image-generation usage row per billed call (source
SHAPES_CALL), written as each call ends and classified as the kit
classifies it (performance_kit.call_billing): an answer is billed, a
timeout may have been and counts, a call that never reached Google does
not. Seven calls: the six shapes and the teeth photo (six when the avatar
keeps the owner's own teeth), and one more for each the AI declines.

**Where it lives.** The manifest is stored beside the teeth photo
(`mouth-motion-<stamp>.json`, a fresh key each time) and named by
`mouth_config.motion_key`, when the kit made shapes of the person's own
(one with none plays exactly what the bundled motion plays, so the bundled
motion plays); the teeth fit becomes the draft's; the kit's teeth photo
becomes the avatar's when the embed would draw it (mouth_photo.admit_photo:
the WebP visitors get, the teeth test run on those bytes);
`mouth_config.kit` records what the kit is made of (owner facing:
publishing keeps it beside the files for Discard, never serves it).
Publishing copies the manifest like the teeth photo, and the widget and
share page get it as `mouth.motion_url`.

**What it keeps of the owner's.** Teeth the owner uploaded are never
replaced, and not asked for: the kit brings its shapes only, and the teeth
fit stays theirs. AI teeth from an earlier run stay when a new kit cannot
make teeth the embed would draw. The jaw range is the owner's: the kit's
shapes are made at the Reference's size (performance_kit
.normalize_amplitude), so the slider means the same with or without them.

**Who is told.** AI-made shapes are disclosed as `ai_edited.mouth_shapes`
{model, generated}, with mode "mouth_shapes" when nothing else was
AI-made (mouth_photo.mouth_disclosure). Retargeted shapes are the
Reference's movement, not pixels an AI drew, and are not counted.

**Later edits.** The kit follows its face with no AI call (`follow_points`,
performance_kit.rebase_manifest): points re-confirmed on the same picture
(Mark the face, a re-detection), and the picture moved under the same
face (a crop, a crop reset, either undone: the same pixels, translated).
A kit that cannot follow is dropped (`drop`), and says why. The teeth
photo stays whatever the portrait: the renderer registers it by its own
landmarks.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from datetime import datetime, timezone
from uuid import uuid4

from sqlalchemy import select

from app.core.errors import AppError, Conflict409, Forbidden403, NotFound404
from app.services import imagegen, mouth, performance_kit
from app.services.jobs import DONE, FAILED, QUEUED, Job, run_cpu, runner

logger = logging.getLogger("liveface.mouth_kit")

# What each of the kit's calls is recorded as in usage (usage.IMAGE_CALLS).
SHAPES_CALL = "mouth_shapes"
# Calls in flight at once: six ~10 s calls in about twenty seconds, without
# one kit taking the provider's whole rate for itself.
CONCURRENCY = 3
SHAPE_COUNT = len(performance_kit.SHAPES)
MOTION_TYPE = "application/json"

# Progress labels (JobProgress.label). The dashboard maps them to stages;
# they are also what the log says.
SHAPES_LABEL = "making the mouth shapes"
FIT_LABEL = "fitting the mouth"
TEETH_LABEL = "making the teeth"
SAVE_LABEL = "saving"

GENERATED = performance_kit.GENERATED
RETARGETED = performance_kit.RETARGETED

# The profile values a kit fits: the teeth's, for its own teeth photo, or
# for the standard teeth when a new avatar has none (either seated and
# sized as the Reference's, performance_kit.fit_profile). Teeth it does not
# bring (the owner's upload, earlier AI teeth) keep their own fit, and the
# jaw range is always the owner's (see the module docstring).
FITTED_WITH_TEETH = ("teethY", "teethScale")
FITTED_WITHOUT_TEETH: tuple[str, ...] = ()

REBASE_FAILED = {
    "code": "rebase_failed",
    "detail": "The mouth shapes could not follow the new points",
}
# Why the kit's teeth photo is not the avatar's (kit.teeth.reason), besides
# what the kit itself says (teeth_reason).
OWNER_PHOTO = {"code": "owner_photo", "detail": "Your own teeth photo is used"}
TEETH_REMOVED = {"code": "teeth_removed", "detail": "The teeth photo was removed"}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _note(code: str, detail: str) -> dict:
    return {"code": code, "detail": detail}


# --- Calls -----------------------------------------------------------------------


class _Stopped(imagegen.ImageGenUnavailable):
    """No more calls may go: an ImageGenUnavailable, which the kit reads as
    "nothing sent, send nothing more", saying why (the organization's
    switch, the monthly limit, a consent that could not be recorded;
    performance_kit.stop_reason reads it)."""

    def __init__(self, code: str, detail: str):
        super().__init__(detail)
        self.code = code
        self.detail = detail


CONSENT_NOT_RECORDED = (
    "consent_not_recorded",
    "Your agreement to send photos could not be recorded, so nothing was sent",
)


class CallGuard:
    """imagegen.edit_image as the kit may call it for one organization.

    Before each call, under one lock: the switch and the monthly limit are
    read again, the limit counting every call of this kit still in flight
    as spent; the consent is recorded (`on_first_send`, before the first
    picture leaves). Recording it is tried again before every call until it
    succeeds: until then nothing is sent (`_Stopped`
    "consent_not_recorded", which the kit reads as "send nothing more").
    Then the provider call itself, bounded by imagegen's timeout (the kit's
    own bound is off: waiting for this lock, the database or the consent's
    record is not the provider's time). After each call, under the same
    lock, it is metered if it was billed, as the kit classifies it."""

    def __init__(self, org_id: str, on_first_send: Callable[[], Awaitable[None]] | None = None):
        self.org_id = org_id
        self._on_first_send = on_first_send
        self._lock = asyncio.Lock()
        self._in_flight = 0
        self.sent = 0
        self.metered = 0

    async def __call__(self, prompt: str, payload: bytes, mime: str):
        async with self._lock:
            await self._admit()
            if self._on_first_send is not None:
                try:
                    await self._on_first_send()
                except Exception as exc:
                    # Kept for the next call to try again; this one does
                    # not go, since nothing would say what allowed it.
                    logger.exception("could not record the consent for org %s", self.org_id)
                    raise _Stopped(*CONSENT_NOT_RECORDED) from exc
                self._on_first_send = None
            self._in_flight += 1
            self.sent += 1
        error: BaseException | None = None
        try:
            return await asyncio.wait_for(
                imagegen.edit_image(prompt, payload, mime), timeout=imagegen.TIMEOUT_SECONDS
            )
        except BaseException as exc:
            error = exc
            raise
        finally:
            # Shielded: a call cancelled in flight was sent and may be
            # billed, and its row is written all the same.
            await asyncio.shield(self._settle(error))

    async def _admit(self) -> None:
        from app.db import get_session_factory
        from app.services.consent import ai_switched_off
        from app.services.usage import check_image_limit

        if await ai_switched_off(self.org_id):
            raise _Stopped(
                "third_party_ai_disabled",
                "Your organization turned off third-party AI, so nothing more was sent",
            )
        try:
            async with get_session_factory()() as db:
                await check_image_limit(db, self.org_id, incoming=self._in_flight + 1)
        except AppError as exc:
            raise _Stopped(exc.code, exc.detail) from exc

    async def _settle(self, error: BaseException | None) -> None:
        from app.db import get_session_factory
        from app.services.usage import record_generation

        billed = performance_kit.call_billing(error)
        async with self._lock:
            try:
                if billed is not False:
                    async with get_session_factory()() as db:
                        await record_generation(db, self.org_id, "gemini", SHAPES_CALL)
                    self.metered += 1
            except Exception:
                # The call happened either way; a lost usage row must not
                # turn an answer into a failure.
                logger.exception("could not meter a mouth shape call for org %s", self.org_id)
            finally:
                self._in_flight -= 1


def progress_to(job: Job | None, start: float, end: float) -> Callable[[float, str, int, int], None]:
    """The kit's progress as `job`'s, between `start` and `end` of its bar:
    SHAPES_LABEL with how many of its requests (the six shapes and the
    teeth photo) are settled, then FIT_LABEL once they all are (the fit,
    the manifest)."""

    def report(fraction: float, message: str, done: int, total: int) -> None:
        if job is None:
            return
        at = start + (end - start) * fraction
        if done < total:
            job.report(at, SHAPES_LABEL, count=(done, total))
        else:
            job.report(at, FIT_LABEL)

    return report


async def make(
    org_id: str,
    picture: bytes,
    points,
    *,
    teeth: bool = True,
    job: Job | None = None,
    on_first_send: Callable[[], Awaitable[None]] | None = None,
    on_progress: Callable[[float, str, int, int], object] | None = None,
) -> performance_kit.KitResult:
    """The kit for `picture` (the avatar's picture, as rigged) and `points`
    (its rig's 478 points), through a CallGuard for `org_id`; with its teeth
    photo unless `teeth` is False (the avatar keeps the owner's own).

    The whole of it waits outside the job runner's slot
    (JobRunner.outside_slot): seven image-model calls take tens of seconds,
    and every CPU part of the kit runs on the one CPU thread anyway, which
    is the bound that protects speech. Raises what build_kit raises:
    KitUnavailable or ValueError before any call, KitFailed after some
    (every call sent was metered as it ended)."""
    guard = CallGuard(org_id, on_first_send)
    async with runner.outside_slot(job):
        return await performance_kit.build_kit(
            picture, points, guard, teeth=teeth, concurrency=CONCURRENCY, bound_calls=False,
            on_progress=on_progress,
        )


def kit_model(result: performance_kit.KitResult) -> str | None:
    """The model that made the kit's generated shapes."""
    return next((call["model"] for call in result.call_log if call.get("model")), None)


def generated_count(result: performance_kit.KitResult) -> int:
    return sum(1 for entry in result.report.values() if entry["status"] == "ok")


# --- Records ------------------------------------------------------------------------

# Why the kit's teeth request brought nothing, passed on as its own note
# (the Mouth panel words each, as for the single "ee" photo's): what
# stopped the calls, or what the AI answered.
_TEETH_NOTE_CODES = frozenset({
    "safety_refused", "no_image", "provider_error", "timeout", "imagegen_unavailable",
    "image_limit_reached", "third_party_ai_disabled", CONSENT_NOT_RECORDED[0],
})
# The embed's own refusal of a teeth photo that passed every other check.
_UNCLEAR_CODES = frozenset({"teeth_photo_refused", "no_teeth_visible"})


def teeth_reason(result: performance_kit.KitResult) -> dict | None:
    """Why the kit brings no teeth photo, as a note the Mouth panel words
    (mouth.teeth.note, kit.teeth.reason), or None when it brings one (or
    was not asked for any). The request stopped or the AI did not answer
    with a picture (its own reason); the picture showed too little of the
    upper teeth for the embed (`mouth_teeth_unclear`, as for any mouth
    photo); or it failed a check, which the note names (`reason`) for the
    dashboard to word: `teeth_photo_rejected` alone would not say whether
    the lips were too close or the head moved."""
    if result.teeth_source is not None or result.teeth_report is None:
        return None
    reason = result.teeth_report.get("reason") or {}
    code = reason.get("code")
    if code in _TEETH_NOTE_CODES:
        return _note(code, reason["detail"])
    if code in _UNCLEAR_CODES:
        return _note(
            "mouth_teeth_unclear",
            "The AI's teeth photo shows too little of the upper teeth for the photographic "
            "mouth, so it was not used",
        )
    return {
        **_note("teeth_photo_rejected",
                "The AI's teeth photo did not pass its checks "
                f"({reason.get('detail') or 'no reason given'}), so it was not used"),
        "reason": reason or None,
    }


def _standard_teeth(reason: dict) -> dict:
    """The teeth note for a mouth left with the standard teeth."""
    return {**reason, "detail": f"{reason['detail']}; this avatar uses standard teeth"}


def kit_record(
    result: performance_kit.KitResult, *, source: str, teeth: dict, fitted: dict
) -> dict:
    """What `mouth_config.kit` keeps of a kit, for the owner: its id and
    recipe, the model, each shape's provenance with why a shape was
    retargeted, whether its teeth photo is the avatar's (`teeth`: {used,
    reason}), the profile values it set (`fitted`, so they can be refitted
    when the teeth change and the owner has not moved them), what the fit
    could not measure, and what it took. `source` says where it was made:
    "finish" or "mouth_panel"."""
    shapes = {}
    for shape in performance_kit.SHAPES:
        entry = result.report[shape]
        shapes[shape] = {
            "provenance": GENERATED if entry["status"] == "ok" else RETARGETED,
            "outcome": entry["outcome"],
            "reason": entry.get("reason"),
            "attempts": entry["attempts"],
        }
    generated = generated_count(result)
    manifest = result.manifest
    return {
        "id": manifest["character"][len(performance_kit.CHARACTER_PREFIX):],
        "state": "made",
        "made_at": _now(),
        "source": source,
        "recipe": manifest.get("kit"),
        "model": kit_model(result),
        "shapes": shapes,
        "generated": generated,
        "retargeted": SHAPE_COUNT - generated,
        "teeth": teeth,
        "fitted": fitted,
        "fit_reasons": result.profile_fit.get("reasons") or [],
        "calls": result.calls,
        "billed_calls": result.billed_calls,
        "base_detected": result.base_detected,
        "rebased_at": None,
        "dropped": None,
    }


def public_kit(record: dict | None) -> dict | None:
    """The kit as AvatarOut.mouth.kit tells the owner (mouth.public_view):
    {state: "made" | "dropped", made_at, model, generated, retargeted,
    shapes: [{shape, provenance, reason}] in the manifest's order, teeth:
    {used, reason}, dropped: {code, detail} | null}. None without a kit."""
    if not record:
        return None
    shapes = record.get("shapes") or {}
    return {
        "state": record.get("state") or "made",
        "made_at": record.get("made_at"),
        "model": record.get("model"),
        "generated": int(record.get("generated") or 0),
        "retargeted": int(record.get("retargeted") or 0),
        "shapes": [
            {
                "shape": shape,
                "provenance": shapes[shape].get("provenance"),
                "reason": shapes[shape].get("reason"),
            }
            for shape in performance_kit.SHAPES
            if shape in shapes
        ],
        "teeth": record.get("teeth"),
        "dropped": record.get("dropped"),
    }


# --- Disclosure ---------------------------------------------------------------------


def with_ai_shapes(ai_edited: dict | None, model: str | None, generated: int) -> dict:
    """The disclosure once AI made `generated` of the mouth's shapes (a new
    dict: JSON columns are replaced, never mutated)."""
    from app.services.mouth_photo import mouth_disclosure

    entry = {"model": model, "generated": generated}
    if not ai_edited:
        return {"mode": "mouth_shapes", "model": model, "mouth_shapes": entry}
    return mouth_disclosure({**ai_edited, "mouth_shapes": entry})


def without_ai_shapes(ai_edited: dict | None) -> dict | None:
    """The disclosure once no AI-made shape is shown (the kit dropped, a
    kit with none, the published mouth without its motion): whatever else
    AI made stays disclosed."""
    from app.services.mouth_photo import mouth_disclosure

    if not ai_edited:
        return None
    return mouth_disclosure({k: v for k, v in ai_edited.items() if k != "mouth_shapes"})


# --- Storing ------------------------------------------------------------------------


def _manifest_bytes(manifest: dict) -> bytes:
    return json.dumps(manifest, separators=(",", ":")).encode()


async def store(avatar, storage, result: performance_kit.KitResult, *, source: str) -> list[str]:
    """Make `result` the draft's mouth kit: its manifest the avatar's own
    motion when it has shapes of the person's own (none, and the bundled
    motion plays: this manifest would only be the Reference's shapes fitted
    by mouth width, which is what the bundled motion plays), its teeth fit
    the draft's, its teeth photo the avatar's when the embed would draw it
    and the owner has none of their own, and the disclosure to match. Every
    file is written before the row changes, so a failure leaves the draft
    as it was. The caller commits (and marks an edited draft dirty).
    Returns the keys replaced, to delete after the commit: the published
    snapshot has its own copies."""
    from app.core.errors import Validation422
    from app.schemas.avatar import MouthProfile
    from app.services import mouth_photo

    config = mouth.load(avatar.mouth_config) or {"renderer": "continuous", "profile": {}}
    teeth_record = config.get("teeth") or {}
    has_photo = bool(config.get("oral_image_key") and config.get("oral_rig_key"))
    # A photo from before the record existed is the owner's too.
    own_photo = has_photo and (teeth_record.get("source") or "upload") == "upload"
    model = kit_model(result)
    fitted = dict(result.profile)
    previous: list[str] = []
    ai_edited = avatar.ai_edited

    new_photo: tuple[str, str] | None = None
    reason = teeth_reason(result)
    if own_photo:
        reason = OWNER_PHOTO
    elif result.teeth_source is not None:
        try:
            photo, rig = await run_cpu(
                mouth_photo.admit_photo, result.teeth_source.png, result.teeth_source.rig
            )
        except Validation422 as exc:
            # Accepted as PNG, refused as the WebP visitors would get: on
            # the edge of the embed's limits. The profile was fitted for it,
            # so it is refitted for the teeth that will be drawn: the
            # standard ones.
            logger.info("mouth kit: the teeth photo was refused as WebP (%s)", exc.code)
            reason = _note("mouth_teeth_unclear", exc.detail)
            fitted = performance_kit.for_standard_teeth(fitted)
        else:
            new_photo = await mouth_photo.put_photo(avatar, storage, photo, rig)

    if new_photo is not None:
        previous += [k for k in (config.get("oral_image_key"), config.get("oral_rig_key")) if k]
        config.update(oral_image_key=new_photo[0], oral_rig_key=new_photo[1],
                      teeth=mouth_photo.ai_teeth_record(model))
        ai_edited = mouth_photo.with_ai_teeth(ai_edited, model)
        keys = FITTED_WITH_TEETH
    elif has_photo:
        # Teeth the kit does not replace keep their own fit.
        keys = FITTED_WITHOUT_TEETH
    else:
        config["teeth"] = mouth_photo.generic_teeth_record(
            _standard_teeth(reason or _note("teeth_failed", "The teeth could not be made")))
        keys = FITTED_WITH_TEETH
    # The fitted values the kit decides; everything else the owner set (or
    # the defaults, on a new avatar) stays. Held to the API's ranges like
    # any profile an owner saves: it is served to strangers.
    config["profile"] = MouthProfile.model_validate({
        **(config.get("profile") or {}),
        **{k: fitted[k] for k in keys},
    }).model_dump()

    generated = generated_count(result)
    if generated:
        key = mouth.motion_key(avatar.org_id, avatar.id, uuid4().hex[:8])
        await storage.put_bytes(key, _manifest_bytes(result.manifest), MOTION_TYPE)
        if config.get("motion_key"):
            previous.append(config["motion_key"])
        config["motion_key"] = key
        ai_edited = with_ai_shapes(ai_edited, model, generated)
    else:
        if config.get("motion_key"):
            previous.append(config.pop("motion_key"))
        ai_edited = without_ai_shapes(ai_edited)
    config["kit"] = kit_record(
        result, source=source, teeth={"used": new_photo is not None, "reason": reason},
        fitted={k: config["profile"][k] for k in keys},
    )
    avatar.mouth_config = json.dumps(config)
    avatar.ai_edited = ai_edited
    return previous


# --- Following the avatar's edits ------------------------------------------------------


def teeth_changed(avatar, reason: dict) -> None:
    """The teeth drawn are no longer the ones the kit fitted the profile
    for: the owner uploaded their own photo (OWNER_PHOTO) or removed the
    photo (TEETH_REMOVED: the standard teeth now). The teeth values the kit
    set are refitted for the teeth drawn now, unless the owner has moved
    them since: an upload's own defaults (its teeth at their photographed
    size, seated like any photo's), or the standard teeth's
    (performance_kit.for_standard_teeth: the Reference's own photo, seated
    and sized as the Reference's). A fit for teeth that are not drawn seats
    and sizes the ones that are wrongly. The record says its teeth photo is
    no longer the avatar's, and why. The shapes and the jaw range are
    untouched."""
    from app.schemas.avatar import MouthProfile

    config = mouth.load(avatar.mouth_config)
    kit = (config or {}).get("kit")
    if not kit:
        return
    profile = dict(config.get("profile") or {})
    target = MouthProfile().model_dump()
    if reason["code"] == TEETH_REMOVED["code"]:
        target = performance_kit.for_standard_teeth(target)
    # A record from before `fitted` was kept: the values are the kit's.
    fitted = kit.get("fitted")
    for key in FITTED_WITH_TEETH:
        if fitted is None or key not in fitted or profile.get(key) == fitted[key]:
            profile[key] = target[key]
    config["profile"] = MouthProfile.model_validate(profile).model_dump()
    kit = {**kit, "fitted": {
        **(fitted or {}), **{k: config["profile"][k] for k in FITTED_WITH_TEETH}}}
    if (kit.get("teeth") or {}).get("used"):
        kit["teeth"] = {"used": False, "reason": reason}
    config["kit"] = kit
    avatar.mouth_config = json.dumps(config)


def drop(avatar, reason: dict) -> list[str]:
    """The draft's kit can no longer play on its face (its manifest could
    not follow the points): the motion goes (the engine plays the bundled
    Reference motion again), with the disclosure of its AI-made shapes, and
    the record says why (state "dropped"). The teeth photo and the profile
    stay. Returns the motion's key, to delete after the commit; nothing to
    do without one."""
    config = mouth.load(avatar.mouth_config)
    key = (config or {}).get("motion_key")
    if not key:
        return []
    config.pop("motion_key")
    if config.get("kit"):
        config["kit"] = {**config["kit"], "state": "dropped", "dropped": reason}
    avatar.mouth_config = json.dumps(config)
    avatar.ai_edited = without_ai_shapes(avatar.ai_edited)
    return [key]


async def follow_points(avatar, storage, points, image_size=None) -> list[str]:
    """Move the draft's kit onto the face's points as they are now, with no
    AI call: points re-confirmed on the same picture (Mark the face's saved
    marks, a re-detection), or the picture moved under the same face (a
    crop, a crop reset, an undo of either: the same pixels, translated;
    `image_size` is then the new picture's). Every shape keeps its movement
    (performance_kit.rebase_manifest), and the manifest gets a fresh key.
    A kit that cannot follow is dropped rather than left on the old
    points. Returns the keys replaced, to delete after the commit."""
    config = mouth.load(avatar.mouth_config)
    key = (config or {}).get("motion_key")
    if not key:
        return []
    size = tuple(int(v) for v in image_size) if image_size is not None else None
    try:
        manifest = json.loads(await storage.get_bytes(key))
        rebased = await run_cpu(performance_kit.rebase_manifest, manifest, points, None, size)
    except Exception:
        logger.exception("the mouth kit of avatar %s could not follow its points", avatar.id)
        return drop(avatar, REBASE_FAILED)
    if rebased == manifest:
        return []
    new_key = mouth.motion_key(avatar.org_id, avatar.id, uuid4().hex[:8])
    await storage.put_bytes(new_key, _manifest_bytes(rebased), MOTION_TYPE)
    config["motion_key"] = new_key
    if config.get("kit"):
        config["kit"] = {**config["kit"], "rebased_at": _now()}
    avatar.mouth_config = json.dumps(config)
    return [key]


async def follow_rig(avatar, storage, before: dict | None, after: dict | None) -> list[str]:
    """After an edit put another rig in place under the same key (undo):
    the kit follows it. A rig of another size is the same face on a picture
    cropped or uncropped (every edit that snapshots a rig moves the face's
    pixels by a translation at most: a crop, its reset, a background);
    the same picture's rig with other points moves the kit likewise; the
    same rig changes nothing. Returns keys to delete after the commit."""
    if not before or not after:
        return []
    if list(before.get("image_size") or []) != list(after.get("image_size") or []):
        return await follow_points(avatar, storage, after["points"], after["image_size"])
    if before.get("points") != after.get("points"):
        return await follow_points(avatar, storage, after["points"])
    return []


async def follow_redetection(org_id: str, avatar_id: str, points) -> None:
    """follow_points for a job that rebuilt a rig of the same picture
    without the avatar's edit lock (Re-detect, a retry: rig.process_avatar,
    a request's background task).

    Under the lock, on the row as it is NOW, in a short transaction of its
    own: that job loaded its row when it started and commits it much later,
    and a mouth edit in between (the Mouth panel's kit storing its shapes
    and teeth, under the lock) would otherwise be overwritten with the kit
    it had read, its files deleted from under it. Whatever kit the row
    holds now follows the new points. The draft moved ahead of what is
    published (its rig changed), so it is marked so."""
    from app.db import get_session_factory
    from app.services.edit_locks import avatar_edits
    from app.services.publishing import mark_dirty
    from app.services.storage import get_storage

    storage = get_storage()
    stale: list[str] = []
    async with avatar_edits.hold(avatar_id):
        async with get_session_factory()() as db:
            avatar = await _load_avatar(db, org_id, avatar_id)
            if avatar is None:
                return
            stale = await follow_points(avatar, storage, points)
            if avatar.published_config:
                mark_dirty(avatar)
            await db.commit()
    for key in stale:
        await storage.delete(key)


# --- The Mouth panel's job -------------------------------------------------------------

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
        logger.exception("mouth kit %s for avatar %s crashed", job.id, job.subject_id)
        _end(job, FAILED, {"code": "job_failed", "detail": "Something went wrong; try again"})
    else:
        _end(job, DONE)


async def _load_avatar(db, org_id: str, avatar_id: str):
    from app.models import Avatar

    return (
        await db.execute(select(Avatar).where(Avatar.id == avatar_id, Avatar.org_id == org_id))
    ).scalar_one_or_none()


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
        async with avatar_edits.hold(avatar_id):
            async with get_session_factory()() as db:
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
    async with avatar_edits.hold(avatar_id):
        async with get_session_factory()() as db:
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
    reasons = [entry.get("reason") for entry in result.report.values() if entry.get("reason")]
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
    async with avatar_edits.hold(avatar_id):
        async with get_session_factory()() as db:
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
