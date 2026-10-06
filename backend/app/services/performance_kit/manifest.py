"""5. The manifest ContinuousMouth loads, and a stored kit moved onto the
face's points as they are now (rebase_manifest)."""

from __future__ import annotations

import copy
from collections.abc import Callable
from dataclasses import dataclass

import numpy as np

from app.services.performance_kit.constants import (
    CHARACTER_PREFIX,
    INNER_LIP_RING,
    KIT_ID,
    KIT_VERSION,
    MANIFEST_VERSION,
    OUTER_LIP_RING,
    PROMPTS_VERSION,
    REFERENCE_CHARACTER,
    SHAPES,
)
from app.services.performance_kit.registration import (
    ManifestFrame,
    ReferenceMotion,
    load_reference,
    mouth_frame,
    shared_triangles,
)
from app.services.performance_kit.requests import _checked_points

GENERATED = "generated"
RETARGETED = "retargeted"
BASE = "base"


@dataclass(frozen=True)
class PoseEntry:
    """One shape for the manifest: targets in base pixels and where they
    came from."""

    targets: np.ndarray
    provenance: str
    rms: float | None = None


# Manifest units to five decimals: a hundred-thousandth of the Reference's
# image, 1/15000 of a mouth width. Every visitor downloads the manifest, and
# two more decimals made it a third larger for nothing the engine can show.
MANIFEST_DECIMALS = 5


def _rounded(points: np.ndarray) -> list:
    return np.asarray(points, dtype=np.float64).round(MANIFEST_DECIMALS).tolist()


def build_manifest(
    base_points: np.ndarray,
    image_size: tuple[int, int],
    poses: dict[str, PoseEntry],
    reference: ReferenceMotion,
    *,
    kit_id: str,
    jaw_range: float,
) -> dict:
    """The per-avatar performance manifest (version 2).

    The fields ContinuousMouth reads are those of the Reference's manifest,
    with the same meaning: seven poses in PERFORMANCE_POSES order, each with
    478 `points`; `center` and `mouth_width` of the rest mouth; `triangles`
    and the lip rings. Version 2 adds, per pose, `provenance` (base,
    generated or retargeted) and has `image` and `source` null (a pose's
    own photo is not delivered: the continuous mouth warps the one portrait,
    and never reads where the landmarks were in the answer, which made half
    of every visitor's download) and `registration_rms` null for a
    retargeted pose; and at the top, `jaw_range` (the profile jawRange this
    geometry is true at: the engine scales movement by jawRange / jaw_range),
    `frame` (base pixels to manifest units) and `kit` (recipe versions).
    Points are in manifest units to MANIFEST_DECIMALS.
    """
    if set(poses) != set(SHAPES):
        raise ValueError("every shape needs a pose")
    if not isinstance(kit_id, str) or not KIT_ID.fullmatch(kit_id):
        raise ValueError("kit_id must be 1-64 ASCII letters, digits, '-' or '_'")
    frame = ManifestFrame.from_base(base_points, image_size, reference)
    rest = frame.apply(base_points)
    width, cx, cy = mouth_frame(rest, OUTER_LIP_RING)
    entries = [{
        "id": "rest", "image": None, "source": None,
        "points": _rounded(rest), "registration_rms": 0.0, "provenance": BASE,
    }]
    for shape in SHAPES:
        pose = poses[shape]
        entries.append({
            "id": shape,
            "image": None,
            "source": None,
            "points": _rounded(frame.apply(pose.targets)),
            "registration_rms": None if pose.rms is None else round(float(pose.rms), 6),
            "provenance": pose.provenance,
        })
    triangles = shared_triangles([e["points"] for e in entries], rest, (cx, cy), width)
    detail = MANIFEST_DECIMALS + 2
    return {
        "version": MANIFEST_VERSION,
        "character": f"{CHARACTER_PREFIX}{kit_id}",
        "poses": entries,
        "triangles": triangles,
        "center": [round(cx, detail), round(cy, detail)],
        "mouth_width": round(width, detail),
        "inner_ring": INNER_LIP_RING,
        "outer_ring": OUTER_LIP_RING,
        "jaw_range": float(jaw_range),
        "frame": {
            "image_size": [int(image_size[0]), int(image_size[1])],
            "to_manifest": np.asarray(frame.matrix).round(10).tolist(),
        },
        "kit": {"version": KIT_VERSION, "prompts": PROMPTS_VERSION, "reference": REFERENCE_CHARACTER},
    }


def manifest_to_base(manifest: dict) -> Callable[[object], np.ndarray]:
    """The inverse of a version 2 manifest's frame: manifest units back to
    the base photo's pixels."""
    frame = np.asarray(manifest["frame"]["to_manifest"], dtype=np.float64)
    inverse = np.linalg.inv(frame[:, :2])
    offset = frame[:, 2]

    def to_base(points) -> np.ndarray:
        return (np.asarray(points, dtype=np.float64) - offset) @ inverse.T

    return to_base


def is_kit_manifest(manifest: object) -> bool:
    """A per-avatar manifest this module wrote (version 2, avatar-v1:...)."""
    return (
        isinstance(manifest, dict)
        and manifest.get("version") == MANIFEST_VERSION
        and str(manifest.get("character", "")).startswith(CHARACTER_PREFIX)
        and isinstance(manifest.get("frame"), dict)
    )


# Re-confirmed points this close to the manifest's own rest (base pixels)
# are the same points: the rest pose round-trips through manifest units at
# MANIFEST_DECIMALS, a hundredth of a pixel for a face 300 pixels wide.
SAME_POINTS_PX = 0.05


def rebase_manifest(
    manifest: dict,
    base_points,
    reference: ReferenceMotion | None = None,
    image_size: tuple[int, int] | None = None,
) -> dict:
    """The kit `manifest` moved onto re-confirmed points, with no AI call.

    The owner re-marked the face (Mark the face, a re-detection), or the
    picture moved under the same face (a crop, a crop reset, either undone:
    the same pixels, translated), and its rest pose is now `base_points`,
    the rig's 478 points in the picture's pixels, which is `image_size`
    large (the manifest's own frame size when not given). Every shape keeps
    the displacement from rest it had, in base pixels (recovered through the
    old frame's `to_manifest`): the answer moved the mouth that far,
    wherever the marks now say it rests, exactly as register_answer adds an
    answer's movement to the confirmed points. The frame is recomputed from
    the new points (build_manifest), so the manifest stays in the
    Reference's units and validates as any kit does; provenance,
    registration, the kit id, the recipe that made the poses (`kit`) and
    the jaw range are kept.

    Onto the manifest's own rest points and picture it returns the manifest
    unchanged. Raises ValueError for a manifest this module did not write,
    or points that are not 478 finite pixels. CPU work (the triangulation).
    """
    points = _checked_points(base_points)
    if not is_kit_manifest(manifest):
        raise ValueError("not a performance kit manifest")
    width, height = (int(v) for v in (image_size or manifest["frame"]["image_size"]))
    size = (width, height)
    to_base = manifest_to_base(manifest)
    poses = {pose["id"]: pose for pose in manifest["poses"]}
    rest = to_base(poses["rest"]["points"])
    same_picture = list(size) == list(manifest["frame"]["image_size"])
    if same_picture and np.abs(rest - points).max() <= SAME_POINTS_PX:
        return copy.deepcopy(manifest)
    reference = reference or load_reference()
    entries = {
        shape: PoseEntry(points + (to_base(poses[shape]["points"]) - rest),
                         poses[shape]["provenance"], poses[shape].get("registration_rms"))
        for shape in SHAPES
    }
    rebased = build_manifest(
        points, size, entries, reference,
        kit_id=manifest["character"][len(CHARACTER_PREFIX):],
        jaw_range=float(manifest["jaw_range"]),
    )
    # The recipe that made these poses, not today's.
    rebased["kit"] = copy.deepcopy(manifest.get("kit", rebased["kit"]))
    return rebased
