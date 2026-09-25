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
   nothing else;
2. each answer detected (services.landmarks), mapped back through the crop,
   registered on the eye corners and nose bridge (the Reference's ANCHORS,
   the same function scripts/build_reference_performance.py uses) onto the
   detector's own view of the base photo, and refused when the
   registration is poor or the face drifted: a picture of another shape
   than the (square) one sent, eyes or nose moved, head scaled, rotated or
   turned, skin relit, or the mouth is not in the shape that was asked
   for. What an answer moved is then added to the owner's confirmed points
   (`register_answer`), so a corrected mark is never mistaken for motion;
3. the mouth profile fitted from the EE and AA shapes (`fit_profile`), and
   the EE answer handed back as the teeth photo (`TeethSource`) only when
   the embed would draw it (services.dental_photo);
4. any shape that is missing or refused filled from the Reference's pose,
   retargeted to this face at the fitted jaw range
   (`retarget_reference_pose`);
5. a per-avatar manifest in the format ContinuousMouth loads (version 2,
   character "avatar-v1:<kit id>", see `build_manifest`).

`build_kit` runs all of it with an INJECTED edit function, so the creation
finish job and the Mouth panel's job (services.mouth_kit) pass
imagegen.edit_image, guarded, and tests pass fakes. Nothing here stores,
meters or publishes: the caller does, from what `KitResult` reports.
`rebase_manifest` moves a stored kit onto points the owner re-confirmed on
the same picture, with no AI call.

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
KIT_VERSION = 1
# @2 (2026-09-26): AA, TH and F/V reworded after the first run on real
# Gemini (fictional faces): AA came back yawn-wide, TH with the tongue far
# out, F/V ambiguous.
PROMPTS_VERSION = "pose-prompts@2"
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

# MediaPipe indices, as rig.OUTER_LIP_RING / INNER_LIP_RING.
OUTER_LIP_RING = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291,
                  409, 270, 269, 267, 0, 37, 39, 40, 185]
INNER_LIP_RING = [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308,
                  415, 310, 311, 312, 13, 82, 81, 80, 191]
MOUTH_LEFT, MOUTH_RIGHT = 61, 291
UPPER_INNER, LOWER_INNER = 13, 14
UPPER_OUTER, LOWER_OUTER = 0, 17
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
# poses show it. EE also serves as the person's teeth photo (the continuous
# mouth's oral texture), so it asks for the upper teeth in full.
#
# Tuned on real Gemini (gemini-3.1-flash-image, two fictional faces, twelve
# poses, all registered within the Reference's gate): asked only for a
# dropped jaw, AA opened to a yawn (0.39 and 0.63 mouth widths against the
# Reference's 0.29); asked for the tongue "between the teeth", TH pushed it
# far out; and F/V was ambiguous until the teeth were said to press on the
# lower lip. Hence the "not a yawn or a shout", "the very tip" and
# "pressing gently" below.
POSE_PROMPTS: dict[str, str] = {
    "aa": (
        'saying the open vowel "ah" as in "father": the mouth moderately open, as in '
        "normal conversation, not a yawn or a shout, the opening about a third as tall "
        "as the mouth is wide, the lips relaxed, the tips of the upper front teeth just "
        "visible, the tongue resting low and flat"
    ),
    "ee": (
        'saying "ee" as in "see": the lips drawn wide in a broad, smile-like spread, '
        "the mouth slightly open, the UPPER FRONT TEETH CLEARLY VISIBLE from the gum "
        "line to their biting edges, with a thin dark gap between the upper and lower "
        "teeth"
    ),
    "oo": (
        'saying "oo" as in "food": the lips rounded and pushed forward into a small, '
        "round opening, the corners of the mouth drawn in, a small dark opening in the "
        "centre and no teeth showing"
    ),
    "oh": (
        'saying "oh" as in "go": the lips rounded into an open oval, taller than it is '
        'wide, the jaw lowered, less pushed forward than for "oo"'
    ),
    "fv": (
        'saying "f" as in "five": the upper front teeth pressing gently on the lower '
        "lip; the lips otherwise relaxed"
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

    shape: str
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
    """The edit for one shape: the face crop (the same kind AI adjust's
    touch-up sends, 1.6 face boxes at 1024 px), or after a refusal the
    head-and-shoulders crop, squared (head_square). None only for a head
    crop that would be the whole photo. CPU work."""
    if shape not in POSE_PROMPTS:
        raise ValueError(f"unknown shape {shape!r}")
    crop = _crop(_base_image(base_png), _checked_points(base_points), kind)
    return None if crop is None else _request(shape, crop)


def _request(shape: str, crop: _Crop) -> PoseRequest:
    return PoseRequest(shape, crop.kind, pose_prompt(shape), crop.payload, "image/jpeg", crop.box)


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

# Did the answer make the shape it was asked for? Lip gap (13 to 14) and
# corner-to-corner width, in rest mouth widths, after registration. The
# Reference's poses: AA gap 0.29; EE gap 0.16, width 1.05; OO width 0.52;
# OH gap 0.31, width 0.73; F/V gap 0.10; TH gap 0.20. Half-way limits:
# enough to refuse a closed mouth for AA, not enough to force the
# Reference's exact look on another face.
POSE_LIMITS: dict[str, dict[str, float]] = {
    "aa": {"min_gap": 0.12},
    "ee": {"min_gap": 0.05, "min_width": 0.98},
    "oo": {"max_width": 0.85},
    "oh": {"min_gap": 0.12, "max_width": 0.92},
    "fv": {"max_gap": 0.25},
    "th": {"min_gap": 0.05},
}
MAX_GAP = 0.6

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


def _gap_and_width(points: np.ndarray, rest_width: float) -> tuple[float, float]:
    gap = float(np.linalg.norm(points[UPPER_INNER] - points[LOWER_INNER])) / rest_width
    width = float(np.linalg.norm(points[MOUTH_RIGHT] - points[MOUTH_LEFT])) / rest_width
    return gap, width


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


def _shape_reached(shape: str, gap: float, width: float) -> str | None:
    limits = POSE_LIMITS[shape]
    if gap > MAX_GAP:
        return f"the mouth opened {gap:.2f} mouth widths, more than any speech sound"
    if gap < limits.get("min_gap", -1.0):
        return f"the lips parted {gap:.2f} mouth widths, less than {limits['min_gap']}"
    if gap > limits.get("max_gap", math.inf):
        return f"the lips parted {gap:.2f} mouth widths, more than {limits['max_gap']}"
    if width < limits.get("min_width", -1.0):
        return f"the mouth is {width:.2f} of its rest width, narrower than {limits['min_width']}"
    if width > limits.get("max_width", math.inf):
        return f"the mouth is {width:.2f} of its rest width, wider than {limits['max_width']}"
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

    rest_width = float(np.linalg.norm(base_view[MOUTH_RIGHT] - base_view[MOUTH_LEFT]))
    gap, width = _gap_and_width(registered, rest_width)
    checks.update(gap=round(gap, 3), width=round(width, 3))
    missed = _shape_reached(request.shape, gap, width)
    if missed:
        result.reason = _reason("pose_not_reached", f"Not the {request.shape.upper()} shape: {missed}")
        return result
    # What the model moved, applied to the confirmed points.
    result.targets, result.rms = base_points + (registered - base_view), rms
    return result


# --- 4. Retarget fallback -----------------------------------------------------------------------

# Vertical lip movement follows each lip's own height, but never further
# from the width-based scale than this: a detector that finds a hairline
# upper lip must not freeze it, nor a thick one double every movement.
LIP_SCALE_RANGE = (0.6, 1.6)
# Half-height of the band around the rest seam over which the upper lip's
# scale gives way to the lower lip's, in Reference mouth widths.
LIP_BLEND = 0.05


def _smoothstep(t: np.ndarray) -> np.ndarray:
    t = np.clip(t, 0.0, 1.0)
    return t * t * (3 - 2 * t)


def _lip_heights(points: np.ndarray) -> tuple[float, float, float]:
    """(corner-to-corner width, upper lip height, lower lip height) at rest."""
    width = float(np.linalg.norm(points[MOUTH_RIGHT] - points[MOUTH_LEFT]))
    upper = float(np.linalg.norm(points[UPPER_OUTER] - points[UPPER_INNER]))
    lower = float(np.linalg.norm(points[LOWER_INNER] - points[LOWER_OUTER]))
    return width, upper, lower


def retarget_reference_pose(
    shape: str, base_points: np.ndarray, reference: ReferenceMotion, amplitude: float = 1.0
) -> np.ndarray:
    """The Reference's `shape`, moved onto this face: targets in base pixels.

    The Reference's displacement of every landmark is taken in its levelled
    mouth frame; its horizontal part is scaled by this face's mouth width
    over the Reference's, its vertical part by this face's upper lip height
    over the Reference's above the lip seam and by the lower lip's below it
    (blended across the seam), then turned into this face's mouth angle.

    The falloff away from the mouth is NOT applied here: the engine applies
    it (performanceInfluence) to every pose, on the manifest's rest points,
    which in a per-avatar manifest are this face's own neutral points. So a
    retargeted pose is baked in full, and the embed needs no retarget code.

    `amplitude` scales the whole movement. The Reference's poses are true
    at jawRange 0.85 (REFERENCE_JAW_RANGE); a manifest records the jaw range
    ITS poses are true at (`jaw_range`: the one fitted from this face's own
    AA) and the engine plays every pose at jawRange / jaw_range. A
    retargeted pose baked into it at jaw_range / 0.85 therefore plays, at
    any profile, as the same Reference pose does through the bundled
    motion, and keeps its size relative to the generated poses.
    """
    rest, pose = reference.rest, reference.poses[shape]
    ref_level = _level(_corner_angle(rest))
    ref_mid = reference.corner_mid
    displacement = (pose - rest) @ ref_level.T
    neutral = (rest - ref_mid) @ ref_level.T
    ref_width, ref_upper, ref_lower = _lip_heights(rest)
    width, upper, lower = _lip_heights(base_points)

    sx = width / ref_width
    low, high = LIP_SCALE_RANGE

    def lip_scale(height: float, ref_height: float) -> float:
        if ref_height <= 1e-9 or height <= 1e-9:
            return sx
        return float(np.clip(height / ref_height, low * sx, high * sx))

    seam = (neutral[UPPER_INNER, 1] + neutral[LOWER_INNER, 1]) / 2
    below = _smoothstep((neutral[:, 1] - seam) / (2 * LIP_BLEND * ref_width) + 0.5)
    sy = lip_scale(upper, ref_upper) * (1 - below) + lip_scale(lower, ref_lower) * below
    local = np.stack((displacement[:, 0] * sx, displacement[:, 1] * sy), axis=-1) * amplitude
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
    # One entry per value left at its default or clamped, with why.
    reasons: list[dict] = field(default_factory=list)
    # True when the profile is fitted for the teeth photo, which the embed
    # accepts: the caller hands the photo on only then.
    teeth_photo: bool = False

    def as_dict(self) -> dict:
        return {"profile": self.profile, "measurements": self.measurements, "reasons": self.reasons,
                "teeth_photo": self.teeth_photo}


@dataclass(frozen=True)
class TeethPhoto:
    """The EE answer and its landmarks, in the answer's own pixels."""

    image: Image.Image
    points: np.ndarray


def geometric_teeth_scale(base_points: np.ndarray, reference: ReferenceMotion) -> float:
    """teethScale for the drawn (geometric) teeth: they are sized in mouth
    widths for the Reference's mouth-to-face proportion, so the Reference's
    ratio over this face's (exactly 1 on the Reference). Unclamped."""
    width, _, _ = _lip_heights(base_points)
    face = float(np.linalg.norm(base_points[FACE_RIGHT] - base_points[FACE_LEFT]))
    ref_width, _, _ = _lip_heights(reference.rest)
    return (ref_width / reference.face_width) / (width / face)


def for_drawn_teeth(profile: dict, base_points, reference: ReferenceMotion) -> dict:
    """A fitted `profile` as fit_profile makes it without a teeth photo:
    teethY at its default and teethScale for the drawn teeth (clamped);
    jawRange and the rest unchanged. For a kit whose teeth photo the caller
    could not keep after all (services.mouth_kit: the WebP visitors get is
    tested again, and a photo on the very edge of the embed's limits can
    fail there): a profile fitted for teeth that are not drawn would seat
    and size the drawn ones wrongly."""
    defaults, limits = _profile_defaults()
    low, high = limits["teethScale"]
    scale = geometric_teeth_scale(_checked_points(base_points), reference)
    return {**profile, "teethY": defaults["teethY"],
            "teethScale": round(min(high, max(low, scale)), 4)}


def fit_profile(
    base_points: np.ndarray,
    generated: dict[str, np.ndarray],
    reference: ReferenceMotion,
    teeth_photo: TeethPhoto | None = None,
) -> ProfileFit:
    """The mouth profile, fitted from this face's own shapes.

    `generated` holds the REGISTERED targets (base pixels) of the shapes
    the model made; retargeted shapes are not measurements of this face and
    must not be passed. `teeth_photo` is the photo `generated["ee"]` was
    registered from. Each value is clamped to the API's range, and one that
    cannot be measured stays at its default, with the reason.

    The teeth photo counts only if the embed would draw it
    (dental_photo.accept_teeth_photo: DentalOralSurface's own test); one it
    would refuse leaves the geometric teeth, and the fit is for those.

    teethY: where the teeth photo's upper arch ends (the bottom of the arch
      the embed extracts, which is what dentalPlacement seats), carried by
      the EE registration onto the base, measured below the neutral seam in
      rest mouth widths: skull-fixed, so the EE's lifted upper lip is not
      taken for lower teeth. Plus REFERENCE_TEETH_DROP, less UPPER_SEAT: on
      oral-detail-v3 registered onto the Reference portrait this gives the
      hand-tuned 0.016 the Reference renders that photo with.
    teethScale: with a teeth photo, its mouth width over the rest mouth
      width (both registered): the photo's teeth are sized in its own mouth
      widths and drawn in rest widths, so this draws them at their true
      size. (The Reference renders v3 at the default 1.00, never tuned; v3
      would fit 1.13.) Without one the drawn teeth are geometric and sized
      in mouth widths, so the scale is the Reference's mouth-to-face width
      ratio over this face's (exactly 1 on the Reference).
    jawRange: the default (0.85) times this face's AA lip opening over the
      Reference's AA opening, both in rest mouth widths.
    """
    from app.services import dental_photo

    defaults, limits = _profile_defaults()
    fit = ProfileFit(profile=dict(defaults))
    width, _, _ = _lip_heights(base_points)
    ref_width, _, _ = _lip_heights(reference.rest)

    def settle(name: str, value: float | None, why: dict | None = None) -> None:
        if value is None or not math.isfinite(value):
            fit.reasons.append({"field": name, **(why or _reason("unmeasured", "not measured"))})
            return
        low, high = limits[name]
        clamped = min(high, max(low, value))
        if clamped != value:
            fit.reasons.append({"field": name, "code": "clamped",
                                "detail": f"{value:.4f} is outside {low}..{high}"})
        fit.profile[name] = round(clamped, 4)

    ee = generated.get("ee")
    acceptance = None
    if ee is not None and teeth_photo is not None:
        acceptance = dental_photo.accept_teeth_photo(teeth_photo.image, teeth_photo.points,
                                                     INNER_LIP_RING)
        fit.measurements["teeth_photo"] = acceptance.as_dict()
    if acceptance is not None and acceptance.accepted:
        down_ee, ee_px = _down(ee)
        # The arch's end in the photo's mouth frame (origin 13, corner line
        # level, in its mouth widths); the registration is a similarity, so
        # the same frame on the registered EE landmarks places it on the base.
        edge = ee[UPPER_INNER] + acceptance.upper_edge * ee_px * down_ee
        seam, down, _ = neutral_seam(base_points)
        below = float((edge - seam) @ down) / width
        ee_width = ee_px / width
        fit.teeth_photo = True
        fit.measurements.update(teeth_edge_below_seam=round(below, 4), ee_width=round(ee_width, 4))
        settle("teethY", below + REFERENCE_TEETH_DROP - UPPER_SEAT)
        settle("teethScale", ee_width)
    else:
        if ee is None:
            why = _reason("ee_not_generated", "No EE photo of this face")
        elif teeth_photo is None:
            why = _reason("no_teeth_photo", "The EE photo cannot serve as the teeth photo")
        elif acceptance.arch_pixels == 0:
            why = _reason("no_teeth_visible", "The EE photo shows no upper teeth")
        else:
            why = _reason(
                "teeth_photo_refused",
                "The EE photo shows too little of the upper teeth for the photographic mouth "
                f"(central crown {acceptance.crown_coverage:.3f} of the mouth width, arch "
                f"{acceptance.arch_width} px, {acceptance.arch_pixels} px of enamel; the embed "
                f"needs {dental_photo.MIN_CROWN_COVERAGE}, {dental_photo.MIN_ARCH_WIDTH} and "
                f"{dental_photo.MIN_ARCH_PIXELS})",
            )
        settle("teethY", None, why)
        ratio = geometric_teeth_scale(base_points, reference)
        fit.measurements["mouth_to_face_vs_reference"] = round(1 / ratio, 4)
        settle("teethScale", ratio)

    aa = generated.get("aa")
    if aa is not None:
        gap = float(np.linalg.norm(aa[UPPER_INNER] - aa[LOWER_INNER])) / width
        ref_aa = reference.poses["aa"]
        ref_gap = float(np.linalg.norm(ref_aa[UPPER_INNER] - ref_aa[LOWER_INNER])) / ref_width
        fit.measurements.update(aa_gap=round(gap, 4), reference_aa_gap=round(ref_gap, 4))
        settle("jawRange", REFERENCE_JAW_RANGE * gap / ref_gap)
    else:
        settle("jawRange", None, _reason("aa_not_generated", "No AA photo of this face"))
    return fit


# --- 5. Manifest ----------------------------------------------------------------------------------

GENERATED = "generated"
RETARGETED = "retargeted"
BASE = "base"


@dataclass(frozen=True)
class PoseEntry:
    """One shape for the manifest: targets in base pixels and where they
    came from. `source` is the answer's landmarks as fractions of the
    answer image (its UV map), for a generated pose only."""

    targets: np.ndarray
    provenance: str
    rms: float | None = None
    source: np.ndarray | None = None


def _rounded(points: np.ndarray) -> list:
    return np.asarray(points, dtype=np.float64).round(7).tolist()


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
    generated or retargeted) and allows `image` and `source` to be null
    (a pose's own photo is not delivered: the continuous mouth warps the one
    portrait) and `registration_rms` to be null for a retargeted pose; and
    at the top, `jaw_range` (the profile jawRange this geometry is true at:
    the engine scales movement by jawRange / jaw_range), `frame` (base
    pixels to manifest units) and `kit` (recipe versions).
    """
    if set(poses) != set(SHAPES):
        raise ValueError("every shape needs a pose")
    if not isinstance(kit_id, str) or not KIT_ID.fullmatch(kit_id):
        raise ValueError("kit_id must be 1-64 ASCII letters, digits, '-' or '_'")
    frame = ManifestFrame.from_base(base_points, image_size, reference)
    rest = frame.apply(base_points)
    width, cx, cy = mouth_frame(rest, OUTER_LIP_RING)
    size = np.asarray(image_size, dtype=np.float64)
    entries = [{
        "id": "rest", "image": None, "source": _rounded(base_points / size),
        "points": _rounded(rest), "registration_rms": 0.0, "provenance": BASE,
    }]
    for shape in SHAPES:
        pose = poses[shape]
        entries.append({
            "id": shape,
            "image": None,
            "source": None if pose.source is None else _rounded(pose.source),
            "points": _rounded(frame.apply(pose.targets)),
            "registration_rms": None if pose.rms is None else round(float(pose.rms), 6),
            "provenance": pose.provenance,
        })
    triangles = shared_triangles([e["points"] for e in entries], rest, (cx, cy), width)
    return {
        "version": MANIFEST_VERSION,
        "character": f"{CHARACTER_PREFIX}{kit_id}",
        "poses": entries,
        "triangles": triangles,
        "center": [cx, cy],
        "mouth_width": width,
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
# seven decimals, about 1e-4 px.
SAME_POINTS_PX = 1e-3


def rebase_manifest(
    manifest: dict, base_points, reference: ReferenceMotion | None = None
) -> dict:
    """The kit `manifest` moved onto re-confirmed points, with no AI call.

    The owner re-marked the face (Mark the face, a re-detection) on the SAME
    picture: its rest pose is now `base_points`, the rig's 478 points in the
    picture's pixels. Every shape keeps the displacement from rest it had,
    in base pixels (recovered through the old frame's `to_manifest`): the
    answer moved the mouth that far, wherever the marks now say it rests,
    exactly as register_answer adds an answer's movement to the confirmed
    points. The frame is recomputed from the new points (build_manifest),
    so the manifest stays in the Reference's units and validates as any
    kit does; provenance, sources, registration, the kit id, the recipe
    that made the poses (`kit`) and the jaw range are kept.

    Onto the manifest's own rest points it returns the manifest unchanged.
    Raises ValueError for a manifest this module did not write, or points
    that are not 478 finite pixels. CPU work (the triangulation).
    """
    points = _checked_points(base_points)
    if not is_kit_manifest(manifest):
        raise ValueError("not a performance kit manifest")
    to_base = manifest_to_base(manifest)
    poses = {pose["id"]: pose for pose in manifest["poses"]}
    rest = to_base(poses["rest"]["points"])
    if np.abs(rest - points).max() <= SAME_POINTS_PX:
        return copy.deepcopy(manifest)
    reference = reference or load_reference()
    entries = {}
    for shape in SHAPES:
        pose = poses[shape]
        source = pose.get("source")
        entries[shape] = PoseEntry(
            points + (to_base(pose["points"]) - rest),
            pose["provenance"],
            pose.get("registration_rms"),
            None if source is None else np.asarray(source, dtype=np.float64),
        )
    image_size = tuple(int(v) for v in manifest["frame"]["image_size"])
    rebased = build_manifest(
        points, image_size, entries, reference,
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
    """The EE answer, usable as the continuous mouth's oral photo: the
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


EditImage = Callable[[str, bytes, str], Awaitable[object]]
# on_progress(fraction, message, shapes_done): shapes_done is how many of
# the six shapes are settled (made, or given up on and to be retargeted).
Progress = Callable[[float, str, int], object]


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

# Minimum lip gap for the EE answer to be considered as the teeth photo: the
# mouth-photo upload's own threshold (portrait_photo.prepare_photo). It must
# then also pass the embed's own test (fit_profile, dental_photo).
TEETH_PHOTO_MIN_GAP = 0.08


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


def _teeth_gap(registration: PoseRegistration) -> float:
    """The answer's lip gap (13 to 14) in its own mouth widths."""
    points = registration.answer_points
    width = float(np.linalg.norm(points[MOUTH_RIGHT] - points[MOUTH_LEFT]))
    return float(np.linalg.norm(points[UPPER_INNER] - points[LOWER_INNER])) / max(width, 1.0)


def _teeth_source(registration: PoseRegistration) -> TeethSource:
    from app.services.rig import build_rig

    points, image = registration.answer_points, registration.answer_image
    return TeethSource(_png(image), build_rig(points, image.size))


def _finish(
    base_points: np.ndarray,
    image_size: tuple[int, int],
    registrations: dict[str, PoseRegistration],
    reference: ReferenceMotion,
    kit_id: str,
) -> tuple[dict, ProfileFit, TeethSource | None]:
    """Everything after the provider calls: fit, fallbacks, manifest. CPU work."""
    generated = {shape: registrations[shape].targets for shape in SHAPES
                 if shape in registrations and registrations[shape].ok}
    # The profile is fitted for the teeth that will be drawn: the EE photo's
    # when the embed would draw it, the geometric ones otherwise. It is
    # fitted first because the fallbacks below are baked at its jaw range.
    teeth_photo = None
    ee = registrations.get("ee")
    ee_ok = ee is not None and ee.ok
    if ee_ok and _teeth_gap(ee) >= TEETH_PHOTO_MIN_GAP:
        teeth_photo = TeethPhoto(ee.answer_image, ee.answer_points)
    fit = fit_profile(base_points, generated, reference, teeth_photo)
    teeth = _teeth_source(ee) if fit.teeth_photo else None
    if ee_ok and teeth is None:
        if teeth_photo is None:
            why = _reason("teeth_gap_small",
                          "The EE photo's lips are too close to use it as the teeth photo")
        else:
            why = next({k: v for k, v in r.items() if k != "field"}
                       for r in fit.reasons if r["field"] == "teethY")
        fit.reasons.append({"field": "teeth_source", **why})

    # The manifest's poses must all be true at the jaw range it records, as
    # the generated ones are (they are this face's own AA's scale); see
    # retarget_reference_pose.
    amplitude = fit.profile["jawRange"] / REFERENCE_JAW_RANGE
    entries: dict[str, PoseEntry] = {}
    for shape in SHAPES:
        registration = registrations.get(shape)
        if shape in generated:
            size = np.asarray(registration.answer_size, dtype=np.float64)
            entries[shape] = PoseEntry(registration.targets, GENERATED, registration.rms,
                                       registration.answer_points / size)
        else:
            entries[shape] = PoseEntry(
                retarget_reference_pose(shape, base_points, reference, amplitude), RETARGETED)
    manifest = build_manifest(base_points, image_size, entries, reference,
                              kit_id=kit_id, jaw_range=fit.profile["jawRange"])
    return manifest, fit, teeth


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
    concurrency: int = 3,
    per_call_timeout: float | None = None,
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
    nothing more may be: that shape and every one not yet asked are
    retargeted, and their reason is the exception's `code` and `detail`
    when it carries them (a caller that stops at its AI switch or its
    image limit), else "imagegen_unavailable".

    Up to `concurrency` edits are in flight at once, each bounded by
    `per_call_timeout` seconds (imagegen's own timeout by default, so the
    two bounds agree: either way the call is a "timeout", sent and possibly
    billed). A refused edit is asked once more on the head-and-shoulders
    crop (a different input: photo_adjust's fallback); nothing else is ever
    asked twice. A shape that fails for any reason, its answer's checks
    included, is filled from the Reference, so the kit is always complete:
    with no provider at all it is the Reference retargeted, per avatar.

    The base photo is detected once as well, with the same detector as the
    answers: they are registered on that view of it and their movement is
    added to the confirmed points (register_answer), so the owner's
    corrections to the marks are kept and never read as motion.

    `on_progress(fraction, message, shapes_done)` is called as shapes
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

    semaphore = asyncio.Semaphore(max(1, int(concurrency)))
    crops: dict[str, asyncio.Future] = {}
    call_log: list[dict] = []
    state: dict = {"calls": 0, "billed": 0, "stopped": None, "done": 0}

    async def report_progress(message: str, fraction: float | None = None) -> None:
        if on_progress is None:
            return
        done = state["done"]
        if fraction is None:
            fraction = 0.95 * done / len(SHAPES)
        outcome = on_progress(fraction, message, done)
        if inspect.isawaitable(outcome):
            await outcome

    async def crop_for(kind: str) -> _Crop | None:
        # One crop per kind, shared by every shape that needs it; shielded,
        # so a shape torn down while it waits does not cancel it for the
        # others (and a crop nobody waits for any more is not left with an
        # unretrieved error).
        if kind not in crops:
            future = asyncio.ensure_future(run_cpu(_crop, base_image, points, kind))
            future.add_done_callback(lambda done: done.cancelled() or done.exception())
            crops[kind] = future
        return await asyncio.shield(crops[kind])

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
                    generated = await asyncio.wait_for(
                        edit_image(request.prompt, request.payload, request.mime),
                        timeout=per_call_timeout,
                    )
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
                    # more (its switch, its limit). Nothing more is asked.
                    state["calls"] -= 1
                    call_log.remove(record)
                    entry["attempts"].pop()
                    reason = stop_reason(exc)
                    state["stopped"] = state["stopped"] or reason
                    entry.update(outcome="unavailable", reason=reason)
                    return None, entry
                except asyncio.CancelledError:
                    # Torn down (another shape failed) or the caller was
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
                # not pass: retargeted, like any rejected one, and the other
                # shapes' paid calls carry on.
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
        # leave the other shapes' paid calls running, unaccounted for; the
        # group cancels and awaits them first.
        async with asyncio.TaskGroup() as group:
            tasks = [group.create_task(tracked(shape)) for shape in SHAPES]
        results = [task.result() for task in tasks]
        registrations = {shape: reg for shape, (reg, _) in zip(SHAPES, results) if reg is not None}
        manifest, fit, teeth = await run_cpu(
            _finish, points, base_image.size, registrations, reference, kit_id
        )
        report = {}
        for shape, (registration, entry) in zip(SHAPES, results):
            ok = registration is not None and registration.ok
            report[shape] = {
                "status": "ok" if ok else "retargeted",
                "outcome": entry["outcome"],
                "reason": entry.get("reason"),
                "attempts": entry["attempts"],
                "checks": entry.get("checks", {}),
            }
        await report_progress("mouth kit ready", 1.0)
    except Exception as exc:
        cause = exc.exceptions[0] if isinstance(exc, ExceptionGroup) else exc
        logger.error("performance kit failed after %d call(s): %r", state["calls"], cause)
        raise KitFailed(state["calls"], state["billed"], call_log) from cause
    return KitResult(
        manifest=manifest,
        profile=fit.profile,
        profile_fit=fit.as_dict(),
        teeth_source=teeth,
        report=report,
        calls=state["calls"],
        billed_calls=state["billed"],
        call_log=call_log,
        base_detected=base_detected is not None,
    )
