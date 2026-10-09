"""A face's anchors: the base mesh and the marks a wizard opens on, found on
one image for one line, and the rig a set of marks fits on them.

CPU work, below everything that uses it: the creation wizard (services.
creations) stores and fits them, and the photo touch-up (services.
photo_adjust) checks its candidates with them.
"""

from __future__ import annotations

import io

import numpy as np
from PIL import Image

from app.models.shapes import FoundAnchors, Marks, Note
from app.services import face_template, landmarks
from app.services.anchor_fit import (
    FitProblem,
    FitResult,
    fit_marks,
    fit_rig,
    marks_from_dict,
    marks_to_dict,
    merge,
    own_marks,
)
from app.services.lines import rules_for
from app.services.photo_io import on_backdrop
from app.services.rig import build_rig
from app.services.riggable import check_landmarks


def detect_anchors(png: bytes, face_type: str) -> FoundAnchors:
    """The base mesh and the marks the wizard opens on. CPU work.

    The base is what every fit of these marks starts from, exactly as an
    avatar's fit-base.json is: the detection, else the face template placed
    where a face usually is. The marks sit on the very landmarks they attach
    to (anchor_fit.own_marks, in the line's scheme), so a good detection
    means dragging nothing. M4 adds Gemini points here, behind consent, for
    the lines MediaPipe cannot see.
    """
    # A cut-out on the neutral grey, as the photo check and the AI see it.
    with Image.open(io.BytesIO(png)) as opened:
        image = on_backdrop(opened)
    size = image.size
    points = None
    if rules_for(face_type).detector == "mediapipe":
        try:
            found = landmarks.detect(image)
        except landmarks.LandmarkerUnavailable:
            found = None
        if found is not None:
            points = found.points
    return anchors_on(points, (size[0], size[1]), face_type)


def anchors_on(points: np.ndarray | None, size: tuple[int, int], face_type: str) -> FoundAnchors:
    """detect_anchors once the detector has answered: `points` its 478
    landmarks, or None when it found no face.

    The marks are the base's own (anchor_fit.own_marks), which the
    validator passes by construction: "Reset points" restores them, so they
    must never be a layout the owner cannot publish. A detection whose own
    marks are refused anyway (only marks out of order can be: lids crossed
    on a closed eye, a far eye past the near one on a turned head) is not
    trusted: the face template, placed on the detection's face, is opened
    instead, as a guess the owner places, as if nothing had been found.
    """
    detected = points is not None
    if points is None:
        points = face_template.place(face_template.default_box(*size))
    # Rounded as stored, so the fit reported now is the fit finish repeats.
    base = np.round(np.asarray(points, dtype=np.float64), 3)
    stored, problems = _own_fit(base, size, face_type)
    if problems and detected:
        x0, y0 = base.min(axis=0)
        x1, y1 = base.max(axis=0)
        guess = face_template.place((float(x0), float(y0), float(x1), float(y1)))
        base, detected = np.round(np.asarray(guess, dtype=np.float64), 3), False
        stored, problems = _own_fit(base, size, face_type)

    warnings: list[Note] = []
    if face_type == "human" and detected:
        verdict = check_landmarks(base, size, detected=True)
        if not verdict.ok:
            warnings.append({"code": verdict.code or "photo_check", "detail": verdict.reason or ""})
    ok = not problems
    return {
        "image_size": list(size),
        "detected": detected,
        "base": base.tolist(),
        "marks": stored,
        "validation": {
            "ok": ok,
            "reasons": [{"code": p.code, "detail": p.detail, "count": p.count} for p in problems],
            "warnings": warnings,
            "detected": detected,
            # "Looks right" in one click: the validator is happy with a real
            # detection on a line that allows it, and nothing looks off.
            "one_click": ok and detected and rules_for(face_type).one_click and not warnings,
        },
    }


def _own_fit(
    base: np.ndarray, size: tuple[int, int], face_type: str
) -> tuple[Marks, list[FitProblem]]:
    """The base's own marks, as stored, and what the validator says of them."""
    stored = marks_to_dict(own_marks(base, face_type))
    skeleton = build_rig(base, size, None, face_type=face_type)
    _, problems = fit_rig(skeleton, base, marks_from_dict(stored, face_type), face_type)
    return stored, problems


def fit_from_anchors(anchors: FoundAnchors, sent: Marks | None, face_type: str) -> FitResult:
    """The fit finish would build from these anchors and the marks the
    client sent, merged over the stored ones (a region left out keeps its
    stored marking): the rig, what refuses it, and what was smoothed.
    Always fitted from the stored base, so preview and finish cannot
    disagree."""
    base = np.array(anchors["base"], dtype=np.float64)
    width, height = anchors["image_size"]
    size = (width, height)
    skeleton = build_rig(base, size, None, face_type=face_type)
    marks = merge(
        marks_from_dict(anchors.get("marks"), face_type), marks_from_dict(sent, face_type)
    )
    return fit_marks(skeleton, base, marks, face_type)
