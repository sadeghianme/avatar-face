"""The rig fitted to the marks, and the base it is always fitted from,
kept beside the rig in storage (fit-base.json)."""

from __future__ import annotations

import json
import logging

import numpy as np
from scipy.spatial import Delaunay

from app.services.storage import STORAGE_ERRORS

from app.services.anchor_fit.marks import FaceMarks, marks_to_dict
from app.services.anchor_fit.scheme import (
    LINE_CORNERS,
    NUM_POINTS,
    marks_mouth_as_line,
    marks_pupils,
    render_profile_for,
)
from app.services.anchor_fit.validation import FitProblem, validate
from app.services.anchor_fit.warping import (
    correspondences,
    part_lips,
    pupil_pairs,
    warp,
)

logger = logging.getLogger("liveface.anchor_fit")


# --- The rig ----------------------------------------------------------------------


def fit_rig(
    rig: dict, base: np.ndarray, marks: FaceMarks, face_type: str
) -> tuple[dict, list[FitProblem]]:
    """The rig these marks make from `base`, and what is wrong with it.

    Everything that is not geometry (visemes, lip rings, crop origin) is
    carried over. The triangulation is redone on the fitted points: the
    base's triangles describe the base's shape, and on a face the fit has
    reshaped heavily they are no longer its best triangulation. The engine
    takes any triangle list, and the lip rings are index lists, still valid.
    """
    if marks_mouth_as_line(face_type):
        base = part_lips(base)
    pairs = correspondences(base, marks, face_type)
    fitted = warp(base, pairs)
    # Marked landmarks land exactly on their marks. The warp's smoothing
    # leaves them a hundredth of a pixel off, which is nothing — except where
    # several landmarks share one mark (the commissure on a mouth corner),
    # and that hundredth is then a sliver with an orientation of its own.
    for i, target in pairs + pupil_pairs(base, marks, face_type):
        fitted[i] = target
    fitted = np.round(fitted, 2)
    problems = validate(base, fitted, pupils=marks_pupils(face_type))

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
    out["face_box"] = [float(fitted[:, 0].min()), float(fitted[:, 1].min()),
                       float(fitted[:, 0].max()), float(fitted[:, 1].max())]
    # Marks come from the owner's hands by definition here, whatever the
    # client claims: later lines will store detector-sourced marks too, and
    # only these may count as confirmed.
    out["user_anchors"] = {**marks_to_dict(marks), "source": "owner"}
    profile = render_profile_for(face_type)
    if profile:
        out["render_profile"] = profile
    else:
        out.pop("render_profile", None)
    return out, problems


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
