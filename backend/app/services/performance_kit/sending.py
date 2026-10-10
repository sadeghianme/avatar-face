"""1c. Sending: the edits of one face, each asked once (and once more on the
head crop after a refusal), at most `concurrency` at a time, every call
accounted for. Shared by the mouth kit (kit.build_kit) and the expression
pictures (services.expression_kit), which differ only in what they ask
for and how an answer is checked."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Protocol

import httpx
import numpy as np
from PIL import Image

from app.services import imagegen
from app.services.jobs import run_cpu
from app.services.performance_kit.answers import PoseRegistration, make_reason
from app.services.performance_kit.requests import (
    FACE_CROP,
    HEAD_CROP,
    Crop,
    PoseRequest,
    crop_picture,
)

logger = logging.getLogger("liveface.performance_kit")


class EditedImage(Protocol):
    """What an edit answers with: imagegen.Generated, or a test's fake (whose
    `model`, read with getattr, is optional)."""

    image: bytes


EditImage = Callable[[str, bytes, str], Awaitable[EditedImage]]
# How a request is made for one ask on one crop (its prompt, its payload).
RequestFor = Callable[[str, Crop], PoseRequest]
# How an answer is checked: CPU work, run on the CPU thread.
CheckAnswer = Callable[[bytes, PoseRequest], PoseRegistration]


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
    return make_reason(
        getattr(error, "code", None) or "imagegen_unavailable",
        getattr(error, "detail", None) or "AI editing is not configured on this server",
    )


@dataclass
class Sender:
    """The calls of one kit: the crops (one of each kind, shared), the
    semaphore, and the accounting (`calls` sent, `billed` answered,
    `call_log`, and `stopped`: why nothing more may be sent)."""

    base_image: Image.Image
    points: np.ndarray
    edit_image: EditImage
    request_for: RequestFor
    concurrency: int = 3
    per_call_timeout: float | None = None
    bound_calls: bool = True
    name: str = "performance kit"
    calls: int = 0
    billed: int = 0
    stopped: dict | None = None
    call_log: list[dict] = field(default_factory=list)
    crops: dict[str, asyncio.Future] = field(default_factory=dict)
    semaphore: asyncio.Semaphore = field(init=False)

    def __post_init__(self) -> None:
        self.semaphore = asyncio.Semaphore(max(1, int(self.concurrency)))
        if self.per_call_timeout is None:
            self.per_call_timeout = imagegen.TIMEOUT_SECONDS

    async def crop_for(self, kind: str) -> Crop | None:
        # One crop per kind, shared by every request that needs it;
        # shielded, so a request torn down while it waits does not cancel
        # it for the others (and a crop nobody waits for any more is not
        # left with an unretrieved error).
        if kind not in self.crops:
            future = asyncio.ensure_future(
                run_cpu(crop_picture, self.base_image, self.points, kind)
            )
            future.add_done_callback(lambda done: done.cancelled() or done.exception())
            self.crops[kind] = future
        return await asyncio.shield(self.crops[kind])

    async def send(self, request: PoseRequest):
        call = self.edit_image(request.prompt, request.payload, request.mime)
        if not self.bound_calls:
            return await call
        return await asyncio.wait_for(call, timeout=self.per_call_timeout)

    async def ask(self, shape: str, check: CheckAnswer) -> tuple[PoseRegistration | None, dict]:
        """One request (`shape`), asked on the face crop, and once more on
        the head crop after a refusal; its answer checked by `check`.
        Returns the registration (None when nothing usable came back) and
        its entry {attempts, outcome, reason, checks}."""
        entry: dict = {"attempts": []}
        kind = FACE_CROP
        while True:
            crop = await self.crop_for(kind)
            if crop is None:
                entry.update(
                    outcome="refused",
                    reason=make_reason(
                        "safety_refused", "The AI declined this edit, so it was not asked again"
                    ),
                )
                return None, entry
            request = self.request_for(shape, crop)
            async with self.semaphore:
                if self.stopped is not None:
                    entry.update(outcome="unavailable", reason=self.stopped)
                    return None, entry
                self.calls += 1
                record: dict = {"shape": shape, "kind": kind, "model": None}
                self.call_log.append(record)
                entry["attempts"].append(kind)
                try:
                    generated = await self.send(request)
                except imagegen.ImageGenRefused as exc:
                    self.billed += 1
                    record.update(outcome="refused", billed=True, detail=exc.reason)
                    if kind == FACE_CROP:
                        # Once more on the head crop: a different picture,
                        # the same request (photo_adjust's pattern).
                        kind = HEAD_CROP
                        continue
                    entry.update(
                        outcome="refused",
                        reason=make_reason(
                            "safety_refused", "The AI declined this edit, so it was not asked again"
                        ),
                    )
                    return None, entry
                except imagegen.ImageGenNoImage as exc:
                    self.billed += 1
                    record.update(outcome="no_image", billed=True, detail=exc.reason)
                    entry.update(
                        outcome="no_image",
                        reason=make_reason(
                            "no_image",
                            "The AI answered without an image, so it was not asked again",
                        ),
                    )
                    return None, entry
                except imagegen.ImageGenUnavailable as exc:
                    # Nothing was sent: no provider, or the caller sends no
                    # more (its switch, its limit, a consent it could not
                    # record). Nothing more is asked.
                    self.calls -= 1
                    self.call_log.remove(record)
                    entry["attempts"].pop()
                    reason = stop_reason(exc)
                    self.stopped = self.stopped or reason
                    entry.update(outcome="unavailable", reason=reason)
                    return None, entry
                except asyncio.CancelledError:
                    # Torn down (another request failed) or the caller was
                    # cancelled: this call was sent, and may be billed.
                    record.update(outcome="cancelled", billed=None)
                    raise
                except Exception as exc:
                    # Broad on purpose: the provider's call, classified by
                    # call_billing whatever it raised.
                    return None, self._failed(shape, exc, record, entry)
            self.billed += 1
            record.update(outcome="image", billed=True, model=getattr(generated, "model", None))
            registration = await self._check(shape, check, generated.image, request)
            entry.update(
                outcome="generated" if registration.ok else "rejected",
                reason=registration.reason,
                checks=registration.checks,
            )
            return registration, entry

    def _failed(self, shape: str, exc: Exception, record: dict, entry: dict) -> dict:
        if call_billing(exc) is None:
            # Sent, and possibly billed: the kit's own bound, or the
            # provider's read or write timeout (imagegen's 90 s arrives as
            # httpx's). Never asked again; the caller decides how to meter it.
            logger.warning("%s: the %s edit timed out (%r)", self.name, shape, exc)
            record.update(outcome="timeout", billed=None)
            entry.update(
                outcome="timeout",
                reason=make_reason("timeout", "The AI did not answer in time"),
            )
            return entry
        logger.exception("%s: the %s edit failed", self.name, shape)
        record.update(outcome="provider_error", billed=False)
        entry.update(
            outcome="provider_error",
            reason=make_reason("provider_error", "The AI service did not return an image"),
        )
        return entry

    async def _check(
        self, shape: str, check: CheckAnswer, image: bytes, request: PoseRequest
    ) -> PoseRegistration:
        try:
            return await run_cpu(check, image, request)
        except Exception:
            # Broad on purpose. A check that breaks on an answer is a check the answer did
            # not pass: given up, like any rejected one, and the other
            # requests' paid calls carry on.
            logger.exception("%s: checking the %s answer failed", self.name, shape)
            return PoseRegistration(
                shape,
                reason=make_reason(
                    "check_failed", "The AI's answer could not be checked, so it was not used"
                ),
            )
