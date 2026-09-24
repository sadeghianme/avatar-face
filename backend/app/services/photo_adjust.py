"""AI adjust: a paid AI edit of the photo before it is rigged.

Step 3 of the creation wizard (docs/avatar-lines.md, "The creation flow"),
after the background: recommended when the photo check finds something to
fix (photo_analysis.recommend), and always the owner's choice. Three modes,
per line:

- **touchup** (human): open eyes looking at the camera and relaxed closed
  lips, nothing else. The model sees a FACE CROP, and only the eye and lip
  regions of its answer are pasted back onto the photo, at the photo's own
  resolution. Everything else (hair, skin, clothes, background, and every
  pixel of the face outside those regions) is the owner's original.
- **stylise** (human → animation): the existing imagegen styles, on the
  whole image. Choosing the result moves the creation to the animation line.
- **regenerate** (every line): a full edit to a frontal, evenly lit,
  plain-backdrop picture of the same subject.

Why touch-up is a crop and a paste, not an edit of the photo: an image model
asked to change the eyes of a whole portrait redraws the whole portrait. The
skin, the hair and the identity drift, and the result comes back at the
model's size, not the photo's. Sending only the face (about 1.6 face boxes,
square, 1024 px) spends the model's pixels where the change is, and pasting
back only the eye and lip regions keeps every other pixel. To make the paste
invisible the answer is:

1. aligned to the photo with a similarity transform estimated from STABLE
   landmarks (the nose bridge and the upper face oval), found by MediaPipe
   on both images. Never the eyes or the mouth: those are what changed, and
   the jaw moves when an open mouth closes;
2. low-passed before it is shrunk onto the photo's pixel grid (and the
   crop before it is shrunk to the model's size): a resampler that does not
   average leaves lashes and iris texture finer than the photo's pixels at
   full contrast, jagged and crisper than the face around them;
3. masked by the hulls of the eye and lip landmarks (the photo's and the
   answer's together, so an eye that opened is covered where it now is and
   where it was), dilated a little so the lids and lip edges come along,
   and never onto the eyebrows (the prompt keeps them; pasting their edge
   would show it twice, wherever the model drew it);
4. feathered with a smoothstep, so there is no seam to see;
5. colour-matched in LAB on a ring just outside each region (the model
   relights what it touches), and grain-matched (the model's pixels are
   cleaner than a phone photo's, and a smooth patch reads as a sticker).
   Both are measured robustly (median, MAD) on skin only: the ring leaves
   out the brows and, for the lips, whatever lies outside either face, so
   brow hairs are not taken for sensor grain nor a neck for skin.

A touch-up refuses an answer whose jaw moved (`jaw_moved`): closing an open
mouth raises the chin, and pasted closed lips on the photo's dropped chin
make a longer face. An open mouth is therefore a regenerate's job
(photo_analysis.recommend); a touch-up closes parted lips.

The image adjusted is the CURRENT one, which after step 2 is usually a
cut-out. The model is then shown the person on a flat neutral grey
(photo_io.on_backdrop), never the removed background, which is not in the
file anyway. A touch-up pastes its eyes and lips back into the cut-out's own
pixels and leaves the transparency alone, so the result is still a cut-out;
a regenerated or stylised picture comes back opaque on a plain backdrop, and
services.creations cuts it out again when the owner chose to remove the
background.

Every candidate is checked before it is offered: a face must still be found
(human and animation lines) and the fit validator must pass on it, and for a
person, the skin tone must not drift (mean cheek colour, delta E in LAB).
A failed candidate is kept with its reason and cannot be chosen; nothing is
ever used without the owner choosing it. There is deliberately no
face-recognition identity check: the owner compares side by side, and
biometric processing is not needed for that.

Everything here is CPU work (decode, MediaPipe, resampling, masks) and runs
on the jobs CPU thread; the provider call itself is awaited on the loop by
services.creations.
"""

from __future__ import annotations

import io
import logging
import math
from dataclasses import dataclass, field

import numpy as np
from PIL import Image

logger = logging.getLogger("liveface.photo_adjust")

TOUCHUP = "touchup"
STYLISE = "stylise"
REGENERATE = "regenerate"
MODES = (TOUCHUP, STYLISE, REGENERATE)

# Which modes each line offers (docs/avatar-lines.md, the "AI presets" row).
# Touch-up and stylise need a detected human face: touch-up to know where the
# eyes are, stylise because turning a drawing into a drawing is regenerate.
MODES_BY_LINE: dict[str, tuple[str, ...]] = {
    "human": (TOUCHUP, STYLISE, REGENERATE),
    "animal": (REGENERATE,),
    "cartoon": (REGENERATE,),
}

# Per round, and per creation. Each candidate is a paid call and ~10 s; two
# are enough to compare, and two rounds are enough to try another mode. A
# photo that needs more than that needs replacing, not more rolls.
MAX_CANDIDATES = 2
ROUNDS_PER_CREATION = 2

# The face crop sent for a touch-up: this many face boxes, square, at this
# size. 1.6 keeps the brows, the lids' surroundings and the lips well inside
# the crop, with enough context that the model draws a face, not a mask.
CROP_SCALE = 1.6
CROP_SIZE = 1024
CROP_QUALITY = 94
# Whole-image edits (stylise, regenerate) are sent at this long edge.
SOURCE_MAX_EDGE = 1024
# Where a whole-image result is stored at most (as for uploads).
STORED_MAX_EDGE = 2048

# How far the nose tip may sit from the middle of the cheeks, as a fraction
# of half the face width, for a touch-up. Beyond it one eye is foreshortened
# and partly hidden, the model redraws it frontal, and no 2D paste can put a
# frontal eye into a turned face.
MAX_TOUCHUP_YAW = 0.3

# A similarity fit whose landmarks miss by more than this (fraction of the
# face width, RMS) did not find the same face: the model moved or reshaped
# it too much to paste back.
MAX_ALIGN_RESIDUAL = 0.04
# Skin tone drift allowed between the photo and a candidate: delta E in LAB
# over the mean cheek colour, with lightness at half weight (regenerate asks
# for even light, which changes L on purpose; a change of hue or chroma is
# what reads as a different person's skin).
MAX_SKIN_DELTA_E = 12.0
SKIN_L_WEIGHT = 0.5

# MediaPipe indices. Eyes are named by the side of the IMAGE they are on
# (as in anchor_fit: 33 is the image-left eye's outer corner).
EYE_IMAGE_LEFT = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246,
                  468, 469, 470, 471, 472]
EYE_IMAGE_RIGHT = [362, 382, 381, 380, 374, 373, 390, 249, 263, 466, 388, 387, 386, 385, 384,
                   398, 473, 474, 475, 476, 477]
LIPS = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185]
# The eyebrows as closed contours (upper edge outward, lower edge back), not
# hulls: an arched brow's hull reaches down to the lid.
BROW_IMAGE_LEFT = [70, 63, 105, 66, 107, 55, 65, 52, 53, 46]
BROW_IMAGE_RIGHT = [300, 293, 334, 296, 336, 285, 295, 282, 283, 276]
# The face oval, in order round the face: where skin ends. The lips' colour
# ring must stay inside it, in the photo and in the answer alike.
FACE_OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378,
             400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21,
             54, 103, 67, 109]
# The chin and the jaw beside it: where a mouth that closed shows it.
CHIN = [152, 148, 377, 176, 400]
# Landmarks a touch-up does not move: the nose bridge and the face oval above
# the mouth. The lower oval is left out because the jaw rises when a mouth
# closes.
STABLE = [168, 6, 197, 195, 5,
          10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 93, 234, 127, 162, 21, 54, 103, 67, 109]
CHEEK_IMAGE_LEFT = [50, 101, 118, 117, 116, 123, 147, 187, 205, 36]
CHEEK_IMAGE_RIGHT = [280, 330, 347, 346, 345, 352, 376, 411, 425, 266]
NOSE_TIP = 1
FACE_LEFT, FACE_RIGHT = 234, 454

# Mask geometry, as fractions of the region's own size (eye width, mouth
# width): the dilation brings the lids, lashes and lip edges along, the
# feather hides the join, the ring beyond it is where colour is measured.
# The eye's paste ends 0.30 eye widths out, short of the brow (0.3 to 0.4
# out on the face template); BROW_GUARD keeps it off a brow that sits
# closer, fading to nothing on the brow itself.
EYE_DILATE, EYE_FEATHER = 0.12, 0.18
LIP_DILATE, LIP_FEATHER = 0.15, 0.20
RING_WIDTH = 0.20
BROW_GUARD = 0.05
# How far the answer's chin may sit from the photo's once aligned, as a
# fraction of the face height, before the paste is refused. Parted lips
# (photo_analysis.TEETH_RATIO to OPEN_MOUTH_RATIO of the mouth width) close
# with the chin rising under 3.6% of the face; an open mouth moves it more.
MAX_JAW_SHIFT = 0.04

TOUCHUP_PROMPT = (
    "Edit this close-up portrait photograph. Make exactly two changes: the eyes "
    "are open naturally and looking straight into the camera, and the lips are "
    "relaxed and closed. Change NOTHING else: keep the same person, the same face "
    "shape, skin, skin texture, pores, makeup, eye colour, eyebrows, hair, "
    "lighting, colours, framing, head position, head angle and image size. Do not "
    "beautify, smooth, sharpen, relight, restyle or crop. Photorealistic, "
    "indistinguishable from the original photo except for the eyes and the lips."
)

# Regenerate, per line: the rig's requirements (frontal, eyes visible, mouth
# closed, plain backdrop) stated for the kind of face it is, plus what must
# not change.
REGENERATE_PROMPTS: dict[str, str] = {
    "human": (
        "Edit this photo into a head-and-shoulders portrait of the same person facing "
        "the camera directly, with even, soft, frontal lighting, both eyes open and "
        "looking at the camera, lips relaxed and closed, and a plain, uncluttered, "
        "evenly lit backdrop. Keep the person's identity exactly: same face shape and "
        "proportions, same skin tone, same hair and hairstyle, same apparent age, same "
        "clothing. Photorealistic. The whole head must be inside the frame with space "
        "around it; the face fills roughly half the image width. No text, no "
        "watermark, no hands or objects in front of the face."
    ),
    "animal": (
        "Edit this picture into a portrait of the same animal facing the camera "
        "directly, both eyes clearly visible, mouth closed, on a plain, uncluttered, "
        "evenly lit backdrop. Keep it the same animal: same species and breed, same "
        "fur or skin colours and markings, same eye colour, same style of picture. "
        "The whole head must be inside the frame with space around it, filling "
        "roughly half the image width. No text, no watermark, no people, no objects "
        "in front of the face."
    ),
    "cartoon": (
        "Edit this picture into a clean portrait of the same character facing the "
        "camera directly: clean lines, clearly drawn open eyes, mouth closed, on a "
        "plain, uncluttered backdrop. Keep it the same character: same design, "
        "colours, proportions, hair and clothing, and the same art style. The whole "
        "head must be inside the frame with space around it, filling roughly half the "
        "image width. No text, no watermark, no objects in front of the face."
    ),
}


class AdjustSkipped(Exception):
    """This photo cannot be adjusted in this mode; say why, spend nothing."""

    def __init__(self, code: str, detail: str):
        self.code = code
        self.detail = detail
        super().__init__(detail)


def reason(code: str, detail: str) -> dict:
    return {"code": code, "detail": detail}


# --- What is sent ---------------------------------------------------------------


@dataclass
class Prepared:
    """What goes to the provider for one round, and what the paste needs."""

    prompt: str
    payload: bytes
    mime: str
    # Touch-up: the crop square in photo pixels (x0, y0, side) and the
    # photo's landmarks. None for whole-image modes.
    crop: tuple[float, float, float] | None = None
    source_points: np.ndarray | None = None
    # Touch-up of a photo whose eyes were closed: the eyes in the result
    # are the model's invention, and the wizard must say so.
    generated_eyes: bool = False


def _rgb(data: bytes) -> Image.Image:
    """Decode to what the model and the detector are shown: opaque RGB, a
    cut-out on the neutral grey backdrop (photo_io.on_backdrop). Black,
    what is under alpha 0, would read as a dark room to the model."""
    from app.services.photo_io import on_backdrop

    with Image.open(io.BytesIO(data)) as image:
        return on_backdrop(image)


def _own_rgb(data: bytes) -> Image.Image:
    """The image's own colour channels, not composited: what a touch-up
    pastes into, so a cut-out's pixels outside the eyes and lips stay its
    own to the bit (and zero under alpha 0)."""
    with Image.open(io.BytesIO(data)) as image:
        if image.mode in ("RGBA", "LA", "PA") or "transparency" in image.info:
            return image.convert("RGBA").convert("RGB")
        return image.convert("RGB")


def _alpha(data: bytes) -> Image.Image | None:
    """The alpha channel of a transparent image, or None for an opaque one."""
    with Image.open(io.BytesIO(data)) as image:
        if image.mode in ("RGBA", "LA", "PA") or "transparency" in image.info:
            return image.convert("RGBA").getchannel("A")
    return None


def _jpeg(image: Image.Image, quality: int) -> bytes:
    out = io.BytesIO()
    image.save(out, format="JPEG", quality=quality, optimize=True)
    return out.getvalue()


def face_crop_box(points: np.ndarray) -> tuple[float, float, float]:
    """(x0, y0, side): the square about the face box's centre, CROP_SCALE
    times its longer side. May reach past the photo (see `crop_face`)."""
    x0, y0 = points[:, 0].min(), points[:, 1].min()
    x1, y1 = points[:, 0].max(), points[:, 1].max()
    side = CROP_SCALE * max(x1 - x0, y1 - y0)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    return float(cx - side / 2), float(cy - side / 2), float(side)


def crop_face(image: Image.Image, box: tuple[float, float, float]) -> Image.Image:
    """The crop square resampled to CROP_SIZE. Past the photo's edge it is
    filled with the photo's own edge pixels: a black band would be a new
    edge the model might draw into the face.

    Lanczos through `resize`, not a fixed-kernel transform: a face wider
    than about 640 px makes a crop larger than CROP_SIZE, and a shrink that
    does not widen its kernel aliases hair and brow strands into moire the
    model then redraws. `resize` scales its support with the reduction."""
    x0, y0, side = box
    width, height = image.size
    pad = int(math.ceil(max(0.0, -x0, -y0, x0 + side - width, y0 + side - height))) + 2
    source = image
    if pad > 2:
        padded = np.pad(np.asarray(image), ((pad, pad), (pad, pad), (0, 0)), mode="edge")
        source = Image.fromarray(padded)
        x0, y0 = x0 + pad, y0 + pad
    return source.resize(
        (CROP_SIZE, CROP_SIZE),
        Image.Resampling.LANCZOS,
        box=(x0, y0, x0 + side, y0 + side),
    )


def yaw_offset(points: np.ndarray) -> float:
    """How far the nose tip is from the middle of the cheeks: 0 frontal,
    1 at a cheek's edge."""
    left, right = points[FACE_LEFT][0], points[FACE_RIGHT][0]
    half = abs(right - left) / 2
    if half <= 0:
        return 1.0
    return float(abs(points[NOSE_TIP][0] - (left + right) / 2) / half)


def eyes_closed(points: np.ndarray) -> bool:
    """Is either eye closed? The photo check's measure and threshold
    (photo_analysis.EYE_CLOSED_EAR), so the eyes a touch-up labels as
    generated are the ones the check called closed."""
    from app.services.photo_analysis import EYE_CLOSED_EAR, eye_aspect_ratios

    return min(eye_aspect_ratios(points)) < EYE_CLOSED_EAR


def _detect(image: Image.Image) -> np.ndarray | None:
    from app.services import landmarks

    found = landmarks.detect(image)
    return None if found is None else found.points


def prepare(data: bytes, mode: str, face_type: str, style: str | None = None) -> Prepared:
    """What to send for `mode`. CPU work.

    Raises AdjustSkipped when a touch-up is impossible on this photo (no
    face found, no detector on this server, head turned too far), before
    anything is sent or spent.
    """
    from app.services import imagegen, landmarks

    image = _rgb(data)
    if mode == TOUCHUP:
        try:
            points = _detect(image)
        except landmarks.LandmarkerUnavailable as exc:
            raise AdjustSkipped(
                "landmarks_unavailable", "Face detection is not available on this server"
            ) from exc
        if points is None:
            raise AdjustSkipped(
                "no_face_for_touchup", "No face was found to touch up in this photo"
            )
        if yaw_offset(points) > MAX_TOUCHUP_YAW:
            raise AdjustSkipped(
                "face_turned",
                "The head is turned too far for a touch-up; use a photo facing the camera",
            )
        box = face_crop_box(points)
        return Prepared(
            prompt=TOUCHUP_PROMPT,
            payload=_jpeg(crop_face(image, box), CROP_QUALITY),
            mime="image/jpeg",
            crop=box,
            source_points=points,
            generated_eyes=eyes_closed(points),
        )

    if mode == STYLISE:
        prompt = imagegen.build_prompt(style or "illustrated", has_source=True)
    else:
        prompt = REGENERATE_PROMPTS[face_type]
    whole = image.copy()
    if max(whole.size) > SOURCE_MAX_EDGE:
        whole.thumbnail((SOURCE_MAX_EDGE, SOURCE_MAX_EDGE), Image.Resampling.LANCZOS)
    return Prepared(prompt=prompt, payload=_jpeg(whole, imagegen.SOURCE_QUALITY), mime="image/jpeg")



# A whole-photo edit the provider declines can pass as a head-and-shoulders
# crop of the same photo. Measured on 2026-09-25 against gemini-3.1-flash-image:
# every prompt on one full-frame portrait was blocked at the prompt
# (promptFeedback OTHER), and the same face cropped to 2.2 face widths was
# edited under the same prompts; at 2.8 it was blocked again. So a declined
# regenerate or stylise is asked once more with this crop: a different
# input, never the same request repeated.
FALLBACK_FACE_WIDTHS = 2.2


def head_crop_fallback(
    data: bytes, mode: str, face_type: str, style: str | None = None
) -> Prepared | None:
    """The same request on a head-and-shoulders crop, or None when there is
    no face to crop around (animals, a missing detector) or the mode already
    works on a crop (touch-up). CPU work."""
    from app.services import imagegen, landmarks

    if mode == TOUCHUP:
        return None
    image = _rgb(data)
    try:
        points = _detect(image)
    except landmarks.LandmarkerUnavailable:
        return None
    if points is None:
        return None
    x0, y0, side = face_crop_box(points)
    cx, cy = x0 + side / 2, y0 + side / 2
    width = side / CROP_SCALE * FALLBACK_FACE_WIDTHS
    # More room below the face than above: shoulders, not sky.
    box = (
        max(0.0, cx - width / 2),
        max(0.0, cy - width / 2.4),
        min(float(image.width), cx + width / 2),
        min(float(image.height), cy + width * 0.75),
    )
    crop = image.crop(tuple(int(round(v)) for v in box))
    if crop.size == image.size:
        # The crop box reaches every edge: it is the same picture, and asking
        # again would be the same request. Anything smaller is worth the one
        # retry: a crop trimming 2% off that declined portrait was accepted.
        return None
    if max(crop.size) > SOURCE_MAX_EDGE:
        crop.thumbnail((SOURCE_MAX_EDGE, SOURCE_MAX_EDGE), Image.Resampling.LANCZOS)
    whole = prepare(data, mode, face_type, style)
    return Prepared(
        prompt=whole.prompt,
        payload=_jpeg(crop, imagegen.SOURCE_QUALITY),
        mime="image/jpeg",
    )

# --- Colour ---------------------------------------------------------------------

_D65 = np.array([0.95047, 1.0, 1.08883])
_RGB_TO_XYZ = np.array(
    [[0.4124564, 0.3575761, 0.1804375],
     [0.2126729, 0.7151522, 0.0721750],
     [0.0193339, 0.1191920, 0.9503041]]
)
_XYZ_TO_RGB = np.linalg.inv(_RGB_TO_XYZ)


def rgb_to_lab(rgb: np.ndarray) -> np.ndarray:
    """sRGB (0-255, any shape ending in 3) to CIE LAB (D65)."""
    c = np.asarray(rgb, dtype=np.float64) / 255.0
    linear = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    xyz = linear @ _RGB_TO_XYZ.T / _D65
    f = np.where(xyz > (6 / 29) ** 3, np.cbrt(xyz), xyz / (3 * (6 / 29) ** 2) + 4 / 29)
    return np.stack(
        (116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]), 200 * (f[..., 1] - f[..., 2])),
        axis=-1,
    )


def lab_to_rgb(lab: np.ndarray) -> np.ndarray:
    """CIE LAB (D65) to sRGB 0-255 floats, clipped."""
    lab = np.asarray(lab, dtype=np.float64)
    fy = (lab[..., 0] + 16) / 116
    fx = fy + lab[..., 1] / 500
    fz = fy - lab[..., 2] / 200
    f = np.stack((fx, fy, fz), axis=-1)
    xyz = np.where(f > 6 / 29, f ** 3, 3 * (6 / 29) ** 2 * (f - 4 / 29)) * _D65
    linear = np.clip(xyz @ _XYZ_TO_RGB.T, 0.0, 1.0)
    c = np.where(linear <= 0.0031308, linear * 12.92, 1.055 * linear ** (1 / 2.4) - 0.055)
    return np.clip(c * 255.0, 0.0, 255.0)


def delta_e(a: np.ndarray, b: np.ndarray, l_weight: float = 1.0) -> float:
    d = np.asarray(a, dtype=np.float64) - np.asarray(b, dtype=np.float64)
    return float(math.sqrt((l_weight * d[0]) ** 2 + d[1] ** 2 + d[2] ** 2))


# --- Geometry -------------------------------------------------------------------


def similarity_transform(src: np.ndarray, dst: np.ndarray) -> np.ndarray:
    """The 2x3 similarity (scale, rotation, translation) taking `src` onto
    `dst` in the least-squares sense (Umeyama). No reflection."""
    src = np.asarray(src, dtype=np.float64)
    dst = np.asarray(dst, dtype=np.float64)
    mu_s, mu_d = src.mean(axis=0), dst.mean(axis=0)
    xs, xd = src - mu_s, dst - mu_d
    var_s = float((xs ** 2).sum()) / len(src)
    if var_s <= 0:
        raise ValueError("degenerate landmarks")
    u, s, vt = np.linalg.svd(xd.T @ xs / len(src))
    d = np.eye(2)
    if np.linalg.det(u) * np.linalg.det(vt) < 0:
        d[1, 1] = -1
    rotation = u @ d @ vt
    scale = float(np.trace(np.diag(s) @ d)) / var_s
    translation = mu_d - scale * rotation @ mu_s
    return np.hstack((scale * rotation, translation[:, None]))


def apply(matrix: np.ndarray, points: np.ndarray) -> np.ndarray:
    return np.asarray(points, dtype=np.float64) @ matrix[:, :2].T + matrix[:, 2]


def _invert(matrix: np.ndarray) -> np.ndarray:
    full = np.vstack((matrix, [0.0, 0.0, 1.0]))
    return np.linalg.inv(full)[:2]


def align(result_points: np.ndarray, source_points: np.ndarray) -> tuple[np.ndarray, float]:
    """(matrix result→photo, RMS residual in photo pixels), from the stable
    landmarks. One trimming pass drops the few a model moved anyway (a
    strand of hair over the brow shifts the oval there)."""
    src = result_points[STABLE]
    dst = source_points[STABLE]
    matrix = similarity_transform(src, dst)
    residual = np.linalg.norm(apply(matrix, src) - dst, axis=1)
    keep = residual <= max(2.5 * float(np.median(residual)), 1.0)
    if keep.sum() >= 6 and not keep.all():
        matrix = similarity_transform(src[keep], dst[keep])
        residual = np.linalg.norm(apply(matrix, src[keep]) - dst[keep], axis=1)
    return matrix, float(np.sqrt(np.mean(residual ** 2)))


def _hull_mask(shape: tuple[int, int], polygons: list[np.ndarray]) -> np.ndarray:
    """Union of the convex hulls of `polygons` (pixel coords of the window)."""
    from scipy.spatial import ConvexHull, QhullError

    hulls = []
    for pts in polygons:
        try:
            hulls.append(pts[ConvexHull(pts).vertices])
        except (QhullError, ValueError):
            hulls.append(pts)
    return _polygon_mask(shape, hulls)


def _polygon_mask(shape: tuple[int, int], polygons: list[np.ndarray]) -> np.ndarray:
    """Union of `polygons` as drawn, in their point order (a contour, not
    its hull)."""
    from PIL import ImageDraw

    canvas = Image.new("L", (shape[1], shape[0]), 0)
    draw = ImageDraw.Draw(canvas)
    for pts in polygons:
        if len(pts) >= 3:
            draw.polygon([tuple(p) for p in np.asarray(pts).tolist()], fill=255)
    return np.asarray(canvas) > 0


def _smoothstep(t: np.ndarray) -> np.ndarray:
    t = np.clip(t, 0.0, 1.0)
    return t * t * (3 - 2 * t)


# Scales a median absolute deviation to the standard deviation of the same
# data if it were Gaussian.
_MAD_TO_STD = 1.4826


def _grain(luma: np.ndarray, where: np.ndarray) -> float:
    """Grain: the spread of what a 1-pixel blur removes, over `where`.

    Robust (the MAD, scaled to a standard deviation), because the ring is
    mostly skin but not only: a few hairs, a lash or a mole leave large
    high-pass values that a plain standard deviation would read as heavy
    grain, and white noise of that size would then speckle the whole patch.
    Sensor grain is the bulk of the distribution, which the median keeps.
    """
    from scipy.ndimage import gaussian_filter

    if where.sum() < 16:
        return 0.0
    detail = (luma - gaussian_filter(luma, 1.0))[where]
    return float(_MAD_TO_STD * np.median(np.abs(detail - np.median(detail))))


def _antialiased(result: Image.Image, to_result: np.ndarray) -> Image.Image:
    """The answer, low-passed for the shrink `to_result` makes (answer pixels
    per photo pixel) when it shrinks at all.

    The warp is a fixed 4-tap bicubic, which does not average: shrinking a
    1024 px answer onto a small face samples its finest detail (lashes, iris
    texture) instead of averaging it, and the pasted eyes come out jagged,
    sparkling and crisper than the upscaled face around them. The blur
    brings the answer to the softness a shrink by that factor should have
    (a Gaussian of half a destination pixel, less the half a source pixel
    the answer already has).
    """
    from scipy.ndimage import gaussian_filter

    scale = math.sqrt(abs(float(np.linalg.det(to_result[:, :2]))))
    if scale <= 1.0:
        return result
    sigma = 0.5 * math.sqrt(scale * scale - 1.0)
    if sigma < 0.2:
        return result
    blurred = gaussian_filter(np.asarray(result, dtype=np.float64), sigma=(sigma, sigma, 0))
    return Image.fromarray(np.clip(blurred, 0, 255).round().astype(np.uint8))


@dataclass
class Region:
    name: str
    source: np.ndarray  # landmark positions in the photo
    result: np.ndarray  # the answer's landmarks, mapped into the photo
    dilate: float
    feather: float
    # Contours never pasted onto nor measured on (the brows, for an eye),
    # in the photo and where the answer has them.
    keep_out: tuple[np.ndarray, ...] = ()
    # Hulls the colour ring must lie inside, every one of them (the face
    # ovals, for the lips): skin both images agree is skin.
    within: tuple[np.ndarray, ...] = ()


def _paste_region(
    out: np.ndarray,
    source_rgb: np.ndarray,
    result: Image.Image,
    to_result: np.ndarray,
    region: Region,
    rng: np.random.Generator,
) -> None:
    """Blend one region of the aligned answer into `out`, in place."""
    from scipy.ndimage import distance_transform_edt

    both = np.vstack((region.source, region.result))
    size = float(max(np.ptp(both[:, 0]), np.ptp(both[:, 1]), 1.0))
    dilate, feather = region.dilate * size, max(region.feather * size, 1.0)
    ring = max(RING_WIDTH * size, 3.0)
    reach = dilate + feather + ring + 2
    height, width = out.shape[:2]
    x0 = max(0, int(math.floor(both[:, 0].min() - reach)))
    y0 = max(0, int(math.floor(both[:, 1].min() - reach)))
    x1 = min(width, int(math.ceil(both[:, 0].max() + reach)))
    y1 = min(height, int(math.ceil(both[:, 1].max() + reach)))
    if x1 - x0 < 2 or y1 - y0 < 2:
        return
    window = (y1 - y0, x1 - x0)

    # The answer, resampled onto this window of the photo's pixel grid.
    shift = np.array([[1.0, 0.0, x0], [0.0, 1.0, y0]])
    m = to_result @ np.vstack((shift, [0.0, 0.0, 1.0]))
    coeffs = (m[0, 0], m[0, 1], m[0, 2], m[1, 0], m[1, 1], m[1, 2])
    warped = np.asarray(
        result.transform((window[1], window[0]), Image.Transform.AFFINE, coeffs,
                         resample=Image.Resampling.BICUBIC),
        dtype=np.float64,
    )
    covered = np.asarray(
        Image.new("L", result.size, 255).transform(
            (window[1], window[0]), Image.Transform.AFFINE, coeffs,
            resample=Image.Resampling.BILINEAR,
        ),
        dtype=np.float64,
    ) / 255.0

    offset = np.array([x0, y0])
    hull = _hull_mask(window, [region.source - offset, region.result - offset])
    distance = distance_transform_edt(~hull)
    alpha = 1.0 - _smoothstep((distance - dilate) / feather)
    alpha *= np.clip((covered - 0.99) * 100.0, 0.0, 1.0)  # fully inside the answer only
    ring_mask = (distance > dilate + feather) & (distance <= dilate + feather + ring) & (
        covered > 0.999
    )
    if region.keep_out:
        # Nothing of the answer lands on a brow, fading in over BROW_GUARD
        # of the region's size, and the brow is not skin to measure.
        outside = _polygon_mask(window, [p - offset for p in region.keep_out])
        guard = max(BROW_GUARD * size, 1.0)
        clear = distance_transform_edt(~outside)
        alpha *= _smoothstep(clear / guard)
        ring_mask &= clear > guard
    for polygon in region.within:
        ring_mask &= _hull_mask(window, [polygon - offset])
    if not alpha.any():
        return

    original = source_rgb[y0:y1, x0:x1].astype(np.float64)
    source_lab = rgb_to_lab(original)
    result_lab = rgb_to_lab(warped)
    if ring_mask.sum() >= 16:
        # The model relights what it redraws; the ring around the region is
        # skin both images should agree on, so their difference there is
        # the correction. The median, so a stray hair or shadow in the ring
        # does not shift the whole patch.
        result_lab = result_lab + (
            np.median(source_lab[ring_mask], axis=0) - np.median(result_lab[ring_mask], axis=0)
        )
        # Grain: a phone photo is noisier than a model's output. Add the
        # missing noise to lightness, so the patch does not read as smooth.
        missing = _grain(source_lab[..., 0], ring_mask) ** 2 - _grain(
            result_lab[..., 0], ring_mask
        ) ** 2
        if missing > 0:
            result_lab[..., 0] += rng.normal(0.0, math.sqrt(missing), size=window)
    matched = lab_to_rgb(result_lab)
    # Composited over what earlier regions already wrote (they never overlap
    # on a face, but a very small face could make them touch). Where alpha
    # is 0 the pixel is left exactly as it was, not re-rounded.
    below = out[y0:y1, x0:x1].astype(np.float64)
    blended = below * (1 - alpha[..., None]) + matched * alpha[..., None]
    out[y0:y1, x0:x1] = np.where(
        alpha[..., None] > 0, np.clip(blended, 0, 255).round(), below
    ).astype(np.uint8)


def jaw_shift(source_points: np.ndarray, mapped: np.ndarray) -> float:
    """How far the answer's chin sits from the photo's once aligned, as a
    fraction of the face height (the median over the chin landmarks)."""
    height = float(np.ptp(source_points[:, 1])) or 1.0
    moved = np.linalg.norm(mapped[CHIN] - source_points[CHIN], axis=1)
    return float(np.median(moved)) / height


def paste_back(
    source: Image.Image,
    source_points: np.ndarray,
    result: Image.Image,
    result_points: np.ndarray,
) -> Image.Image:
    """The photo with only the answer's eye and lip regions pasted in.

    Raises AdjustSkipped("alignment_failed") when the stable landmarks do not
    agree: the model moved or reshaped the face, and a paste would put eyes
    beside the eyes. Raises AdjustSkipped("jaw_moved") when the answer's
    chin is not where the photo's is: closed lips pasted above a dropped
    chin make a face longer than the person's.
    """
    matrix, residual = align(result_points, source_points)
    face_width = float(np.ptp(source_points[:, 0])) or 1.0
    if residual > MAX_ALIGN_RESIDUAL * face_width:
        raise AdjustSkipped(
            "alignment_failed",
            "The AI moved the face too much to put its eyes and lips back onto the photo",
        )
    mapped = apply(matrix, result_points)
    if jaw_shift(source_points, mapped) > MAX_JAW_SHIFT:
        raise AdjustSkipped(
            "jaw_moved",
            "Closing the mouth moved the jaw, so new lips would not fit this photo; "
            "regenerate it instead",
        )
    to_result = _invert(matrix)
    source_rgb = np.asarray(source.convert("RGB"))
    out = source_rgb.copy()
    rng = np.random.default_rng(int(source_points[NOSE_TIP].sum() * 1000) % (2 ** 32))
    answer = _antialiased(result.convert("RGB"), to_result)
    ovals = (source_points[FACE_OVAL], mapped[FACE_OVAL])
    for region in (
        Region("eye_left", source_points[EYE_IMAGE_LEFT], mapped[EYE_IMAGE_LEFT],
               EYE_DILATE, EYE_FEATHER,
               keep_out=(source_points[BROW_IMAGE_LEFT], mapped[BROW_IMAGE_LEFT])),
        Region("eye_right", source_points[EYE_IMAGE_RIGHT], mapped[EYE_IMAGE_RIGHT],
               EYE_DILATE, EYE_FEATHER,
               keep_out=(source_points[BROW_IMAGE_RIGHT], mapped[BROW_IMAGE_RIGHT])),
        Region("lips", source_points[LIPS], mapped[LIPS], LIP_DILATE, LIP_FEATHER,
               within=ovals),
    ):
        _paste_region(out, source_rgb, answer, to_result, region, rng)
    return Image.fromarray(out)


# --- Checks ---------------------------------------------------------------------


def cheek_colour(image: Image.Image, points: np.ndarray) -> np.ndarray | None:
    """Mean LAB colour over both cheeks, or None if they cover no pixels."""
    rgb = np.asarray(image.convert("RGB"))
    mask = _hull_mask(rgb.shape[:2], [points[CHEEK_IMAGE_LEFT], points[CHEEK_IMAGE_RIGHT]])
    if mask.sum() < 16:
        return None
    return rgb_to_lab(rgb[mask].astype(np.float64)).mean(axis=0)


def skin_drift(
    source: Image.Image, source_points: np.ndarray | None,
    candidate: Image.Image, candidate_points: np.ndarray | None,
) -> float | None:
    """Delta E (lightness at half weight) between the two cheek colours, or
    None when either face was not found."""
    if source_points is None or candidate_points is None:
        return None
    before = cheek_colour(source, source_points)
    after = cheek_colour(candidate, candidate_points)
    if before is None or after is None:
        return None
    return delta_e(before, after, SKIN_L_WEIGHT)


@dataclass
class Candidate:
    """One answer, as offered to the owner: the stored image (None when
    there is nothing to show) and, when it failed a check, why."""

    png: bytes | None
    width: int = 0
    height: int = 0
    rejected: dict | None = None
    generated_eyes: bool = False
    checks: dict = field(default_factory=dict)
    # A touch-up of a cut-out is a cut-out: transparent where the source was.
    cutout: bool = False


def _png(image: Image.Image) -> bytes:
    from app.services.photo_io import png_bytes

    return png_bytes(image)


def _checked(
    image: Image.Image,
    mode: str,
    face_type: str,
    source: Image.Image,
    source_points: np.ndarray | None,
    generated_eyes: bool,
) -> Candidate:
    """Run the checks on a candidate image and package it."""
    from app.services.creations import detect_anchors

    png = _png(image)
    candidate = Candidate(png, image.width, image.height, generated_eyes=generated_eyes)
    # The line the result will be rigged on: a stylised person is animation.
    line = "cartoon" if mode == STYLISE else face_type
    if line in ("human", "cartoon"):
        try:
            found = detect_anchors(png, line)
        except Exception:
            logger.exception("checking a candidate failed")
            candidate.rejected = reason("check_failed", "The result could not be checked")
            return candidate
        candidate.checks["detected"] = found["detected"]
        if not found["detected"]:
            candidate.rejected = reason("no_face_in_result", "No face was found in the result")
            return candidate
        validation = found["validation"]
        candidate.checks["fit_ok"] = validation["ok"]
        if not validation["ok"]:
            details = "; ".join(r["detail"] for r in validation["reasons"])
            candidate.rejected = reason(
                "fit_invalid", f"The result's face would not rig cleanly: {details}"
            )
            return candidate
        if line == "human":
            from app.services.photo_io import on_backdrop

            # Like with like: the source is judged on the grey the model
            # saw, so a cut-out candidate is too (not on the black under
            # its alpha 0).
            drift = skin_drift(
                source, source_points, on_backdrop(image), np.asarray(found["base"])
            )
            if drift is not None:
                candidate.checks["skin_delta_e"] = round(drift, 1)
                if drift > MAX_SKIN_DELTA_E:
                    candidate.rejected = reason(
                        "skin_tone_changed", "The result changed the skin tone"
                    )
    return candidate


def finish_candidate(
    data: bytes, prepared: Prepared, answer: bytes, mode: str, face_type: str
) -> Candidate:
    """Turn a provider answer into a checked candidate. CPU work."""
    source = _rgb(data)
    try:
        with Image.open(io.BytesIO(answer)) as decoded:
            result = decoded.convert("RGB")
    except Exception:
        return Candidate(
            None, rejected=reason("unreadable_result", "The AI returned no usable image")
        )

    if mode == TOUCHUP:
        try:
            result_points = _detect(result)
        except Exception:
            logger.exception("detecting the touch-up answer failed")
            result_points = None
        if result_points is None:
            return Candidate(
                None, rejected=reason("no_face_in_result", "No face was found in the result")
            )
        alpha = _alpha(data)
        try:
            # Into the image's own pixels, not the grey composite the model
            # saw: outside the eyes and lips a cut-out stays bit-identical.
            image = paste_back(
                _own_rgb(data) if alpha is not None else source,
                prepared.source_points, result, result_points,
            )
        except AdjustSkipped as exc:
            return Candidate(None, rejected=reason(exc.code, exc.detail))
        if alpha is not None:
            # A cut-out stays a cut-out: only eyes and lips were touched,
            # and they are inside the opaque face. The alpha is the source's.
            image = image.convert("RGBA")
            image.putalpha(alpha)
        candidate = _checked(
            image, mode, face_type, source, prepared.source_points, prepared.generated_eyes
        )
        candidate.cutout = alpha is not None
        return candidate

    if max(result.size) > STORED_MAX_EDGE:
        result.thumbnail((STORED_MAX_EDGE, STORED_MAX_EDGE), Image.Resampling.LANCZOS)
    source_points = None
    if face_type == "human":
        try:
            source_points = _detect(source)
        except Exception:
            source_points = None
    return _checked(result, mode, face_type, source, source_points, False)


def generation_prompt(style: str, face_type: str, prompt: str, has_source: bool) -> str:
    """The prompt for a creation made by generation (POST /creations/generate).

    A person keeps imagegen's portrait prompt, which states the rig's needs.
    An animal or a character is asked for in the same terms, since the rig
    needs the same things of them: frontal, both eyes, mouth closed.
    """
    from app.services import imagegen

    if face_type == "human":
        return imagegen.build_prompt(style, has_source, prompt)
    look = imagegen.STYLES.get(style, imagegen.STYLES["photoreal"])
    noun = "animal" if face_type == "animal" else "character"
    if has_source:
        head = (
            f"Redraw the {noun} in this picture as {look}. Keep it the same {noun}: "
            "same colours, markings and proportions. "
        )
    else:
        head = f"Create {look} of {'an' if noun == 'animal' else 'a'} {noun}. "
    needs = (
        "Facing the camera directly, both eyes clearly visible, mouth closed, the whole "
        "head inside the frame with space around it and filling roughly half the image "
        "width, on a plain, uncluttered, evenly lit backdrop. No text, no watermark, no "
        "objects in front of the face."
    )
    note = f" {prompt.strip()}" if prompt.strip() else ""
    return f"{head}{needs}{note}"
