"""6. The orchestrator: build_kit sends the requests, registers the
answers, fills and fits what is missing, and reports what it made."""

from __future__ import annotations

import asyncio
import inspect
import logging
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Protocol

import httpx
import numpy as np
from PIL import Image

from app.services.performance_kit.answers import (
    Detector,
    PoseRegistration,
    _reason,
    register_answer,
)
from app.services.performance_kit.constants import (
    FACE_LEFT,
    FACE_RIGHT,
    SHAPES,
    TEETH,
)
from app.services.performance_kit.manifest import (
    GENERATED,
    RETARGETED,
    PoseEntry,
    build_manifest,
)
from app.services.performance_kit.profile import (
    REFERENCE_JAW_RANGE,
    ProfileFit,
    TeethPhoto,
    fit_profile,
    normalize_amplitude,
    retarget_reference_pose,
)
from app.services.performance_kit.registration import (
    ManifestFrame,
    ReferenceMotion,
    load_reference,
)
from app.services.performance_kit.requests import (
    FACE_CROP,
    HEAD_CROP,
    PoseRequest,
    _base_image,
    _checked_points,
    _Crop,
    _crop,
    _request,
)

logger = logging.getLogger("liveface.performance_kit")


class KitUnavailable(RuntimeError):
    """The kit cannot be made on this server; nothing was sent or spent."""

    def __init__(self, code: str, detail: str):
        self.code = code
        self.detail = detail
        super().__init__(detail)


class KitFailed(RuntimeError):
    """Something other than a provider call failed while the kit was being
    made (a crop, a progress callback, ...). Every call still in flight was
    cancelled and awaited before this is raised, so nothing more is sent;
    the calls that were sent are accounted for here, as in KitResult (a
    cancelled call is in `call_log` as outcome "cancelled", billed null:
    sent, and possibly billed). The original error is the __cause__."""

    def __init__(self, calls: int, billed_calls: int, call_log: list[dict]):
        self.calls = calls
        self.billed_calls = billed_calls
        self.call_log = call_log
        super().__init__(f"the performance kit failed after {calls} call(s)")


@dataclass(frozen=True)
class TeethSource:
    """The teeth answer, usable as the continuous mouth's oral photo: the
    same {image, rig} a mouth-photo upload stores (rig.build_rig of its
    own landmarks, in its own pixels)."""

    png: bytes
    rig: dict


@dataclass
class KitResult:
    manifest: dict
    profile: dict
    profile_fit: dict
    teeth_source: TeethSource | None
    # Per shape: {status: ok | retargeted, outcome, reason, attempts, checks}.
    report: dict[str, dict]
    # Requests actually sent to the provider, and those it answered (an
    # image, a refusal or an answer without an image), which are billed.
    calls: int
    billed_calls: int
    call_log: list[dict]
    # Whether the answers were registered on the detector's view of the
    # base photo (True) or, with no usable detection, on the confirmed
    # points themselves.
    base_detected: bool = False
    # The teeth photo's request, as a shape's is reported: {status: ok |
    # failed, outcome, reason, attempts, checks}; "ok" only when the embed
    # would draw it (then `teeth_source` is set). None when not asked for.
    teeth_report: dict | None = None


class EditedImage(Protocol):
    """What an edit answers with: imagegen.Generated, or a test's fake (whose
    `model`, read with getattr, is optional)."""

    image: bytes


EditImage = Callable[[str, bytes, str], Awaitable[EditedImage]]
# on_progress(fraction, message, done, total): `done` of the `total`
# requests (the six shapes, and the teeth photo when asked for) are
# settled: made, or given up on (a shape is then retargeted).
Progress = Callable[[float, str, int, int], object]


def call_billing(error: BaseException | None) -> bool | None:
    """Was a provider call that ended with `error` (None: it returned an
    image) billed? True for any answer: an image, a refusal, an answer
    without an image. None when it was sent and may have been answered:
    it timed out, while or after it was written (the kit's own bound, or
    httpx's read or write timeout, which is how a real 90 s imagegen
    timeout arrives), or it was cancelled in flight. False when nothing
    was sent (ImageGenUnavailable, httpx never connected) or the provider
    failed without answering (an HTTP error, a broken connection).

    The one classification the kit's call_log and a caller metering its
    calls as they end (services.mouth_kit) both use, so they agree."""
    from app.services import imagegen

    if error is None or isinstance(error, (imagegen.ImageGenRefused, imagegen.ImageGenNoImage)):
        return True
    if isinstance(error, (httpx.ConnectTimeout, httpx.PoolTimeout)):
        return False
    if isinstance(error, (TimeoutError, httpx.TimeoutException, asyncio.CancelledError)):
        return None
    return False


def stop_reason(error: BaseException) -> dict:
    """Why no more calls are sent, from the ImageGenUnavailable that said
    so: the `code` and `detail` a caller's edit function gave it (its AI
    switch turned off, the monthly image limit reached), else imagegen's
    own meaning, no provider configured."""
    return _reason(
        getattr(error, "code", None) or "imagegen_unavailable",
        getattr(error, "detail", None) or "AI editing is not configured on this server",
    )

def _require_landmarker() -> None:
    from app.core.config import get_settings

    if not get_settings().rig_model_path:
        raise KitUnavailable("landmarks_unavailable", "Face detection is not available on this server")


def _default_detect(image: Image.Image) -> np.ndarray | None:
    from app.services import photo_adjust

    return photo_adjust._detect(image)


def _png(image: Image.Image) -> bytes:
    from app.services.photo_io import png_bytes

    return png_bytes(image)


def _teeth_source(registration: PoseRegistration) -> TeethSource:
    from app.services.rig import build_rig

    points, image = registration.answer_points, registration.answer_image
    assert points is not None and image is not None  # a registered answer has both
    return TeethSource(_png(image), build_rig(points, image.size))


@dataclass
class _Finished:
    manifest: dict
    fit: ProfileFit
    teeth: TeethSource | None
    # Generated shapes refused at the kit's size (normalize_amplitude).
    refused: dict[str, dict]
    # Why the teeth answer is not handed on, when it was made but the embed
    # would not draw it.
    teeth_refused: dict | None


def _finish(
    base_points: np.ndarray,
    image_size: tuple[int, int],
    registrations: dict[str, PoseRegistration],
    reference: ReferenceMotion,
    kit_id: str,
    why_no_teeth: dict | None = None,
) -> _Finished:
    """Everything after the provider calls: the person's shapes at the
    kit's size, the teeth fit, the fallbacks, the manifest. CPU work."""
    generated: dict[str, np.ndarray] = {}
    for shape in SHAPES:
        registration = registrations.get(shape)
        if registration is not None and registration.ok and registration.targets is not None:
            generated[shape] = registration.targets
    amplitude = normalize_amplitude(base_points, generated, reference)
    # The teeth that will be drawn: the teeth photo when the embed would
    # draw it, the standard teeth otherwise (and why), either seated and
    # sized as the Reference's.
    answer = registrations.get(TEETH)
    photo = None
    if answer is not None and answer.ok:
        image, points, targets = answer.answer_image, answer.answer_points, answer.targets
        assert image is not None and points is not None and targets is not None  # ok
        photo = TeethPhoto(image, points, targets)
    fit = fit_profile(base_points, photo, why_no_teeth)
    fit.measurements.update(amplitude.measurements)
    fit.reasons.extend(amplitude.reasons)
    # fit.teeth_photo is only ever set for the answer's photo.
    teeth = _teeth_source(answer) if fit.teeth_photo and answer is not None else None
    teeth_refused = None
    if photo is not None and teeth is None:
        teeth_refused = next({k: v for k, v in r.items() if k != "field"}
                             for r in fit.reasons if r["field"] == "teethY")

    entries: dict[str, PoseEntry] = {}
    for shape in SHAPES:
        if shape in amplitude.targets:
            entries[shape] = PoseEntry(amplitude.targets[shape], GENERATED,
                                       registrations[shape].rms)
        else:
            entries[shape] = PoseEntry(
                retarget_reference_pose(shape, base_points, reference), RETARGETED)
    # Every pose is at the Reference's size: the manifest is true where the
    # Reference's motion is.
    manifest = build_manifest(base_points, image_size, entries, reference,
                              kit_id=kit_id, jaw_range=REFERENCE_JAW_RANGE)
    return _Finished(manifest, fit, teeth, amplitude.refused, teeth_refused)


# The detector's view of the base photo is used only when it is the face the
# owner confirmed: its points on average within this many face widths of the
# confirmed ones. Owner corrections are a few hundredths; anything further
# is another face, or a detection that failed, and the confirmed points
# stand in for it.
MAX_BASE_DETECTION_SHIFT = 0.15


def _detect_base(detect: Detector, image: Image.Image, base_points: np.ndarray) -> np.ndarray | None:
    """The detector's own landmarks on the base photo (register_answer's
    `base_detected`), or None. CPU work."""
    points = detect(image)
    if points is None:
        return None
    points = np.asarray(points, dtype=np.float64)
    if points.shape != (478, 2) or not np.isfinite(points).all():
        return None
    face = float(np.linalg.norm(base_points[FACE_RIGHT] - base_points[FACE_LEFT]))
    shift = float(np.linalg.norm(points - base_points, axis=1).mean()) / max(face, 1.0)
    if shift > MAX_BASE_DETECTION_SHIFT:
        logger.warning("performance kit: the base detection is %.3f face widths from the "
                       "confirmed points; registering on the confirmed points", shift)
        return None
    return points


async def build_kit(
    base_png: bytes,
    base_points,
    edit_image: EditImage,
    *,
    teeth: bool = True,
    concurrency: int = 3,
    per_call_timeout: float | None = None,
    bound_calls: bool = True,
    on_progress: Progress | None = None,
    kit_id: str | None = None,
    detect: Detector | None = None,
    reference: ReferenceMotion | None = None,
) -> KitResult:
    """Make this face's performance kit.

    `base_png` is the photo the avatar is rigged on and `base_points` its
    478 confirmed landmarks in its pixels. `edit_image(prompt, payload,
    mime)` is imagegen.edit_image or a wrapper of it: it returns an object
    with `.image` (bytes) and `.model`, and raises imagegen's
    ImageGenRefused, ImageGenNoImage, ImageGenUnavailable or anything else
    for a failed call. ImageGenUnavailable means nothing was sent and
    nothing more may be: that request and every one not yet asked are
    given up (a shape retargeted), and their reason is the exception's
    `code` and `detail` when it carries them (a caller that stops at its AI
    switch or its image limit), else "imagegen_unavailable".

    Six requests, one per shape, and with `teeth` a seventh, the teeth
    photo (TEETH; not asked when the avatar keeps teeth of its own). Up to
    `concurrency` are in flight at once, each bounded by `per_call_timeout`
    seconds (imagegen's own timeout by default, so the two bounds agree:
    either way the call is a "timeout", sent and possibly billed). With
    `bound_calls` False the bound is the edit function's own
    (services.mouth_kit.CallGuard): what it does before it sends (reading
    its switch and limit, recording the consent) is not the provider's
    time, and a bound around it would give up, and log as sent, a call
    that never left. A refused edit is asked once more on the
    head-and-shoulders crop (a different input: photo_adjust's fallback);
    nothing else is ever asked twice. A shape that fails for any reason,
    its answer's checks included, is filled from the Reference, so the kit
    is always complete: with no provider at all it is the Reference
    retargeted, per avatar.

    The base photo is detected once as well, with the same detector as the
    answers: they are registered on that view of it and their movement is
    added to the confirmed points (register_answer), so the owner's
    corrections to the marks are kept and never read as motion.

    `on_progress(fraction, message, done, total)` is called as requests
    settle (it may be a coroutine function). `detect` replaces MediaPipe
    and `reference` the bundled Reference motion (tests). Raises ValueError
    for malformed points and KitUnavailable (before any call) when there is
    no detector. Any other failure cancels and awaits every call still in
    flight and raises KitFailed, which accounts for every call sent.
    """
    from app.services import imagegen
    from app.services.jobs import run_cpu

    points = _checked_points(base_points)
    if detect is None:
        _require_landmarker()
        detect = _default_detect
    if per_call_timeout is None:
        per_call_timeout = imagegen.TIMEOUT_SECONDS
    if reference is None:
        reference = await run_cpu(load_reference)
    kit_id = kit_id or uuid.uuid4().hex
    base_image = await run_cpu(_base_image, base_png)
    frame = ManifestFrame.from_base(points, base_image.size, reference)
    # Once, before any call: every answer is compared with this.
    base_detected = await run_cpu(_detect_base, detect, base_image, points)
    asked = SHAPES + ((TEETH,) if teeth else ())

    semaphore = asyncio.Semaphore(max(1, int(concurrency)))
    crops: dict[str, asyncio.Future] = {}
    call_log: list[dict] = []
    state: dict = {"calls": 0, "billed": 0, "stopped": None, "done": 0}

    async def report_progress(message: str, fraction: float | None = None) -> None:
        if on_progress is None:
            return
        done = state["done"]
        settled = 0.95 * done / len(asked) if fraction is None else fraction
        outcome = on_progress(settled, message, done, len(asked))
        if inspect.isawaitable(outcome):
            await outcome

    async def crop_for(kind: str) -> _Crop | None:
        # One crop per kind, shared by every request that needs it;
        # shielded, so a request torn down while it waits does not cancel
        # it for the others (and a crop nobody waits for any more is not
        # left with an unretrieved error).
        if kind not in crops:
            future = asyncio.ensure_future(run_cpu(_crop, base_image, points, kind))
            future.add_done_callback(lambda done: done.cancelled() or done.exception())
            crops[kind] = future
        return await asyncio.shield(crops[kind])

    async def send(request: PoseRequest):
        call = edit_image(request.prompt, request.payload, request.mime)
        if not bound_calls:
            return await call
        return await asyncio.wait_for(call, timeout=per_call_timeout)

    async def one(shape: str) -> tuple[PoseRegistration | None, dict]:
        entry: dict = {"attempts": []}
        kind = FACE_CROP
        while True:
            crop = await crop_for(kind)
            if crop is None:
                entry.update(outcome="refused", reason=_reason(
                    "safety_refused", "The AI declined this edit, so it was not asked again"))
                return None, entry
            request = _request(shape, crop)
            async with semaphore:
                if state["stopped"] is not None:
                    entry.update(outcome="unavailable", reason=state["stopped"])
                    return None, entry
                state["calls"] += 1
                record = {"shape": shape, "kind": kind, "model": None}
                call_log.append(record)
                entry["attempts"].append(kind)
                try:
                    generated = await send(request)
                except imagegen.ImageGenRefused as exc:
                    state["billed"] += 1
                    record.update(outcome="refused", billed=True, detail=exc.reason)
                    if kind == FACE_CROP:
                        # Once more on the head crop: a different picture,
                        # the same pose asked for (photo_adjust's pattern).
                        kind = HEAD_CROP
                        continue
                    entry.update(outcome="refused", reason=_reason(
                        "safety_refused", "The AI declined this edit, so it was not asked again"))
                    return None, entry
                except imagegen.ImageGenNoImage as exc:
                    state["billed"] += 1
                    record.update(outcome="no_image", billed=True, detail=exc.reason)
                    entry.update(outcome="no_image", reason=_reason(
                        "no_image", "The AI answered without an image, so it was not asked again"))
                    return None, entry
                except imagegen.ImageGenUnavailable as exc:
                    # Nothing was sent: no provider, or the caller sends no
                    # more (its switch, its limit, a consent it could not
                    # record). Nothing more is asked.
                    state["calls"] -= 1
                    call_log.remove(record)
                    entry["attempts"].pop()
                    reason = stop_reason(exc)
                    state["stopped"] = state["stopped"] or reason
                    entry.update(outcome="unavailable", reason=reason)
                    return None, entry
                except asyncio.CancelledError:
                    # Torn down (another request failed) or the caller was
                    # cancelled: this call was sent, and may be billed.
                    record.update(outcome="cancelled", billed=None)
                    raise
                except Exception as exc:
                    if call_billing(exc) is None:
                        # Sent, and possibly billed: the kit's own bound, or
                        # the provider's read or write timeout (imagegen's
                        # 90 s arrives as httpx's). Never asked again; the
                        # caller decides how to meter it.
                        record.update(outcome="timeout", billed=None)
                        entry.update(outcome="timeout", reason=_reason(
                            "timeout", "The AI did not answer in time"))
                        return None, entry
                    logger.exception("performance kit: the %s edit failed", shape)
                    record.update(outcome="provider_error", billed=False)
                    entry.update(outcome="provider_error", reason=_reason(
                        "provider_error", "The AI service did not return an image"))
                    return None, entry
            state["billed"] += 1
            record.update(outcome="image", billed=True, model=getattr(generated, "model", None))
            try:
                registration = await run_cpu(
                    register_answer, generated.image, request, base_image, points, frame, detect,
                    base_detected,
                )
            except Exception:
                # A check that breaks on an answer is a check the answer did
                # not pass: given up, like any rejected one, and the other
                # requests' paid calls carry on.
                logger.exception("performance kit: checking the %s answer failed", shape)
                registration = PoseRegistration(shape, reason=_reason(
                    "check_failed", "The AI's answer could not be checked, so it was not used"))
            entry.update(outcome="generated" if registration.ok else "rejected",
                         reason=registration.reason, checks=registration.checks)
            return registration, entry

    async def tracked(shape: str) -> tuple[PoseRegistration | None, dict]:
        result = await one(shape)
        state["done"] += 1
        await report_progress(f"{shape} {result[1]['outcome']}")
        return result

    await report_progress("asking the AI for the mouth shapes")
    try:
        # A task group, not gather: should anything here fail, gather would
        # leave the other requests' paid calls running, unaccounted for;
        # the group cancels and awaits them first.
        async with asyncio.TaskGroup() as group:
            tasks = [group.create_task(tracked(shape)) for shape in asked]
        results = dict(zip(asked, (task.result() for task in tasks)))
        registrations = {shape: reg for shape, (reg, _) in results.items() if reg is not None}
        teeth_entry = results[TEETH][1] if teeth else None
        why_no_teeth = None
        if teeth_entry is not None and not (TEETH in registrations and registrations[TEETH].ok):
            why_no_teeth = teeth_entry.get("reason")
        finished = await run_cpu(
            _finish, points, base_image.size, registrations, reference, kit_id, why_no_teeth
        )
        report = {}
        for shape in SHAPES:
            registration, entry = results[shape]
            refused = finished.refused.get(shape)
            ok = registration is not None and registration.ok and refused is None
            report[shape] = {
                "status": "ok" if ok else "retargeted",
                "outcome": "rejected" if refused else entry["outcome"],
                "reason": refused or entry.get("reason"),
                "attempts": entry["attempts"],
                "checks": entry.get("checks", {}),
            }
        teeth_report = None
        if teeth_entry is not None:
            refused = finished.teeth_refused
            teeth_report = {
                "status": "ok" if finished.teeth is not None else "failed",
                "outcome": "rejected" if refused else teeth_entry["outcome"],
                "reason": refused or teeth_entry.get("reason"),
                "attempts": teeth_entry["attempts"],
                "checks": teeth_entry.get("checks", {}),
            }
        await report_progress("mouth kit ready", 1.0)
    except Exception as exc:
        cause = exc.exceptions[0] if isinstance(exc, ExceptionGroup) else exc
        logger.error("performance kit failed after %d call(s): %r", state["calls"], cause)
        raise KitFailed(state["calls"], state["billed"], call_log) from cause
    return KitResult(
        manifest=finished.manifest,
        profile=finished.fit.profile,
        profile_fit=finished.fit.as_dict(),
        teeth_source=finished.teeth,
        report=report,
        calls=state["calls"],
        billed_calls=state["billed"],
        call_log=call_log,
        base_detected=base_detected is not None,
        teeth_report=teeth_report,
    )
