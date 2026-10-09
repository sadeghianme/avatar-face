"""The rig fitted to the marks, and the base it is always fitted from,
kept beside the rig in storage (fit-base.json)."""

from __future__ import annotations

import json
import logging
import math
from dataclasses import dataclass, field, replace
from functools import lru_cache

import numpy as np
from scipy.spatial import Delaunay

from app.services.anchor_fit.marks import (
    FaceMarks,
    PupilMarks,
    RegionMarks,
    marks_from_dict,
    marks_from_mesh,
    marks_to_dict,
)
from app.services.anchor_fit.scheme import (
    CHIN,
    EYE_SLACK,
    HEAD,
    HEAD_DIAGONALS,
    IRIS,
    LEFT_COMMISSURE,
    LEFT_EYE,
    LINE_CORNERS,
    MOUTH,
    NUM_POINTS,
    OVERSHOOT,
    RIGHT_COMMISSURE,
    RIGHT_EYE,
    SEAM,
    marks_mouth_as_line,
    marks_pupils,
    render_profile_for,
)
from app.services.anchor_fit.smoothing import smooth_folds
from app.services.anchor_fit.validation import FOLDED_MESH, FitProblem, validate
from app.services.anchor_fit.warping import (
    correspondences,
    part_lips,
    pupil_pairs,
    warp,
)
from app.services.storage import STORAGE_ERRORS

logger = logging.getLogger("liveface.anchor_fit")


# --- The fitted points --------------------------------------------------------------


def _start(base: np.ndarray, face_type: str) -> np.ndarray:
    """The mesh a fit warps: the base, its lips parted on a mouth line."""
    return part_lips(base) if marks_mouth_as_line(face_type) else base


def _overshoot(start: np.ndarray, fitted: np.ndarray, pairs: list[tuple[int, np.ndarray]]) -> float:
    """How much further than any pin the warp moved a landmark nothing
    pins, as a fraction of the face."""
    pinned = np.zeros(len(start), dtype=bool)
    pinned[[i for i, _ in pairs]] = True
    if pinned.all():
        return 0.0
    most = max(float(np.linalg.norm(np.asarray(t) - start[i])) for i, t in pairs)
    carried = float(np.linalg.norm(fitted[~pinned] - start[~pinned], axis=1).max())
    return (carried - most) / max(float(np.ptp(start, axis=0).max()), 1.0)


def _fitted_points(
    start: np.ndarray, marks: FaceMarks, face_type: str, tear: bool = False
) -> np.ndarray:
    """Every landmark where these marks put it, from `start`, rounded as a
    rig stores it (`tear`: warping.warp's).

    A warp that throws an unpinned landmark further than OVERSHOOT of the
    face beyond any pin has pins that start together pulled apart (a shut
    eye's lids, one of them moved: a 3 px nudge moved the face 80 px, and
    nothing folded, so nothing refused it), and is done again with them
    torn apart."""
    pairs = correspondences(start, marks, face_type)
    fitted = warp(start, pairs, tear=tear)
    if not tear and _overshoot(start, fitted, pairs) > OVERSHOOT:
        fitted = warp(start, pairs, tear=True)
    # Marked landmarks land exactly on their marks. The warp's smoothing
    # leaves them a hundredth of a pixel off, which is nothing — except where
    # several landmarks share one mark (the commissure on a mouth corner),
    # and that hundredth is then a sliver with an orientation of its own.
    for i, target in pairs + pupil_pairs(start, marks, face_type):
        fitted[i] = target
    return np.round(fitted, 2)


def warped_points(base: np.ndarray, marks: FaceMarks, face_type: str) -> np.ndarray:
    """Every landmark where these marks put it, from `base`, before any fold
    is smoothed: the mesh fit_marks validates first."""
    return _fitted_points(_start(base, face_type), marks, face_type)


def _pupil_in_eye(pupil: PupilMarks | None, eye: RegionMarks | None) -> PupilMarks | None:
    """`pupil` moved, rim and all, to the nearest point inside its eye's
    marks where the validator calls it outside (past their box by more
    than EYE_SLACK): a shut eye's iris is detected where the eyeball is,
    above the lids that meet below it, and a pupil "outside its eye" is
    refused. A pupil the validator passes is left exactly where it was
    detected."""
    if pupil is None or eye is None:
        return pupil
    (x0, x1), (y0, y1) = sorted((eye.left[0], eye.right[0])), sorted((eye.top[1], eye.bottom[1]))
    # Rounded inwards, to the hundredth the marks are stored at.
    slack = math.floor(EYE_SLACK * (x1 - x0) * 100) / 100
    px, py = pupil.center
    if x0 - slack <= px <= x1 + slack and y0 - slack <= py <= y1 + slack:
        return pupil
    cx, cy = min(max(px, x0), x1), min(max(py, y0), y1)
    dx, dy = cx - pupil.center[0], cy - pupil.center[1]
    if not (dx or dy):
        return pupil
    return PupilMarks((cx, cy), (pupil.rim[0] + dx, pupil.rim[1] + dy))


def own_marks(base: np.ndarray, face_type: str) -> FaceMarks:
    """The marks a base opens on, exactly as they are stored: on the very
    landmarks they attach to, in the mesh no marks make (the base, its lips
    parted), to the hundredth of a pixel — but a pupil inside its eye. The
    marks "Reset points" restores, and the ones a detection is published on
    in one click."""
    opened = _fitted_points(_start(base, face_type), FaceMarks(), face_type)
    marks = marks_from_mesh(opened, face_type)
    marks = replace(
        marks,
        left_pupil=_pupil_in_eye(marks.left_pupil, marks.left_eye),
        right_pupil=_pupil_in_eye(marks.right_pupil, marks.right_eye),
    )
    return marks_from_dict(marks_to_dict(marks), face_type)


@lru_cache(maxsize=64)
def _reference(raw: bytes, shape: tuple[int, ...], face_type: str) -> np.ndarray:
    base = np.frombuffer(raw, dtype=np.float64).reshape(shape)
    points = _fitted_points(_start(base, face_type), own_marks(base, face_type), face_type)
    points.setflags(write=False)
    return points


def reference_points(base: np.ndarray, face_type: str) -> np.ndarray:
    """The mesh the base's own marks make (`own_marks`, fitted). Read-only.

    Every fit of this base is judged against it as well as the base
    (validation.folded): it is where the fit lays out what it builds rather
    than carries — the lips on a mouth line, the oval on the outline — so a
    triangle it turns over from the base was laid out, not folded. Measured
    before this, on 2,592 detector-like faces (real detections, rolled,
    widened, mouths opened, eyes shut, jittered): 61% were refused on their
    own marks on the cartoon line for folds, every one a lip or oval
    triangle a pixel thin that the layout turns over; half a pixel of
    detector noise refused a third of them. Cached: the marking panel fits
    the same base on every drag.
    """
    base = np.ascontiguousarray(base, dtype=np.float64)
    return _reference(base.tobytes(), base.shape, face_type)


def pinned_landmarks(marks: FaceMarks, face_type: str) -> set[int]:
    """The landmarks the owner's marks pin, which smoothing never moves."""
    pinned: set[int] = set(IRIS)
    if marks.head is not None:
        pinned |= set(HEAD.values()) | {HEAD_DIAGONALS[d] for d in marks.head.diagonals()}
    if marks.chin is not None:
        pinned.add(CHIN)
    for idx, region in ((LEFT_EYE, marks.left_eye), (RIGHT_EYE, marks.right_eye)):
        if region is not None:
            pinned |= set(idx.values())
    if marks_mouth_as_line(face_type):
        if marks.mouth_line is not None:
            pinned |= set(LEFT_COMMISSURE) | set(RIGHT_COMMISSURE)
    elif marks.mouth is not None:
        pinned |= set(MOUTH.values())
        if marks.mouth.center is not None:
            pinned |= set(SEAM)
    return pinned


# --- The rig ----------------------------------------------------------------------


@dataclass(frozen=True)
class FitResult:
    """A fit: the rig, what refuses it, and what was smoothed on the way
    (FitProblem-shaped notes the owner may be told; nothing to act on)."""

    rig: dict
    problems: list[FitProblem]
    notes: list[FitProblem] = field(default_factory=list)


def fit_marks(rig: dict, base: np.ndarray, marks: FaceMarks, face_type: str) -> FitResult:
    """The rig these marks make from `base`, what is wrong with it, and
    what was smoothed.

    Everything that is not geometry (visemes, lip rings, crop origin) is
    carried over. The triangulation is redone on the fitted points: the
    base's triangles describe the base's shape, and on a face the fit has
    reshaped heavily they are no longer its best triangulation. The engine
    takes any triangle list, and the lip rings are index lists, still valid.

    A fit whose only problem is folded triangles has them smoothed
    (smoothing.smooth_folds) when that moves no mark and nothing far —
    first on its own warp, then on one where pins that start together and
    are pulled apart are one control point (warping.warp's `tear`) — and is
    then saveable, with a note saying how many there were. Marks out of
    place (a mouth above the eyes, lids upside down, an outline crossed)
    are refused as they are: smoothing would hide them, not fix them. A fit
    that passes as it is never goes through either, so it is the rig it
    always was.
    """
    start = _start(base, face_type)
    fitted = _fitted_points(start, marks, face_type)
    reference = reference_points(base, face_type)
    pupils = marks_pupils(face_type)
    problems = validate(start, fitted, pupils=pupils, reference=reference)
    if not problems or any(p.code != FOLDED_MESH for p in problems):
        return FitResult(_rig(rig, fitted, marks, face_type), problems)
    count = problems[0].count or 0
    pinned = pinned_landmarks(marks, face_type)
    for tear in (False, True):
        warped = _fitted_points(start, marks, face_type, tear=True) if tear else fitted
        smoothed = smooth_folds(start, reference, warped, pinned)
        if smoothed is None or validate(start, smoothed[0], pupils=pupils, reference=reference):
            continue
        note = FitProblem(
            "folds_smoothed",
            f"{count} thin triangle{'s' if count != 1 else ''} between the marks "
            "would have folded over and were smoothed",
            count,
        )
        return FitResult(_rig(rig, smoothed[0], marks, face_type), [], [note])
    return FitResult(_rig(rig, fitted, marks, face_type), problems)


def fit_rig(
    rig: dict, base: np.ndarray, marks: FaceMarks, face_type: str
) -> tuple[dict, list[FitProblem]]:
    """(rig, problems): `fit_marks` without its notes."""
    result = fit_marks(rig, base, marks, face_type)
    return result.rig, result.problems


def _rig(rig: dict, fitted: np.ndarray, marks: FaceMarks, face_type: str) -> dict:
    """`rig` with these fitted points, retriangulated, and its marks."""
    triangles = Delaunay(fitted).simplices
    if marks_mouth_as_line(face_type):
        # Qhull keeps one landmark of each corner's coincident four, which
        # one depending on the layout; every corner is drawn with the same.
        remap = np.arange(len(fitted))
        remap[list(LINE_CORNERS)] = list(LINE_CORNERS.values())
        triangles = remap[triangles]
    out = dict(rig)
    out["points"] = fitted.tolist()
    out["triangles"] = triangles.tolist()
    out["face_box"] = [
        float(fitted[:, 0].min()),
        float(fitted[:, 1].min()),
        float(fitted[:, 0].max()),
        float(fitted[:, 1].max()),
    ]
    # Marks come from the owner's hands by definition here, whatever the
    # client claims: later lines will store detector-sourced marks too, and
    # only these may count as confirmed.
    out["user_anchors"] = {**marks_to_dict(marks), "source": "owner"}
    profile = render_profile_for(face_type)
    if profile:
        out["render_profile"] = profile
    else:
        out.pop("render_profile", None)
    return out


# --- The stored base ------------------------------------------------------------

FIT_BASE_VERSION = 1


def fit_base_key(org_id: str, avatar_id: str) -> str:
    return f"orgs/{org_id}/avatars/{avatar_id}/fit-base.json"


def fit_base_record(points: np.ndarray, rig: dict, detected: bool) -> dict:
    """The base mesh, stamped with the frame of the rig it belongs to."""
    return {
        "version": FIT_BASE_VERSION,
        "image_size": list(rig["image_size"]),
        "crop_origin": rig.get("crop_origin"),
        "detected": bool(detected),
        "points": [[round(float(px), 3), round(float(py), 3)] for px, py in points],
    }


def fit_base_points(record: dict | None, rig: dict) -> np.ndarray | None:
    """The base's points, if `record` is a base for this rig's frame."""
    if not record or record.get("version") != FIT_BASE_VERSION:
        return None
    if list(record.get("image_size") or []) != list(rig["image_size"]):
        return None
    if record.get("crop_origin") != rig.get("crop_origin"):
        return None
    points = np.array(record.get("points") or [], dtype=np.float64)
    return points if points.shape == (NUM_POINTS, 2) else None


def move_fit_base(record: dict, left: float, top: float, rig: dict) -> dict:
    """The base for `rig`, whose image's top-left sits at (left, top) of the
    image the base was taken in — a crop, or with a negative origin, the crop
    undone. Exactly what crop does to the rig itself."""
    moved = dict(record)
    moved["points"] = [[round(px - left, 3), round(py - top, 3)] for px, py in record["points"]]
    moved["image_size"] = list(rig["image_size"])
    moved["crop_origin"] = rig.get("crop_origin")
    return moved


async def read_fit_base(storage, key: str) -> dict | None:
    try:
        if not await storage.exists(key):
            return None
        return json.loads(await storage.get_bytes(key))
    except STORAGE_ERRORS:
        # A base is always rebuildable from the photo; an unreadable one is
        # treated as missing rather than blocking the owner's fit.
        logger.exception("unreadable fit base %s", key)
        return None


async def write_fit_base(storage, key: str, record: dict) -> None:
    await storage.put_bytes(key, json.dumps(record).encode(), "application/json")
