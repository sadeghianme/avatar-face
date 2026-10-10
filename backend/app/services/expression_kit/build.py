"""5. build_expressions: the requests sent, each answer registered and
checked, the source's skin kept, the pictures and the manifest made.

The mouth kit's machinery throughout: its crops and its request loop
(performance_kit.Sender: once each, once more on the head crop after a
refusal, every call accounted for), its registration on the eye corners and
nose bridge with every drift guard but the eyes' (an expression moves the
lids), against the detector's own view of the base photo. Then this
module's own: the expression reached (reached.expression_reached), the
source's skin (fidelity.keep_skin), the picture encoded.
"""

from __future__ import annotations

import asyncio
import inspect
import io
import logging
import uuid
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field

import numpy as np
from PIL import Image

from app.core.config import get_settings
from app.services import photo_adjust
from app.services.expression_kit.constants import EXPRESSIONS, IMAGE_QUALITY
from app.services.expression_kit.fidelity import keep_skin
from app.services.expression_kit.manifest import ExpressionEntry, build_manifest
from app.services.expression_kit.prompts import expression_prompt
from app.services.expression_kit.reached import expression_reached, measures, shows_smile
from app.services.jobs import run_cpu
from app.services.performance_kit import (
    Detector,
    EditImage,
    KitFailed,
    KitUnavailable,
    ManifestFrame,
    PoseRegistration,
    PoseRequest,
    ReferenceMotion,
    Sender,
    load_reference,
    register_face,
)
from app.services.performance_kit.answers import make_reason
from app.services.performance_kit.kit import detect_base
from app.services.performance_kit.requests import Crop, checked_points, load_base_image

logger = logging.getLogger("liveface.expression_kit")

# on_progress(fraction, message, done, total)
Progress = Callable[[float, str, int, int], object]


@dataclass
class Made:
    """One expression made: its picture (WebP) and what the manifest says."""

    picture: bytes
    entry: ExpressionEntry


@dataclass
class ExpressionsResult:
    kit_id: str
    manifest: dict | None
    made: dict[str, Made]
    # Per expression: {status: ok | failed, outcome, reason, attempts,
    # checks}, checks with the expression's measures.
    report: dict[str, dict]
    calls: int
    billed_calls: int
    call_log: list[dict]
    base_detected: bool = False
    model: str | None = None


def request_for(name: str, crop: Crop) -> PoseRequest:
    return PoseRequest(
        name, crop.kind, expression_prompt(name), crop.payload, "image/jpeg", crop.box
    )


def sent_picture(request: PoseRequest) -> Image.Image:
    with Image.open(io.BytesIO(request.payload)) as decoded:
        return decoded.convert("RGB")


def to_request(points: np.ndarray, request: PoseRequest, size: tuple[int, int]) -> np.ndarray:
    """Base-photo pixels to the pixels of the picture `request` sent."""
    x0, y0, x1, y1 = request.box
    return (points - np.array([x0, y0])) * np.array([size[0] / (x1 - x0), size[1] / (y1 - y0)])


def encode(image: Image.Image) -> bytes:
    out = io.BytesIO()
    image.save(out, format="WEBP", quality=IMAGE_QUALITY, method=6)
    return out.getvalue()


@dataclass
class Checker:
    """An answer checked as an expression (CPU work: the Sender runs it on
    the CPU thread). What it made of each is kept in `made`."""

    base_image: Image.Image
    points: np.ndarray
    frame: ManifestFrame
    detect: Detector
    base_detected: np.ndarray | None
    made: dict[str, Made] = field(default_factory=dict)

    def __call__(self, answer: bytes, request: PoseRequest) -> PoseRegistration:
        name = request.shape
        face = register_face(
            answer,
            request,
            self.base_image,
            self.points,
            self.frame,
            self.detect,
            self.base_detected,
            eye_guard=False,
        )
        result, registered, base_view = face.registration, face.registered, face.base_view
        if registered is None or base_view is None:
            return result
        values = measures(registered, base_view)
        result.checks["measures"] = values
        missed = expression_reached(name, values)
        if missed:
            result.reason = make_reason("expression_not_reached", f"Not {name}: {missed}")
            return result
        image, answer_points = result.answer_image, result.answer_points
        assert image is not None and answer_points is not None  # set by register_face
        sent = sent_picture(request)
        kept = keep_skin(sent, to_request(base_view, request, sent.size), image, answer_points)
        targets = self.points + (registered - base_view)
        result.targets = targets
        self.made[name] = Made(
            encode(kept),
            ExpressionEntry(kept.size, answer_points, targets, shows_smile(name, values)),
        )
        return result


def require_landmarker() -> None:
    if not get_settings().rig_model_path:
        raise KitUnavailable(
            "landmarks_unavailable", "Face detection is not available on this server"
        )


async def build_expressions(
    base_png: bytes,
    base_points,
    edit_image: EditImage,
    *,
    names: Sequence[str] = EXPRESSIONS,
    concurrency: int = 3,
    per_call_timeout: float | None = None,
    bound_calls: bool = True,
    on_progress: Progress | None = None,
    kit_id: str | None = None,
    detect: Detector | None = None,
    reference: ReferenceMotion | None = None,
) -> ExpressionsResult:
    """This face's expression pictures: one edit per expression in `names`,
    each registered, checked and kept to the source's skin.

    `edit_image(prompt, payload, mime)` as for performance_kit.build_kit
    (imagegen.edit_image, guarded, or a test's fake). An expression that
    fails for any reason is reported and left out of the manifest: the
    engine plays it animated. The manifest is None when none was made.
    Raises ValueError for malformed points, KitUnavailable (before any
    call) without a detector, and KitFailed, accounting for every call
    sent, when anything else fails."""
    points = checked_points(base_points)
    for name in names:
        if name not in EXPRESSIONS:
            raise ValueError(f"unknown expression {name!r}")
    if detect is None:
        require_landmarker()
        detect = photo_adjust.detect_points
    if reference is None:
        reference = await run_cpu(load_reference)
    kit_id = kit_id or uuid.uuid4().hex
    base_image = await run_cpu(load_base_image, base_png)
    frame = ManifestFrame.from_base(points, base_image.size, reference)
    base_detected = await run_cpu(detect_base, detect, base_image, points)
    checker = Checker(base_image, points, frame, detect, base_detected)
    sender = Sender(
        base_image,
        points,
        edit_image,
        request_for,
        concurrency=concurrency,
        per_call_timeout=per_call_timeout,
        bound_calls=bound_calls,
        name="expression kit",
    )
    done = 0

    async def tracked(name: str) -> tuple[PoseRegistration | None, dict]:
        nonlocal done
        outcome = await sender.ask(name, checker)
        done += 1
        if on_progress is not None:
            reported = on_progress(0.95 * done / len(names), name, done, len(names))
            if inspect.isawaitable(reported):
                await reported
        return outcome

    try:
        # A task group, as the mouth kit's: should anything fail, every call
        # still in flight is cancelled and awaited before this returns.
        async with asyncio.TaskGroup() as group:
            tasks = {name: group.create_task(tracked(name)) for name in names}
    except Exception as exc:
        # Broad on purpose: whatever stopped the group, with every call sent
        # accounted for.
        cause = exc.exceptions[0] if isinstance(exc, ExceptionGroup) else exc
        logger.error("expression kit failed after %d call(s): %r", sender.calls, cause)
        raise KitFailed(sender.calls, sender.billed, sender.call_log) from cause

    report = {}
    for name, task in tasks.items():
        registration, entry = task.result()
        ok = registration is not None and registration.ok and name in checker.made
        report[name] = {
            "status": "ok" if ok else "failed",
            "outcome": entry["outcome"],
            "reason": entry.get("reason"),
            "attempts": entry["attempts"],
            "checks": entry.get("checks", {}),
        }
    made = {name: checker.made[name] for name in names if report[name]["status"] == "ok"}
    model = next((call["model"] for call in sender.call_log if call.get("model")), None)
    manifest = None
    if made:
        manifest = await run_cpu(
            build_manifest,
            points,
            base_image.size,
            {name: m.entry for name, m in made.items()},
            kit_id=kit_id,
            model=model,
        )
    return ExpressionsResult(
        kit_id=kit_id,
        manifest=manifest,
        made=made,
        report=report,
        calls=sender.calls,
        billed_calls=sender.billed,
        call_log=sender.call_log,
        base_detected=base_detected is not None,
        model=model,
    )
