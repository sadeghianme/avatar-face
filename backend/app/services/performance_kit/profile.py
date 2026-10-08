"""The Reference's pose retargeted where a shape is missing (4), the mouth
profile fitted to the teeth photo (3), and the kit brought to the
Reference's size (3b)."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import cast

import numpy as np
from annotated_types import Ge, Le
from PIL import Image

from app.schemas.avatar import MouthProfile
from app.services import dental_photo
from app.services.performance_kit.answers import (
    MAX_OVER_REFERENCE,
    _down,
    _mouth_width,
    _reason,
    opening,
)
from app.services.performance_kit.constants import (
    INNER_LIP_RING,
    MOUTH_LEFT,
    MOUTH_RIGHT,
    SHAPES,
    UPPER_INNER,
)
from app.services.performance_kit.registration import (
    ReferenceMotion,
    _corner_angle,
    _level,
)

# --- 4. Retarget fallback -----------------------------------------------------------------------


def retarget_reference_pose(
    shape: str, base_points: np.ndarray, reference: ReferenceMotion
) -> np.ndarray:
    """The Reference's `shape`, moved onto this face: targets in base pixels.

    The Reference's displacement of every landmark is taken in its levelled
    mouth frame, scaled by this face's mouth width over the Reference's and
    turned into this face's mouth angle: exactly what the engine does with
    the bundled motion (ContinuousMouth scales its movement by the mouth
    width alone). So a retargeted pose plays as the same Reference pose
    does on this face through the bundled motion, whatever the lips' own
    thickness: how far a jaw drops is not set by how full the lips are.

    The falloff away from the mouth is NOT applied here: the engine applies
    it (performanceInfluence) to every pose, on the manifest's rest points,
    which in a per-avatar manifest are this face's own neutral points. So a
    retargeted pose is baked in full, and the embed needs no retarget code.
    The kit's manifest is true at the Reference's jaw range (its own shapes
    are brought to the Reference's size, normalize_amplitude), so a
    retargeted pose needs no amplitude of its own either.
    """
    rest, pose = reference.rest, reference.poses[shape]
    ref_level = _level(_corner_angle(rest))
    displacement = (pose - rest) @ ref_level.T
    local = displacement * (_mouth_width(base_points) / _mouth_width(rest))
    to_face = _level(-_corner_angle(base_points))  # R(+theta)
    return base_points + local @ to_face.T


# --- 3. Mouth profile fit -----------------------------------------------------------------------

# The jaw range the Reference's motion is true at: the profile default, and
# the embed's divisor for a version 1 manifest (ContinuousMouth.setProfile).
REFERENCE_JAW_RANGE = 0.85
# The embed's upper arch seat: dentalPlacement draws the bottom of the upper
# arch this far below the neutral lip seam, plus teethY (neutral mouth
# widths; the seam is centralMouthAnchors' corner line moved onto 13/14).
UPPER_SEAT = 0.055
# How much lower than the teeth photo's own registration the Reference's
# hand tuning draws its teeth. The Reference renders oral-detail-v3 with
# teethY 0.016, which puts that photo's arch edge 0.071 below the neutral
# seam; registered onto the Reference portrait on the ANCHORS, the photo
# itself puts it 0.0467 below. Every fitted face gets the same allowance,
# so a photo like v3 fits the Reference's value (tests/test_performance_kit.py).
REFERENCE_TEETH_DROP = 0.0243
# How the Reference draws its teeth photo: the one seat and size tuned by
# eye (frontend/src/features/lab/reference-avatar.ts, teethY 0.016 on the
# default teethScale). The standard teeth, which a mouth without a teeth
# photo of its own is drawn with, are that very photo
# (scripts/build_standard_teeth.py), so they are seated and sized the same
# way (for_standard_teeth). An AI teeth photo is drawn the same way too,
# not where and how large the model drew its teeth. The model imagines
# teeth for a closed-mouth portrait: on the second real run (2026-09-26)
# it drew them 0.125 mouth widths below the seam (v3: 0.047) in a smile
# 1.22 widths wide, and fitted to that (teethY 0.094 and teethScale 1.22,
# both past the renderer's limits) the engine drew them 12% wider and 28%
# taller than the Reference's, down on the lower lip: talking through
# clenched teeth. At the Reference's seat they sat where the Reference's
# do. Where the photo would put them is still measured (teeth_y_as_drawn,
# teeth_scale_as_drawn).
REFERENCE_TEETH_Y = 0.016
REFERENCE_TEETH_SCALE = 1.0


def _profile_defaults() -> tuple[dict, dict[str, tuple[float, float]]]:
    """Defaults and ranges: the API's MouthProfile, which mirrors the embed's
    DEFAULT_REFERENCE_PROFILE and PROFILE_LIMITS."""
    limits = {}
    for name, info in MouthProfile.model_fields.items():
        low = next(m.ge for m in info.metadata if isinstance(m, Ge))
        high = next(m.le for m in info.metadata if isinstance(m, Le))
        # annotated_types types a bound as anything comparable; these are numbers.
        limits[name] = (float(cast(float, low)), float(cast(float, high)))
    return MouthProfile().model_dump(), limits


def neutral_seam(points: np.ndarray) -> tuple[np.ndarray, np.ndarray, float]:
    """Where the embed seats the teeth from: the embed's centralMouthAnchors
    (mouth-extension.ts), the corner line moved perpendicular onto the two
    inner-lip points nearest the mouth's centre line. Returns its middle,
    the unit vector down the face, and the mouth width."""
    left, right = points[MOUTH_LEFT], points[MOUTH_RIGHT]
    if left[0] > right[0]:
        left, right = right, left
    d = right - left
    width = float(np.linalg.norm(d))
    ux = d / width
    down = np.array([-ux[1], ux[0]])
    centre = (left + right) / 2
    ring = points[INNER_LIP_RING]
    central = ring[np.argsort(np.abs((ring - centre) @ ux), kind="stable")[:2]]
    bow = float(((central - centre) @ down).mean())
    return centre + down * bow, down, width


@dataclass
class ProfileFit:
    profile: dict
    measurements: dict = field(default_factory=dict)
    # What was not fitted from this face, one entry per value (`field`), with
    # why. A teeth photo that is not drawn is teethY's entry: the standard
    # teeth are drawn instead, and this is why (_finish reports it).
    reasons: list[dict] = field(default_factory=list)
    # True when the profile is fitted for the teeth photo, which the embed
    # accepts: the caller hands the photo on only then.
    teeth_photo: bool = False

    def as_dict(self) -> dict:
        return {
            "profile": self.profile,
            "measurements": self.measurements,
            "reasons": self.reasons,
            "teeth_photo": self.teeth_photo,
        }


@dataclass(frozen=True)
class TeethPhoto:
    """The teeth answer: its image and landmarks in its own pixels, and
    those landmarks registered onto the base photo (base pixels)."""

    image: Image.Image
    points: np.ndarray
    targets: np.ndarray


def for_standard_teeth(profile: dict) -> dict:
    """`profile` with the teeth values of a mouth that has no teeth photo of
    its own; everything else unchanged. Such a mouth is drawn with the
    standard teeth, which are the Reference's own teeth photo
    (scripts/build_standard_teeth.py), so they are seated and sized as the
    Reference draws it (REFERENCE_TEETH_Y, REFERENCE_TEETH_SCALE): what
    fit_profile fits without a teeth photo, what a new person starts with
    (mouth_photo.default_config), and what a mouth gets whose teeth photo is
    not drawn after all (services.mouth_kit: the WebP visitors get is tested
    again, and a photo on the very edge of the embed's limits can fail
    there; or the owner removed it)."""
    return {**profile, "teethY": REFERENCE_TEETH_Y, "teethScale": REFERENCE_TEETH_SCALE}


def fit_profile(
    base_points: np.ndarray,
    teeth: TeethPhoto | None = None,
    why_no_teeth: dict | None = None,
) -> ProfileFit:
    """The teeth of the mouth profile, fitted to this face.

    `teeth` is the teeth answer (TEETH), registered. It counts only if the
    embed would draw it (dental_photo.accept_teeth_photo: DentalOralSurface's
    own test); one it would refuse leaves the standard teeth, and says why
    (so does `why_no_teeth`: why there is no answer to measure, its request
    failed or was refused).

    The teeth drawn are seated and sized as the Reference's either way
    (REFERENCE_TEETH_Y, REFERENCE_TEETH_SCALE: why, there): the standard
    teeth are the Reference's own photo (for_standard_teeth), and a teeth
    photo the embed draws is drawn the same way. Where such a photo would
    put its teeth is measured, not applied: teeth_y_as_drawn is where its
    upper arch ends (the bottom of the arch the embed extracts, which is
    what dentalPlacement seats), carried by the photo's registration onto
    the base and measured below the neutral seam in rest mouth widths
    (skull-fixed, so the photo's lifted upper lip is not taken for lower
    teeth), plus REFERENCE_TEETH_DROP, less UPPER_SEAT (on oral-detail-v3
    registered onto the Reference portrait this gives the hand-tuned
    0.016); teeth_scale_as_drawn is its mouth width over the rest's (1.13
    on v3, which the Reference draws at 1.00).

    The jaw range is not fitted: the kit's own shapes are brought to the
    Reference's size instead (normalize_amplitude), so the manifest is true
    at the Reference's jaw range and the owner's slider means what it means
    for every avatar.
    """
    defaults, _ = _profile_defaults()
    fit = ProfileFit(profile=for_standard_teeth(defaults))
    acceptance = None
    if teeth is not None:
        acceptance = dental_photo.accept_teeth_photo(teeth.image, teeth.points, INNER_LIP_RING)
        fit.measurements["teeth_photo"] = acceptance.as_dict()
    if teeth is not None and acceptance is not None and acceptance.accepted:
        # Measured whenever the photo is accepted (it has an upper arch).
        assert acceptance.upper_edge is not None
        width = _mouth_width(base_points)
        down_photo, photo_px = _down(teeth.targets)
        # The arch's end in the photo's mouth frame (origin 13, corner line
        # level, in its mouth widths); the registration is a similarity, so
        # the same frame on the registered landmarks places it on the base.
        edge = teeth.targets[UPPER_INNER] + acceptance.upper_edge * photo_px * down_photo
        seam, down, _ = neutral_seam(base_points)
        below = float((edge - seam) @ down) / width
        photo_width = photo_px / width
        fit.teeth_photo = True
        fit.measurements.update(
            teeth_edge_below_seam=round(below, 4),
            teeth_photo_width=round(photo_width, 4),
            teeth_y_as_drawn=round(below + REFERENCE_TEETH_DROP - UPPER_SEAT, 4),
            teeth_scale_as_drawn=round(photo_width, 4),
        )
        return fit
    if teeth is None or acceptance is None:
        why = why_no_teeth or _reason("no_teeth_photo", "No teeth photo of this face")
    elif acceptance.arch_pixels == 0:
        why = _reason("no_teeth_visible", "The teeth photo shows no upper teeth")
    else:
        why = _reason(
            "teeth_photo_refused",
            "The teeth photo shows too little of the upper teeth for the photographic mouth "
            f"(central crown {acceptance.crown_coverage:.3f} of the mouth width, arch "
            f"{acceptance.arch_width} px, {acceptance.arch_pixels} px of enamel; the embed "
            f"needs {dental_photo.MIN_CROWN_COVERAGE}, {dental_photo.MIN_ARCH_WIDTH} and "
            f"{dental_photo.MIN_ARCH_PIXELS})",
        )
    fit.reasons.append({"field": "teethY", **why})
    return fit


# --- 3b. The kit's own size ----------------------------------------------------------------------


@dataclass
class Amplitude:
    """The person's own shapes, at the size the kit plays them.

    `targets`: the generated shapes kept (base pixels), each moved from rest
    `scale` times as far as it was made; `refused`: the shapes that open too
    far for their sound even so, with why (retargeted instead)."""

    targets: dict[str, np.ndarray]
    refused: dict[str, dict]
    scale: float
    measurements: dict = field(default_factory=dict)
    reasons: list[dict] = field(default_factory=list)


def reference_openings(reference: ReferenceMotion) -> dict[str, float]:
    """How far each of the Reference's poses opens its lips beyond its rest
    (`opening`), in its rest mouth widths."""
    return {shape: opening(reference.poses[shape], reference.rest) for shape in SHAPES}


def normalize_amplitude(
    base_points: np.ndarray, generated: dict[str, np.ndarray], reference: ReferenceMotion
) -> Amplitude:
    """The person's own shapes at the Reference's conversational size.

    An image model acts. Asked for "ah", it opened the mouth 1.35 to 2.5
    times as far as the Reference does in speech (the first runs on real
    Gemini); how far it went is the model's choice, not the person's jaw.
    So the AA sets the kit's scale: every shape the model made is moved
    from rest the Reference's AA opening over this AA's times as far as it
    was made, which puts this AA exactly where the Reference's is and keeps
    every other shape's size relative to it. (register_answer held this AA
    to 0.6..1.4 times the Reference's, so the scale is 0.71..1.67.) Openings
    are measured from the rest's own (`opening`): lips parted in the
    portrait are not movement.

    Then each shape is held to MAX_OVER_REFERENCE times the Reference's
    opening of the same shape: a TH that opens as far as its own AA would
    play every t, d, n and k as "ah". Refused, it is retargeted with the
    reason. Without an AA of the person's there is nothing to scale by: the
    shapes stay as made (each already held to its limits in register_answer).

    The manifest is then true at the Reference's jaw range (0.85), like the
    bundled motion: the retargeted shapes are the Reference's at that size,
    and the owner's jaw slider scales every avatar alike. CPU work.
    """
    reference_open = reference_openings(reference)
    result = Amplitude(targets={}, refused={}, scale=1.0)
    aa = generated.get("aa")
    if aa is not None:
        made = opening(aa, base_points)
        if made > 1e-6:
            result.scale = reference_open["aa"] / made
        result.measurements.update(
            aa_opening=round(made, 4), reference_aa_opening=round(reference_open["aa"], 4)
        )
    else:
        result.reasons.append(
            {
                "field": "amplitude",
                **_reason("aa_not_generated", "No AA of this face to scale its shapes by"),
            }
        )
    result.measurements["amplitude"] = round(result.scale, 4)
    for shape, targets in generated.items():
        scaled = base_points + result.scale * (targets - base_points)
        opened = opening(scaled, base_points)
        limit = MAX_OVER_REFERENCE * reference_open[shape]
        if shape != "aa" and opened > limit:
            result.refused[shape] = _reason(
                "pose_not_reached",
                f"Not the {shape.upper()} shape: at the kit's size the lips parted "
                f"{opened:.2f} mouth widths, more than {limit:.2f} ({MAX_OVER_REFERENCE} times "
                "the Reference's)",
            )
            continue
        result.targets[shape] = scaled
    return result
