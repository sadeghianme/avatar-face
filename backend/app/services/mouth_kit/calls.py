"""The kit's calls: what each is recorded as, the stage labels, the guard
that decides whether a call may go out and meters it when it ends, and
`make`, which runs performance_kit.build_kit with them."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from datetime import datetime, timezone

from app.core.errors import AppError
from app.services import imagegen, performance_kit
from app.services.jobs import Job, runner

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
