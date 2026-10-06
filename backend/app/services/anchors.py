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

from app.services import face_template, landmarks
from app.services.anchor_fit import (
    FaceMarks,
    fit_rig,
    marks_from_dict,
    marks_from_mesh,
    marks_to_dict,
    merge,
)
from app.services.lines import rules_for
from app.services.photo_io import on_backdrop
from app.services.rig import build_rig
from app.services.riggable import check_landmarks


def detect_anchors(png: bytes, face_type: str) -> dict:
    """The base mesh and the marks the wizard opens on. CPU work.

    The base is what every fit of these marks starts from, exactly as an
    avatar's fit-base.json is: the detection, else the face template placed
    where a face usually is. The marks sit on the very landmarks they attach
    to (anchor_fit.marks_from_mesh, in the line's scheme), so a good
    detection means dragging nothing. M4 adds Gemini points here, behind
    consent, for the lines MediaPipe cannot see.
    """
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
            warnings.append({"code": verdict.code or "photo_check", "detail": verdict.reason or ""})
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
    base = np.array(anchors["base"], dtype=np.float64)
    size = tuple(anchors["image_size"])
    skeleton = build_rig(base, size, None, face_type=face_type)
    marks = merge(
        marks_from_dict(anchors.get("marks"), face_type), marks_from_dict(sent, face_type)
    )
    return fit_rig(skeleton, base, marks, face_type)
