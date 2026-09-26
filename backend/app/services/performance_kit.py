"""The performance kit: the Reference's mouth kit, made from a person's photo.

The Reference avatar talks well because it was built from a KIT
(docs/reference-avatar-lab.md): a neutral portrait, six photographs of the
same face saying AA, EE, OO, OH, F/V and TH, each registered onto the
portrait on landmarks the mouth cannot move, a motion manifest built from
them (performance.json), and a mouth profile tuned by hand. Every other
avatar borrows that kit: the continuous mouth retargets the Reference's lip
movement onto their face by mouth width alone.

This module makes the same kit from an uploaded photo, after its owner has
confirmed the points:

1. one image edit per shape (`POSE_PROMPTS`), on the face crop AI adjust
   sends (photo_adjust.face_crop_box / crop_face), asking for that mouth and
   nothing else, and one more for the teeth photo (`TEETH`, with the recipe
   of the photo the Reference renders its teeth from);
2. each answer detected (services.landmarks), mapped back through the crop,
   registered on the eye corners and nose bridge (the Reference's ANCHORS,
   the same function scripts/build_reference_performance.py uses) onto the
   detector's own view of the base photo, and refused when the
   registration is poor or the face drifted: a picture of another shape
   than the (square) one sent, eyes or nose moved, head scaled, rotated or
   turned, skin relit, or the mouth is not in the shape that was asked
   for, or opens further than speech does. What an answer moved is then
   added to the owner's confirmed points (`register_answer`), so a
   corrected mark is never mistaken for motion;
3. the person's shapes brought to the Reference's conversational size by
   their own AA (`normalize_amplitude`: a model acts, and asked for "ah" it
   opens as it pleases), a shape that still opens too far for its sound
   refused, the teeth fitted from the teeth photo (`fit_profile`), and that
   photo handed back (`TeethSource`) only when the embed would draw it
   (services.dental_photo);
4. any shape that is missing or refused filled from the Reference's pose,
   retargeted to this face by its mouth width (`retarget_reference_pose`),
   exactly as the bundled motion plays it;
5. a per-avatar manifest in the format ContinuousMouth loads (version 2,
   character "avatar-v1:<kit id>", see `build_manifest`).

`build_kit` runs all of it with an INJECTED edit function, so the creation
finish job and the Mouth panel's job (services.mouth_kit) pass
imagegen.edit_image, guarded, and tests pass fakes. Nothing here stores,
meters or publishes: the caller does, from what `KitResult` reports.
`rebase_manifest` moves a stored kit onto the face's points as they are
now (re-confirmed on the same picture, or the picture cropped around the
same face), with no AI call.

Coordinates. Registration works in base-photo pixels. The manifest is in
"manifest units": the base photo levelled about its mouth (the corner line
horizontal, as the Reference's is) and scaled so that the face is exactly
as wide as the Reference's face is in its manifest. The engine uses only
displacements relative to the mouth width, so any similarity frame renders
the same; this one makes every threshold the Reference was measured with
(the 0.007 registration gate, the embed validator's ranges) mean the same
thing for every face, whatever its framing.
"""

from __future__ import annotations

import asyncio
import copy
import inspect
import io
import json
import logging
import math
import re
import uuid
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, field
from pathlib import Path

import httpx
import numpy as np
from PIL import Image

logger = logging.getLogger("liveface.performance_kit")

# --- Versions ---------------------------------------------------------------------

# The kit's own recipe: bump when prompts, checks or the fit change what a
# kit contains, so a stored kit says which recipe made it.
# 2 (2026-09-26): the teeth photo is an edit of its own; every shape's
# opening is held to the Reference's (by the AA it was scaled with); the
# retargeted shapes follow the mouth width alone.
KIT_VERSION = 2
# @2 (2026-09-26): AA, TH and F/V reworded after the first run on real
# Gemini (fictional faces): AA came back yawn-wide, TH with the tongue far
# out, F/V ambiguous.
# @3 (2026-09-26): EE asks for the "ee" of speech, and the teeth are asked
# for on their own (TEETH, mouth_photo.TEETH_PROMPT). EE used to double as
# the teeth photo, and the full crowns the embed needs from one (0.10 mouth
# widths of central crown) came with an upper lip lifted well above any
# spoken "ee", which the mouth then played on every "ih", "e" and "s".
# @4 (2026-09-26): OO and F/V reworded after the second real run (two
# fictional faces, gated by register_answer): with @3 both OOs came back a
# pressed pout (0.04 mouth widths open, a third of the Reference's; it
# reads as "mm") and both F/Vs with the lips parted over the teeth (1.3
# and 1.8 times the Reference's at the kit's size). Reworded, both F/Vs
# passed and one OO of two opened as the Reference's does (the other went
# too far and is refused, as a pout is: the Reference's then plays).
PROMPTS_VERSION = "pose-prompts@4"
# The manifest format ContinuousMouth accepts for a per-avatar kit. Version 1
# is the Reference's own (character "lab-reference-v1"), bundled with the
# embed as mouth-motion.json; version 2 adds provenance, the frame and the
# jaw range it was measured at (embed: validateMotionManifest).
MANIFEST_VERSION = 2
CHARACTER_PREFIX = "avatar-v1:"
REFERENCE_CHARACTER = "lab-reference-v1"
# The kit id in "avatar-v1:<kit id>", exactly as the embed accepts it
# (AVATAR_CHARACTER): ASCII only. str.isalnum would also let through
# letters and digits of every other script, which the embed refuses.
KIT_ID = re.compile(r"[A-Za-z0-9_-]{1,64}")

SHAPES = ("aa", "ee", "oo", "oh", "fv", "th")
# The manifest's pose order: embed PERFORMANCE_POSES.
POSES = ("rest",) + SHAPES
# The seventh request: the person's teeth, photographed for the renderer
# (their oral photo), not a mouth shape; never in the manifest.
TEETH = "teeth"

# MediaPipe indices, as rig.OUTER_LIP_RING / INNER_LIP_RING.
OUTER_LIP_RING = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291,
                  409, 270, 269, 267, 0, 37, 39, 40, 185]
INNER_LIP_RING = [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308,
                  415, 310, 311, 312, 13, 82, 81, 80, 191]
MOUTH_LEFT, MOUTH_RIGHT = 61, 291
UPPER_INNER, LOWER_INNER = 13, 14
FACE_LEFT, FACE_RIGHT = 234, 454
NOSE_TIP = 1


# --- 1. Pose prompts ---------------------------------------------------------------

# What every pose edit must keep. The Reference's brief (docs/
# reference-avatar-lab.md, "Expression edits"): the same camera, light, face
# and skin, only speech anatomy changes. Registration checks it afterwards;
# the prompt is what makes it likely.
_KEEP = (
    "Change ONLY the mouth, lips, teeth, tongue and jaw. Keep exactly the same person "
    "and identity, the same face shape, skin, skin tone, skin texture and makeup, the "
    "same eyes looking in the same direction, the same eyebrows, nose, hair and ears, "
    "the same head position, head angle and head size in the frame, the same framing, "
    "lighting, colours, background and image size. Do not beautify, smooth, sharpen, "
    "relight, restyle, zoom or crop. Photorealistic: a natural moment of relaxed "
    "speech, not a grimace or an exaggerated expression."
)

# One sentence per shape: the anatomy of that sound, as the Reference's
# poses show it. EE is the "ee" of speech, the tips of the upper teeth at
# most, as the Reference's own EE shows them; the teeth photo is asked for
# on its own (teeth_prompt).
#
# Tuned on real Gemini (gemini-3.1-flash-image, two fictional faces, twelve
# poses, all registered within the Reference's gate): asked only for a
# dropped jaw, AA opened to a yawn (0.39 and 0.63 mouth widths against the
# Reference's 0.29); asked for the tongue "between the teeth", TH pushed it
# far out; and F/V was ambiguous until the teeth were said to press on the
# lower lip. Hence the "not a yawn or a shout", "the very tip" and
# "pressing gently" below. What still comes back too open is scaled or
# refused (normalize_amplitude, POSE_LIMITS).
POSE_PROMPTS: dict[str, str] = {
    "aa": (
        'saying the open vowel "ah" as in "father": the mouth moderately open, as in '
        "normal conversation, not a yawn or a shout, the opening about a third as tall "
        "as the mouth is wide, the lips relaxed, the tips of the upper front teeth just "
        "visible, the tongue resting low and flat"
    ),
    "ee": (
        'saying "ee" as in "see", in relaxed speech: the lips drawn wide, the mouth '
        "only slightly open, at most the biting edges of the upper front teeth showing"
    ),
    "oo": (
        'saying "oo" as in "you", in normal conversation: the lips rounded and pushed a '
        "little forward around a clearly open, round hole, not a kiss, a whistle or a pout, "
        "the corners of the mouth drawn in and no teeth showing"
    ),
    "oh": (
        'saying "oh" as in "go": the lips rounded into an open oval, taller than it is '
        'wide, the jaw lowered, less pushed forward than for "oo"'
    ),
    "fv": (
        'saying "f" as in "five": the lower lip drawn up and tucked lightly under the upper '
        "front teeth, which rest on it; the mouth otherwise closed, only the biting edges of "
        "the upper front teeth showing"
    ),
    "th": (
        'saying "th" as in "think": only the very tip of the tongue, barely visible '
        "between the front teeth, the mouth slightly open"
    ),
}


def pose_prompt(shape: str) -> str:
    """The whole edit prompt for one shape (PROMPTS_VERSION)."""
    return (
        "Edit this close-up portrait photograph so that the same person is "
        f"{POSE_PROMPTS[shape]}. {_KEEP}"
    )


def teeth_prompt() -> str:
    """The teeth photo's edit: services.mouth_photo.TEETH_PROMPT, the
    recipe of the photo the Reference renders its teeth from
    (oral-detail-v3): the whole upper crowns from the gum to the edge in one
    arch, a dark gap between the rows, even light, nothing else changed.
    What the embed needs of a teeth photo is not a shape of speech, so it
    is asked for apart from the six."""
    from app.services.mouth_photo import TEETH_PROMPT

    return TEETH_PROMPT


def request_prompt(shape: str) -> str:
    """The prompt sent for `shape`: one of SHAPES, or TEETH."""
    return teeth_prompt() if shape == TEETH else pose_prompt(shape)


# --- 2a. Registration, shared with scripts/build_reference_performance.py ------------

# Stable eye corners and nose bridge. The mouth and chin cannot bias the
# registration, because they are what each pose changes.
ANCHORS = [33, 133, 362, 263, 168, 6, 197, 195]
# RMS of the anchors after registration, in manifest units. The Reference's
# gate: its six poses registered between 0.0004 and 0.0019.
MAX_REGISTRATION_RMS = 0.007


class MirroredPose(ValueError):
    """The best rotation onto the anchors is a reflection: not the same face."""


@dataclass(frozen=True)
class Similarity:
    """A least-squares similarity onto anchors: rotation, scale, and the two
    centroids it maps between. Row vectors: p' = (p - source_centre) @
    rotation * scale + target_centre."""

    rotation: np.ndarray
    scale: float
    source_centre: np.ndarray
    target_centre: np.ndarray

    @property
    def degrees(self) -> float:
        return math.degrees(math.atan2(self.rotation[0, 1], self.rotation[0, 0]))

    def apply(self, points: np.ndarray) -> np.ndarray:
        # Exactly the Reference builder's arithmetic, in the same order: the
        # Reference manifest is rebuilt byte for byte from this.
        return (points - self.source_centre) @ self.rotation * self.scale + self.target_centre


def similarity_on_anchors(
    source: np.ndarray, target: np.ndarray, anchors: Sequence[int] = ANCHORS
) -> Similarity:
    """Least-squares similarity from `source` onto `target` over `anchors`,
    including rotation but never shear. Raises MirroredPose on a reflection."""
    a, b = source[anchors], target[anchors]
    ac, bc = a.mean(axis=0), b.mean(axis=0)
    u, singular, vt = np.linalg.svd((a - ac).T @ (b - bc))
    rotation = u @ vt
    if np.linalg.det(rotation) < 0:
        raise MirroredPose("Mirrored reference pose")
    scale = singular.sum() / np.square(a - ac).sum()
    return Similarity(rotation, float(scale), ac, bc)


def register(source: np.ndarray, target: np.ndarray, anchors: Sequence[int] = ANCHORS) -> np.ndarray:
    """Every point of `source`, carried onto `target` by the anchors' similarity."""
    return similarity_on_anchors(source, target, anchors).apply(source)


def registration_rms(
    registered: np.ndarray, target: np.ndarray, anchors: Sequence[int] = ANCHORS
) -> float:
    return float(np.sqrt(np.square(registered[anchors] - target[anchors]).mean()))


def mouth_frame(base: np.ndarray, outer: Sequence[int]) -> tuple[float, float, float]:
    """(mouth width, centre x, centre y) as the manifest records them: the
    outer ring's horizontal extent, its middle, and its mean height."""
    width = float(np.ptp(base[outer, 0]))
    cx = float((base[outer, 0].max() + base[outer, 0].min()) / 2)
    cy = float(base[outer, 1].mean())
    return width, cx, cy


def shared_triangles(
    pose_points: Sequence, base: np.ndarray, center: tuple[float, float], width: float
) -> list[list[int]]:
    """One topology for every pose: Delaunay of the mean pose (the neutral
    one has extremely thin mouth triangles), kept to the lips and the cheek
    and chin next to them."""
    from scipy.spatial import Delaunay

    cx, cy = center
    mean = np.mean(pose_points, axis=0)
    triangles = Delaunay(mean).simplices
    local = ((base[:, 0] - cx) / (width * 1.12)) ** 2 + ((base[:, 1] - cy) / (width * 1.02)) ** 2
    return [t.tolist() for t in triangles if np.min(local[t]) < 1.6]


# --- The Reference ----------------------------------------------------------------------


@dataclass(frozen=True)
class ReferenceMotion:
    """The Reference's manifest, as the retarget and the fit read it."""

    rest: np.ndarray
    poses: dict[str, np.ndarray]

    @property
    def face_width(self) -> float:
        return float(np.linalg.norm(self.rest[FACE_RIGHT] - self.rest[FACE_LEFT]))

    @property
    def corner_mid(self) -> np.ndarray:
        return (self.rest[MOUTH_LEFT] + self.rest[MOUTH_RIGHT]) / 2

    @classmethod
    def from_manifest(cls, manifest: dict) -> ReferenceMotion:
        if manifest.get("version") != 1 or manifest.get("character") != REFERENCE_CHARACTER:
            raise ValueError("not the Reference's motion manifest")
        poses = {p["id"]: np.asarray(p["points"], dtype=np.float64) for p in manifest["poses"]}
        if tuple(poses) != POSES or any(p.shape != (478, 2) for p in poses.values()):
            raise ValueError("the Reference manifest is incomplete")
        return cls(rest=poses["rest"], poses={s: poses[s] for s in SHAPES})


def _reference_paths() -> list[Path]:
    # Development: the embed's bundled copy. The API image: the built widget
    # directory, where /mouth-motion.json is served from (see app.main).
    root = Path(__file__).resolve().parents[3]
    return [root / "embed" / "assets" / "mouth-motion.json",
            root / "embed" / "dist" / "mouth-motion.json"]


def load_reference(path: Path | None = None) -> ReferenceMotion:
    """The bundled Reference motion (mouth-motion.json)."""
    for candidate in [path] if path else _reference_paths():
        if candidate.exists():
            return ReferenceMotion.from_manifest(json.loads(candidate.read_text()))
    raise FileNotFoundError("mouth-motion.json not found")


# --- Frame ---------------------------------------------------------------------------------


def _level(theta: float) -> np.ndarray:
    """R(-theta) for column vectors: turns a line at `theta` horizontal."""
    c, s = math.cos(theta), math.sin(theta)
    return np.array([[c, s], [-s, c]])


def _corner_angle(points: np.ndarray) -> float:
    d = points[MOUTH_RIGHT] - points[MOUTH_LEFT]
    return math.atan2(float(d[1]), float(d[0]))


@dataclass(frozen=True)
class ManifestFrame:
    """Base-photo pixels to manifest units (see the module docstring)."""

    matrix: np.ndarray  # 2x3
    image_size: tuple[int, int]

    @property
    def units_per_px(self) -> float:
        return math.sqrt(abs(float(np.linalg.det(self.matrix[:, :2]))))

    def apply(self, points: np.ndarray) -> np.ndarray:
        return np.asarray(points, dtype=np.float64) @ self.matrix[:, :2].T + self.matrix[:, 2]

    @classmethod
    def from_base(
        cls, base_points: np.ndarray, image_size: tuple[int, int], reference: ReferenceMotion
    ) -> ManifestFrame:
        face = float(np.linalg.norm(base_points[FACE_RIGHT] - base_points[FACE_LEFT]))
        if face <= 0:
            raise ValueError("the base face has no width")
        linear = reference.face_width / face * _level(_corner_angle(base_points))
        middle = (base_points[MOUTH_LEFT] + base_points[MOUTH_RIGHT]) / 2
        offset = reference.corner_mid - linear @ middle
        return cls(np.hstack((linear, offset[:, None])), (int(image_size[0]), int(image_size[1])))


# --- 1b. Request preparation ---------------------------------------------------------------

FACE_CROP = "face_crop"
HEAD_CROP = "head_crop"


@dataclass(frozen=True)
class PoseRequest:
    """One edit to send, and where its picture came from in the base photo."""

    shape: str  # one of SHAPES, or TEETH
    kind: str  # FACE_CROP, or HEAD_CROP after a refusal
    prompt: str
    payload: bytes
    mime: str
    # The rectangle of the base photo the payload shows, in base pixels:
    # a square for either kind (it may reach past the photo's edge).
    box: tuple[float, float, float, float]

    @property
    def aspect(self) -> float:
        """Width over height of what was sent (1 for both crops)."""
        x0, y0, x1, y1 = self.box
        return (x1 - x0) / (y1 - y0)

    def to_base(self, answer_size: tuple[int, int]) -> np.ndarray:
        """2x3 matrix from answer pixels to base pixels, assuming the answer
        shows the same rectangle (the registration corrects what it does not).
        An answer of another shape never gets here (register_answer refuses
        it, aspect_changed), so both axes get the same scale."""
        x0, y0, x1, y1 = self.box
        width, height = answer_size
        return np.array([[(x1 - x0) / width, 0.0, x0], [0.0, (y1 - y0) / height, y0]])


@dataclass(frozen=True)
class _Crop:
    kind: str
    payload: bytes
    box: tuple[float, float, float, float]


def _base_image(base_png: bytes) -> Image.Image:
    """What the model and the detector are shown: a cut-out on the neutral
    grey (photo_adjust's own decoding, so a kit sees what AI adjust sees)."""
    from app.services import photo_adjust

    return photo_adjust._rgb(base_png)


def head_square(
    image_size: tuple[int, int], points: np.ndarray
) -> tuple[float, float, float] | None:
    """(x0, y0, side): AI adjust's head-and-shoulders crop
    (photo_adjust.head_crop_box, clipped to the photo) padded to a square
    about its centre, reaching past the photo's edge where it must (filled
    with the photo's own edge, as the face crop is). None when that crop is
    the whole photo: the same picture again would be the same request.

    Square, like the face crop, because the head box itself is 6:7 (5:6 or
    so once clipped), a shape the model does not answer in: a model that
    keeps the head's proportions and reframes to its own aspect, rather
    than stretching, would map back with a different scale per axis
    (PoseRequest.to_base) and put the mouth 0.1-0.2 mouth widths off while
    passing every guard. A square is answered as a square, and an answer
    that is not is refused (register_answer, aspect_changed)."""
    from app.services import photo_adjust

    x0, y0, x1, y1 = (float(int(round(v))) for v in photo_adjust.head_crop_box(image_size, points))
    if (x0, y0, x1, y1) == (0.0, 0.0, float(image_size[0]), float(image_size[1])):
        return None
    width, height = x1 - x0, y1 - y0
    side = max(width, height)
    return x0 - (side - width) / 2, y0 - (side - height) / 2, side


def _crop(image: Image.Image, points: np.ndarray, kind: str) -> _Crop | None:
    """The picture sent for `kind`, reusing AI adjust's crops, both square.
    None when the head crop would be the whole photo (head_square)."""
    from app.services import imagegen, photo_adjust

    if kind == FACE_CROP:
        x0, y0, side = photo_adjust.face_crop_box(points)
        payload = photo_adjust._jpeg(photo_adjust.crop_face(image, (x0, y0, side)),
                                     photo_adjust.CROP_QUALITY)
        return _Crop(kind, payload, (x0, y0, x0 + side, y0 + side))
    square = head_square(image.size, points)
    if square is None:
        return None
    x0, y0, side = square
    # At the photo's own resolution, as before it was squared: never
    # enlarged, at most the edge a source is sent at.
    edge = min(int(round(side)), photo_adjust.SOURCE_MAX_EDGE)
    crop = photo_adjust.crop_face(image, square, size=edge)
    return _Crop(kind, photo_adjust._jpeg(crop, imagegen.SOURCE_QUALITY),
                 (x0, y0, x0 + side, y0 + side))


def prepare_pose_request(
    base_png: bytes, base_points: np.ndarray, shape: str, kind: str = FACE_CROP
) -> PoseRequest | None:
    """The edit for one shape (or the teeth photo, TEETH): the face crop
    (the same kind AI adjust's touch-up sends, 1.6 face boxes at 1024 px),
    or after a refusal the head-and-shoulders crop, squared (head_square).
    None only for a head crop that would be the whole photo. CPU work."""
    if shape not in POSE_PROMPTS and shape != TEETH:
        raise ValueError(f"unknown shape {shape!r}")
    crop = _crop(_base_image(base_png), _checked_points(base_points), kind)
    return None if crop is None else _request(shape, crop)


def _request(shape: str, crop: _Crop) -> PoseRequest:
    return PoseRequest(shape, crop.kind, request_prompt(shape), crop.payload, "image/jpeg",
                       crop.box)


def _checked_points(points) -> np.ndarray:
    array = np.asarray(points, dtype=np.float64)
    if array.shape != (478, 2) or not np.isfinite(array).all():
        raise ValueError("base_points must be 478 finite (x, y) pixel positions")
    return array


# --- 2b. Registering an answer ----------------------------------------------------------------

# Drift guards, measured on the Reference's six poses (registered, as a
# fraction of the face width, 234 to 454) and set with a wide margin:
#   head scale 0.997-1.016 and rotation under 0.4 degrees before registration;
#   nose (tip and bridge) at most 0.019 face widths; eye outlines 0.007 on
#   average; the nose tip's offset between the cheeks changed by 0.013;
#   cheek colour delta E (lightness at half weight) 0.2 to 2.9.
MAX_SCALE_CHANGE = 0.10
MAX_ROTATION_DEGREES = 4.0
NOSE_GUARD = [1, 4, 5, 6, 168, 195, 197, 45, 275]
MAX_NOSE_SHIFT = 0.03
EYE_GUARD = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246,
             362, 382, 381, 380, 374, 373, 390, 249, 263, 466, 388, 387, 386, 385, 384, 398]
MAX_EYE_SHIFT = 0.015
MAX_YAW_CHANGE = 0.08
# Tighter than a regenerate's 12: a pose asks for no relighting at all.
MAX_POSE_SKIN_DELTA_E = 8.0
# An answer whose width over height differs from what was sent by more
# than this was reframed, not edited (see head_square). JPEG and the
# model's own sizes round a square to within a pixel or two of 1024.
MAX_ASPECT_CHANGE = 0.01

# Did the answer make the shape it was asked for, and no more than speech
# does? Its OPENING (the lip gap, 13 to 14, less the rest's own: lips
# parted at rest are the portrait, not the shape's movement) and its
# corner-to-corner width, in rest mouth widths, after registration.
#
# The Reference's own openings (tests: equal to the bundled motion's); its
# widths: EE 1.05, OO 0.52, OH 0.73.
REFERENCE_OPENINGS: dict[str, float] = {
    "aa": 0.290, "ee": 0.165, "oo": 0.122, "oh": 0.308, "fv": 0.096, "th": 0.203,
}
# How much further than the Reference's a shape may open AT THE KIT'S SIZE,
# once normalize_amplitude has put this face's AA where the Reference's is.
# The first run on real Gemini (@1 prompts) came back 1.6 to 2.0 times the
# Reference's for TH, F/V and EE (and AA at 2.2 to 2.5); played, an
# over-open TH opens every t, d, n and k as wide as "ah" (the continuous
# mouth plays TH for them), and an over-open EE every "ih", "e" and "s".
# The second (@3 prompts, 2026-09-26) came back 0.7 to 1.45 times raw and
# 0.6 to 1.31 at the kit's size: its F/V at 1.31 shows a millimetre more
# tooth than the Reference's, not an "ah", and was refused at 1.3.
MAX_OVER_REFERENCE = 1.4
# Before that size is known an answer is held only to what no speech sound
# reaches, twice the Reference's own opening of the shape: the model acts
# every shape alike (that run's AA, OH and F/V all came back about a tenth
# too open), so a shape is judged against the Reference's at the kit's
# size, not as the model drew it. The AA, which sets the size, is held to
# MAX_OVER_REFERENCE as drawn.
RAW_MAX_OVER_REFERENCE = 2.0
# The AA sets the kit's scale (normalize_amplitude): one opening less than
# this much of the Reference's would be scaled up with every other shape
# more than 1.7 times; one that little is not an "ah" anyway.
MIN_AA_OF_REFERENCE = 0.6
# The least a shape must open, or be as wide: enough to refuse a closed
# mouth, never enough to force the Reference's exact look on another face.
_FLOORS: dict[str, dict[str, float]] = {
    "aa": {"min_opening": round(MIN_AA_OF_REFERENCE * REFERENCE_OPENINGS["aa"], 3)},
    # An "ee" spreads the lips from a neutral mouth (the Reference's to 1.05
    # of its rest); a portrait that already smiles has little spread left:
    # the second real run's relaxed "ee" came back 0.96 of a smiling rest.
    # 0.94 still refuses a rounded mouth (an OH is at most 0.92, an OO 0.85).
    "ee": {"min_opening": 0.05, "min_width": 0.94},
    # An "oo" rounds the lips around a small opening. The second real run's
    # came back with a third of the Reference's (0.041): rendered on the
    # engine, a pressed pout that reads as "mm". Half the Reference's is the
    # least that still reads as a rounded vowel.
    "oo": {"min_opening": 0.06, "max_width": 0.85},
    "oh": {"min_opening": 0.12, "max_width": 0.92},
    "fv": {},
    "th": {"min_opening": 0.05},
}
def _raw_limit(shape: str) -> float:
    """How many times the Reference's opening an answer may open as drawn."""
    return MAX_OVER_REFERENCE if shape == "aa" else RAW_MAX_OVER_REFERENCE


POSE_LIMITS: dict[str, dict[str, float]] = {
    shape: {**floors, "max_opening": round(_raw_limit(shape) * REFERENCE_OPENINGS[shape], 3)}
    for shape, floors in _FLOORS.items()
}
# The least lip gap, in its own mouth widths, of an answer to the teeth
# request: the mouth-photo upload's own threshold (portrait_photo
# .prepare_photo). It must then also pass the embed's own test
# (fit_profile, dental_photo).
TEETH_PHOTO_MIN_GAP = 0.08

Detector = Callable[[Image.Image], "np.ndarray | None"]


@dataclass
class PoseRegistration:
    """One answer, registered onto the base photo, or why it was refused."""

    shape: str
    targets: np.ndarray | None = None  # (478, 2) base pixels
    rms: float | None = None  # manifest units
    reason: dict | None = None
    checks: dict = field(default_factory=dict)
    answer_points: np.ndarray | None = None  # (478, 2) answer pixels
    answer_size: tuple[int, int] | None = None
    answer_image: Image.Image | None = None

    @property
    def ok(self) -> bool:
        return self.reason is None and self.targets is not None


def _reason(code: str, detail: str) -> dict:
    return {"code": code, "detail": detail}


def _mouth_width(points: np.ndarray) -> float:
    """Corner to corner (61 to 291)."""
    return float(np.linalg.norm(points[MOUTH_RIGHT] - points[MOUTH_LEFT]))


def _gap_and_width(points: np.ndarray, rest_width: float) -> tuple[float, float]:
    gap = float(np.linalg.norm(points[UPPER_INNER] - points[LOWER_INNER])) / rest_width
    return gap, _mouth_width(points) / rest_width


def opening(points: np.ndarray, rest: np.ndarray) -> float:
    """How far `points` open the lips beyond `rest`: how much further apart
    the middles of the inner lips (13, 14) are, down the face (across the
    rest's corner line), in rest mouth widths. A portrait with its lips
    parted opens only by what the shape adds to that; and it is linear in
    the movement, so a shape moved twice as far opens twice as much (the
    scale normalize_amplitude finds is then exact)."""
    down, width = _down(rest)
    moved = (points[LOWER_INNER] - points[UPPER_INNER]) - (rest[LOWER_INNER] - rest[UPPER_INNER])
    return float(moved @ down) / width


def signed_yaw(points: np.ndarray) -> float:
    """Where the nose tip is between the cheeks (234, 454), signed: 0
    frontal, +1 at the image-right cheek, -1 at the left. photo_adjust's
    yaw_offset is its absolute value, which cannot tell a head turned a
    little one way from the same turn the other way: compared unsigned, a
    base at +0.05 and an answer at -0.05 are "unchanged"."""
    left, right = points[FACE_LEFT][0], points[FACE_RIGHT][0]
    half = abs(right - left) / 2
    if half <= 0:
        return 1.0
    return float((points[NOSE_TIP][0] - (left + right) / 2) / half)


def _shape_reached(shape: str, opened: float, width: float) -> str | None:
    limits = POSE_LIMITS[shape]
    if opened < limits.get("min_opening", -math.inf):
        return f"the lips parted {opened:.2f} mouth widths, less than {limits['min_opening']}"
    if opened > limits["max_opening"]:
        return (f"the lips parted {opened:.2f} mouth widths, more than {limits['max_opening']} "
                f"({_raw_limit(shape)} times the Reference's)")
    if width < limits.get("min_width", -math.inf):
        return f"the mouth is {width:.2f} of its rest width, narrower than {limits['min_width']}"
    if width > limits.get("max_width", math.inf):
        return f"the mouth is {width:.2f} of its rest width, wider than {limits['max_width']}"
    return None


def _teeth_shown(points: np.ndarray) -> str | None:
    """Can a teeth photo's lips show the teeth at all? Its own lip gap, in
    its own mouth widths, at least the mouth-photo upload's threshold
    (portrait_photo.prepare_photo); the embed's own test decides the rest
    (fit_profile)."""
    width = max(_mouth_width(points), 1.0)
    gap = float(np.linalg.norm(points[UPPER_INNER] - points[LOWER_INNER])) / width
    if gap < TEETH_PHOTO_MIN_GAP:
        return (f"the lips parted {gap:.2f} of their mouth width, too little to show the teeth "
                f"(at least {TEETH_PHOTO_MIN_GAP})")
    return None


def register_answer(
    answer: bytes,
    request: PoseRequest,
    base_image: Image.Image,
    base_points: np.ndarray,
    frame: ManifestFrame,
    detect: Detector,
    base_detected: np.ndarray | None = None,
) -> PoseRegistration:
    """Detect the pose in `answer`, carry it onto the base photo and check it.

    The answer's landmarks go back through the crop (request.to_base), then
    onto the base's anchors by `similarity_on_anchors`: the model may have
    zoomed or shifted the head a little, and the anchors are what a pose
    must not move. Returns per-landmark targets in base pixels, or the
    first reason the answer cannot be used. CPU work.

    `base_points` are the owner's CONFIRMED points (the rig), which may
    differ from what the detector sees wherever the owner corrected a mark,
    and four of the eight anchors are eye corners the owner may well have
    moved. So the answer is compared with `base_detected`, the same
    detector's view of the base photo: detector against detector, every
    guard and the registration measure only what the model changed. The
    targets are the confirmed points plus that change, which is exactly
    the registered answer when nothing was corrected. Without a detection
    of the base (none found) the confirmed points stand in for it.
    """
    from app.services import photo_adjust

    base_view = base_points if base_detected is None else base_detected
    result = PoseRegistration(request.shape)
    try:
        with Image.open(io.BytesIO(answer)) as decoded:
            image = decoded.convert("RGB")
    except Exception:
        result.reason = _reason("unreadable_result", "The AI returned no usable image")
        return result
    aspect = image.width / image.height
    result.checks["aspect"] = round(aspect / request.aspect, 4)
    if abs(aspect / request.aspect - 1) > MAX_ASPECT_CHANGE:
        # Mapped back per axis, a reframed answer would pass the guards with
        # its mouth in the wrong place (head_square).
        result.reason = _reason(
            "aspect_changed", "The AI answered with a picture of another shape than it was sent"
        )
        return result
    points = detect(image)
    if points is None:
        result.reason = _reason("no_face_in_result", "No face was found in the answer")
        return result
    points = np.asarray(points, dtype=np.float64)
    if points.shape != (478, 2) or not np.isfinite(points).all():
        result.reason = _reason("no_face_in_result", "The answer's face was not fully found")
        return result
    result.answer_points, result.answer_size, result.answer_image = points, image.size, image

    to_base = request.to_base(image.size)
    mapped = points @ to_base[:, :2].T + to_base[:, 2]
    try:
        similarity = similarity_on_anchors(mapped, base_view)
    except MirroredPose:
        result.reason = _reason("mirrored", "The answer is a mirror image of the face")
        return result
    checks = result.checks
    checks["scale"] = round(similarity.scale, 4)
    checks["rotation"] = round(similarity.degrees, 2)
    if abs(similarity.scale - 1) > MAX_SCALE_CHANGE or abs(similarity.degrees) > MAX_ROTATION_DEGREES:
        result.reason = _reason("head_moved", "The AI zoomed or tilted the head")
        return result

    registered = similarity.apply(mapped)
    rms = registration_rms(registered, base_view) * frame.units_per_px
    checks["rms"] = round(rms, 6)
    if rms > MAX_REGISTRATION_RMS:
        result.reason = _reason(
            "registration", f"The eyes and nose do not line up (RMS {rms:.4f} > {MAX_REGISTRATION_RMS})"
        )
        return result

    face = float(np.linalg.norm(base_view[FACE_RIGHT] - base_view[FACE_LEFT]))
    nose = float(np.linalg.norm(registered[NOSE_GUARD] - base_view[NOSE_GUARD], axis=1).max()) / face
    eyes = float(np.linalg.norm(registered[EYE_GUARD] - base_view[EYE_GUARD], axis=1).mean()) / face
    yaw = abs(signed_yaw(points) - signed_yaw(base_view))
    checks.update(nose=round(nose, 4), eyes=round(eyes, 4), yaw=round(yaw, 4))
    if nose > MAX_NOSE_SHIFT:
        result.reason = _reason("nose_moved", "The AI moved or reshaped the nose")
        return result
    if eyes > MAX_EYE_SHIFT:
        result.reason = _reason("eyes_moved", "The AI moved or reshaped the eyes")
        return result
    if yaw > MAX_YAW_CHANGE:
        result.reason = _reason("head_turned", "The AI turned the head")
        return result

    drift = photo_adjust.skin_drift(base_image, base_view, image, points)
    if drift is not None:
        checks["skin_delta_e"] = round(drift, 2)
        if drift > MAX_POSE_SKIN_DELTA_E:
            result.reason = _reason("skin_tone_changed", "The AI changed the skin tone or light")
            return result

    rest_width = _mouth_width(base_view)
    gap, width = _gap_and_width(registered, rest_width)
    opened = opening(registered, base_view)
    checks.update(gap=round(gap, 3), opening=round(opened, 3), width=round(width, 3))
    if request.shape == TEETH:
        # Not a shape of speech: how far it opens is not played, only
        # whether its lips show the teeth.
        missed = _teeth_shown(points)
        if missed:
            result.reason = _reason("pose_not_reached", f"Not a teeth photo: {missed}")
            return result
    else:
        missed = _shape_reached(request.shape, opened, width)
        if missed:
            result.reason = _reason("pose_not_reached",
                                    f"Not the {request.shape.upper()} shape: {missed}")
            return result
    # What the model moved, applied to the confirmed points.
    result.targets, result.rms = base_points + (registered - base_view), rms
    return result


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
    from annotated_types import Ge, Le

    from app.schemas.avatar import MouthProfile

    limits = {}
    for name, info in MouthProfile.model_fields.items():
        low = next(m.ge for m in info.metadata if isinstance(m, Ge))
        high = next(m.le for m in info.metadata if isinstance(m, Le))
        limits[name] = (float(low), float(high))
    return MouthProfile().model_dump(), limits


def _down(points: np.ndarray) -> tuple[np.ndarray, float]:
    """The unit vector down the face, perpendicular to the corner line, and
    the corner-to-corner width."""
    d = points[MOUTH_RIGHT] - points[MOUTH_LEFT]
    width = float(np.linalg.norm(d))
    ux = d / width
    return np.array([-ux[1], ux[0]]), width


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
        return {"profile": self.profile, "measurements": self.measurements, "reasons": self.reasons,
                "teeth_photo": self.teeth_photo}


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
    from app.services import dental_photo

    defaults, _ = _profile_defaults()
    fit = ProfileFit(profile=for_standard_teeth(defaults))
    acceptance = None
    if teeth is not None:
        acceptance = dental_photo.accept_teeth_photo(teeth.image, teeth.points, INNER_LIP_RING)
        fit.measurements["teeth_photo"] = acceptance.as_dict()
    if acceptance is not None and acceptance.accepted:
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
    if teeth is None:
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
        result.measurements.update(aa_opening=round(made, 4),
                                   reference_aa_opening=round(reference_open["aa"], 4))
    else:
        result.reasons.append({"field": "amplitude", **_reason(
            "aa_not_generated", "No AA of this face to scale its shapes by")})
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


# --- 5. Manifest ----------------------------------------------------------------------------------

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
    size = tuple(int(v) for v in (image_size or manifest["frame"]["image_size"]))
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


# --- 6. The orchestrator ------------------------------------------------------------------------------


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


EditImage = Callable[[str, bytes, str], Awaitable[object]]
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
    generated = {shape: registrations[shape].targets for shape in SHAPES
                 if shape in registrations and registrations[shape].ok}
    amplitude = normalize_amplitude(base_points, generated, reference)
    # The teeth that will be drawn: the teeth photo when the embed would
    # draw it, the standard teeth otherwise (and why), either seated and
    # sized as the Reference's.
    answer = registrations.get(TEETH)
    photo = None
    if answer is not None and answer.ok:
        photo = TeethPhoto(answer.answer_image, answer.answer_points, answer.targets)
    fit = fit_profile(base_points, photo, why_no_teeth)
    fit.measurements.update(amplitude.measurements)
    fit.reasons.extend(amplitude.reasons)
    teeth = _teeth_source(answer) if fit.teeth_photo else None
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
        if fraction is None:
            fraction = 0.95 * done / len(asked)
        outcome = on_progress(fraction, message, done, len(asked))
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
