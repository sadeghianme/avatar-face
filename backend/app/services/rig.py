"""Avatar rigging pipeline.

Input: an uploaded portrait image. Output: a rig JSON (v3) + 256px thumbnail
stored in object storage.

Landmarking uses MediaPipe FaceLandmarker (478 points + 52 ARKit blendshapes)
when RIG_MODEL_PATH points at a .task model. When it finds no face, animals
and cartoons start from the face template (services.face_template) and
humans from a synthetic frontal mesh with valid topology, so the whole flow
works with zero setup.

Rig JSON (v3) schema:
{
  "version": 3,
  "image_size": [w, h],
  "face_box": [x0, y0, x1, y1],
  "points": [[x, y], ...]            # 478, image pixel coords
  "triangles": [[a, b, c], ...],     # Delaunay over the points
  "mouth_indices": [...],            # canonical MediaPipe lips set
  "inner_lip_ring": [...],           # ordered inner-lip loop (for the cavity clip)
  "visemes": {"sil": {...}, "aa": {...}, ...}   # 15 Oculus visemes ->
        {"jawOpen": f, "mouthClose": f, "mouthPucker": f, "mouthFunnel": f,
         "mouthStretch": f, "mouthSmile": f}
  "blendshapes": {...} | null        # neutral ARKit weights when MediaPipe ran
  "user_anchors": {...}              # after a fit: the owner's marks (anchor_fit)
  "render_profile": "animal@1"       # after an animal fit; absent = today's renderer
}

The mesh fits start from is not in here: it is stored beside the rig as
fit-base.json (services.anchor_fit), because this file is published.
"""
from __future__ import annotations

import io
import logging
import math

import numpy as np
from PIL import Image
from scipy.spatial import Delaunay

from app.core.config import get_settings
from app.services import face_template, landmarks
from app.services.photo_io import has_alpha, png_bytes

logger = logging.getLogger("liveface.rig")


class NoFaceDetected(Exception):
    """The image has no usable face. Distinguished from a crash so the user
    gets an instruction instead of a stack trace in `error`."""

RIG_VERSION = 3
NUM_LANDMARKS = 478
THUMBNAIL_SIZE = 256

# 15 Oculus visemes
OCULUS_VISEMES = [
    "sil", "PP", "FF", "TH", "DD", "kk", "CH", "SS",
    "nn", "RR", "aa", "E", "ih", "oh", "ou",
]

# Per-viseme ARKit blendshape weights (rig v3) — drives the 2D deformation
# basis in the canvas engine.
VISEME_BLENDSHAPES: dict[str, dict[str, float]] = {
    "sil": {"jawOpen": 0.0, "mouthClose": 0.1, "mouthPucker": 0.0, "mouthFunnel": 0.0, "mouthStretch": 0.0, "mouthSmile": 0.02},
    "PP":  {"jawOpen": 0.05, "mouthClose": 0.9, "mouthPucker": 0.25, "mouthFunnel": 0.0, "mouthStretch": 0.0, "mouthSmile": 0.0},
    "FF":  {"jawOpen": 0.1, "mouthClose": 0.55, "mouthPucker": 0.0, "mouthFunnel": 0.1, "mouthStretch": 0.25, "mouthSmile": 0.0},
    "TH":  {"jawOpen": 0.25, "mouthClose": 0.2, "mouthPucker": 0.0, "mouthFunnel": 0.15, "mouthStretch": 0.2, "mouthSmile": 0.0},
    "DD":  {"jawOpen": 0.3, "mouthClose": 0.15, "mouthPucker": 0.0, "mouthFunnel": 0.1, "mouthStretch": 0.25, "mouthSmile": 0.05},
    "kk":  {"jawOpen": 0.35, "mouthClose": 0.1, "mouthPucker": 0.0, "mouthFunnel": 0.1, "mouthStretch": 0.2, "mouthSmile": 0.0},
    "CH":  {"jawOpen": 0.25, "mouthClose": 0.1, "mouthPucker": 0.35, "mouthFunnel": 0.4, "mouthStretch": 0.0, "mouthSmile": 0.0},
    "SS":  {"jawOpen": 0.15, "mouthClose": 0.2, "mouthPucker": 0.0, "mouthFunnel": 0.05, "mouthStretch": 0.45, "mouthSmile": 0.25},
    "nn":  {"jawOpen": 0.2, "mouthClose": 0.25, "mouthPucker": 0.0, "mouthFunnel": 0.05, "mouthStretch": 0.2, "mouthSmile": 0.05},
    "RR":  {"jawOpen": 0.25, "mouthClose": 0.1, "mouthPucker": 0.3, "mouthFunnel": 0.3, "mouthStretch": 0.0, "mouthSmile": 0.0},
    "aa":  {"jawOpen": 0.85, "mouthClose": 0.0, "mouthPucker": 0.0, "mouthFunnel": 0.1, "mouthStretch": 0.2, "mouthSmile": 0.05},
    "E":   {"jawOpen": 0.45, "mouthClose": 0.0, "mouthPucker": 0.0, "mouthFunnel": 0.0, "mouthStretch": 0.5, "mouthSmile": 0.35},
    "ih":  {"jawOpen": 0.3, "mouthClose": 0.05, "mouthPucker": 0.0, "mouthFunnel": 0.0, "mouthStretch": 0.45, "mouthSmile": 0.3},
    "oh":  {"jawOpen": 0.6, "mouthClose": 0.0, "mouthPucker": 0.5, "mouthFunnel": 0.55, "mouthStretch": 0.0, "mouthSmile": 0.0},
    "ou":  {"jawOpen": 0.35, "mouthClose": 0.05, "mouthPucker": 0.85, "mouthFunnel": 0.6, "mouthStretch": 0.0, "mouthSmile": 0.0},
}

# A muzzle is a jaw, not a pair of lips.
#
# Every shape above is a human mouth: "oo" purses, "oh" funnels, "ee" spreads
# the corners. A dog or a cat has none of that machinery — the mouth is a
# hinge that opens along the snout, and driving it with pucker and funnel
# produces the rubbery, human-lipped look that gives away a talking-animal
# effect. So the vowels here are separated by how far the jaw drops rather
# than by lip rounding, pucker and funnel are zero throughout, and the
# closures (PP, and the nasals) stay firm because animals do close their
# mouths completely.
#
# Same keys, same engine, different numbers: nothing downstream knows which
# table it was handed.
ANIMAL_VISEME_BLENDSHAPES: dict[str, dict[str, float]] = {
    "sil": {"jawOpen": 0.0, "mouthClose": 0.1, "mouthPucker": 0.0, "mouthFunnel": 0.0, "mouthStretch": 0.0, "mouthSmile": 0.0},
    "PP":  {"jawOpen": 0.02, "mouthClose": 0.95, "mouthPucker": 0.0, "mouthFunnel": 0.0, "mouthStretch": 0.0, "mouthSmile": 0.0},
    "FF":  {"jawOpen": 0.12, "mouthClose": 0.5, "mouthPucker": 0.0, "mouthFunnel": 0.0, "mouthStretch": 0.15, "mouthSmile": 0.0},
    "TH":  {"jawOpen": 0.3, "mouthClose": 0.1, "mouthPucker": 0.0, "mouthFunnel": 0.0, "mouthStretch": 0.12, "mouthSmile": 0.0},
    "DD":  {"jawOpen": 0.35, "mouthClose": 0.08, "mouthPucker": 0.0, "mouthFunnel": 0.0, "mouthStretch": 0.12, "mouthSmile": 0.0},
    "kk":  {"jawOpen": 0.45, "mouthClose": 0.05, "mouthPucker": 0.0, "mouthFunnel": 0.0, "mouthStretch": 0.08, "mouthSmile": 0.0},
    "CH":  {"jawOpen": 0.3, "mouthClose": 0.08, "mouthPucker": 0.0, "mouthFunnel": 0.0, "mouthStretch": 0.06, "mouthSmile": 0.0},
    "SS":  {"jawOpen": 0.18, "mouthClose": 0.15, "mouthPucker": 0.0, "mouthFunnel": 0.0, "mouthStretch": 0.3, "mouthSmile": 0.05},
    "nn":  {"jawOpen": 0.22, "mouthClose": 0.28, "mouthPucker": 0.0, "mouthFunnel": 0.0, "mouthStretch": 0.1, "mouthSmile": 0.0},
    "RR":  {"jawOpen": 0.3, "mouthClose": 0.06, "mouthPucker": 0.0, "mouthFunnel": 0.0, "mouthStretch": 0.06, "mouthSmile": 0.0},
    "aa":  {"jawOpen": 0.95, "mouthClose": 0.0, "mouthPucker": 0.0, "mouthFunnel": 0.0, "mouthStretch": 0.15, "mouthSmile": 0.0},
    "E":   {"jawOpen": 0.55, "mouthClose": 0.0, "mouthPucker": 0.0, "mouthFunnel": 0.0, "mouthStretch": 0.35, "mouthSmile": 0.1},
    "ih":  {"jawOpen": 0.35, "mouthClose": 0.04, "mouthPucker": 0.0, "mouthFunnel": 0.0, "mouthStretch": 0.3, "mouthSmile": 0.08},
    "oh":  {"jawOpen": 0.7, "mouthClose": 0.0, "mouthPucker": 0.0, "mouthFunnel": 0.0, "mouthStretch": 0.05, "mouthSmile": 0.0},
    "ou":  {"jawOpen": 0.45, "mouthClose": 0.05, "mouthPucker": 0.0, "mouthFunnel": 0.0, "mouthStretch": 0.0, "mouthSmile": 0.0},
}

# Human is the default and its table is the original, untouched: an existing
# avatar must animate exactly as it did before face types existed.
VISEME_PROFILES: dict[str, dict[str, dict[str, float]]] = {
    "human": VISEME_BLENDSHAPES,
    "cartoon": VISEME_BLENDSHAPES,
    "animal": ANIMAL_VISEME_BLENDSHAPES,
}


# Canonical MediaPipe FaceMesh lip landmark indices.
OUTER_LIP_RING = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291,
                  409, 270, 269, 267, 0, 37, 39, 40, 185]
INNER_LIP_RING = [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308,
                  415, 310, 311, 312, 13, 82, 81, 80, 191]
MOUTH_INDICES = sorted(set(OUTER_LIP_RING + INNER_LIP_RING))


def landmarks_from_image(
    data: bytes,
) -> tuple[np.ndarray, dict[str, float] | None, tuple[int, int], bool]:
    """Return (points[478,2] in pixel coords, blendshapes|None, (w,h), detected).

    `detected` is the important one. This falls back to a synthetic mesh when
    MediaPipe finds nothing, and that mesh is perfectly proportioned — every
    caller downstream is happy, and the avatar ships "ready" with a mouth
    moving in empty space. Callers have to be able to tell the difference, so
    it is returned rather than left to be guessed at.
    """
    image = Image.open(io.BytesIO(data)).convert("RGB")
    width, height = image.size

    model_path = get_settings().rig_model_path
    if model_path:
        try:
            return landmarks.detect_points(image), None, (width, height), True
        except Exception:
            # Broad on purpose: no face (ValueError) or the detector's own
            # runtime failure; either way the synthetic mesh stands in.
            logger.exception("MediaPipe landmarking failed; using synthetic mesh")

    points = synthetic_face_mesh(width, height)
    return points, None, (width, height), False


# Lines whose undetected faces start from the face template rather than the
# synthetic mesh. Human keeps the synthetic mesh: the stock portraits are
# drawn to its exact proportions (see services.stock), and without a model
# installed they are rigged from it.
TEMPLATE_FACE_TYPES = frozenset({"animal", "cartoon"})


def template_mesh(size: tuple[int, int]) -> np.ndarray:
    """The face template where an undetected face is assumed to be."""
    return face_template.place(face_template.default_box(*size))


def starting_mesh(
    points: np.ndarray, size: tuple[int, int], detected: bool, face_type: str
) -> np.ndarray:
    """The mesh a first build rigs.

    A detection stands. Without one, an animal or a cartoon gets the face
    template: its owner has to mark it before it goes live, and the template
    is what the marking panel and the fit understand.
    """
    if detected or face_type not in TEMPLATE_FACE_TYPES:
        return points
    return template_mesh(size)


def fit_base_mesh(points: np.ndarray, size: tuple[int, int], detected: bool) -> np.ndarray:
    """The mesh every fit starts from (services.anchor_fit): the detection,
    else the template — for every line, humans included.

    The fit pins marks to specific landmarks (61 the left mouth corner, 33
    the outer corner of the image-left eye) and warps everything else with
    them, which only works on a mesh that is a face throughout. The
    synthetic mesh is not: its lip and eye rings run the other way round
    and its other points are filler, so an undetected human that is marked
    by hand is fitted from the template too.
    """
    return points if detected else template_mesh(size)


def synthetic_face_mesh(width: int, height: int) -> np.ndarray:
    """A valid 478-point frontal mesh placed over the image center.

    Geometry matters for the canvas engine: the INNER_LIP_RING indices must
    land ON the mouth (otherwise the mouth-cavity clip paints across the
    face), the outer ring just outside it, eyes/brows/nose roughly where the
    canonical MediaPipe topology expects them, and the remaining points fill
    the face oval so Delaunay produces a sane triangulation.
    """
    rng = np.random.default_rng(42)  # deterministic
    cx, cy = width / 2, height * 0.46
    fw, fh = width * 0.32, height * 0.40  # face half-extents

    points = np.zeros((NUM_LANDMARKS, 2), dtype=np.float64)
    placed = np.zeros(NUM_LANDMARKS, dtype=bool)

    def put(idx: int, x: float, y: float) -> None:
        points[idx] = (x, y)
        placed[idx] = True

    # Mouth: ellipses centered below the nose.
    mouth_cx, mouth_cy = cx, cy + fh * 0.52
    mouth_w, mouth_h = fw * 0.42, fh * 0.10
    for ring, (rw, rh) in ((OUTER_LIP_RING, (mouth_w, mouth_h)),
                           (INNER_LIP_RING, (mouth_w * 0.62, mouth_h * 0.42))):
        n = len(ring)
        for i, idx in enumerate(ring):
            angle = 2 * math.pi * i / n
            put(idx, mouth_cx + rw * math.cos(angle), mouth_cy + rh * math.sin(angle))

    # Eyes (canonical-ish index clusters) + irises (468-477).
    for side, ex in ((-1, cx - fw * 0.42), (1, cx + fw * 0.42)):
        eye_idx = ([33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246]
                   if side < 0 else
                   [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466])
        ey = cy - fh * 0.18
        for i, idx in enumerate(eye_idx):
            angle = 2 * math.pi * i / len(eye_idx)
            put(idx, ex + fw * 0.14 * math.cos(angle), ey + fh * 0.05 * math.sin(angle))
        iris_base = 468 if side < 0 else 473
        put(iris_base, ex, ey)
        for j in range(1, 5):
            angle = 2 * math.pi * j / 4
            put(iris_base + j, ex + fw * 0.045 * math.cos(angle), ey + fh * 0.02 * math.sin(angle))

    # Brows (canonical rows, inner -> outer).
    for side, sign in ((-1, -1), (1, 1)):
        brow = [46, 53, 52, 65, 55] if side < 0 else [276, 283, 282, 295, 285]
        for i, idx in enumerate(brow):
            t = i / (len(brow) - 1)
            put(idx, cx + sign * fw * (0.55 - 0.38 * t), cy - fh * (0.34 + 0.04 * math.sin(t * math.pi)))

    # Nose line + tip.
    for i, idx in enumerate([168, 6, 197, 195, 5, 4]):
        put(idx, cx, cy - fh * 0.10 + (fh * 0.42) * i / 5)
    put(1, cx, cy + fh * 0.30)
    put(2, cx, cy + fh * 0.36)

    # Face oval (canonical 36-point silhouette).
    oval = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365,
            379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93,
            234, 127, 162, 21, 54, 103, 67, 109]
    for i, idx in enumerate(oval):
        angle = -math.pi / 2 + 2 * math.pi * i / len(oval)
        put(idx, cx + fw * math.sin(angle + math.pi), cy + fh * math.cos(angle + math.pi) * -1)

    # Fill the rest: jittered concentric rings inside the face oval.
    remaining = np.flatnonzero(~placed)
    n = len(remaining)
    for i, idx in enumerate(remaining):
        ring_t = 0.15 + 0.78 * (i / max(n - 1, 1))
        angle = 2.399963 * i  # golden angle: even angular coverage
        radius_jitter = 1.0 + rng.uniform(-0.03, 0.03)
        put(int(idx),
            cx + fw * ring_t * radius_jitter * math.cos(angle),
            cy + fh * ring_t * radius_jitter * math.sin(angle))

    return points


def build_rig(points: np.ndarray, image_size: tuple[int, int],
              blendshapes: dict[str, float] | None = None,
              face_type: str = "human") -> dict:
    """Build the rig. `face_type` only selects the viseme table — geometry,
    triangulation and every other field are identical for all types, and
    "human" is the default so existing callers are unaffected."""
    width, height = image_size
    xs, ys = points[:, 0], points[:, 1]
    face_box = [float(xs.min()), float(ys.min()), float(xs.max()), float(ys.max())]

    triangles = Delaunay(points).simplices.tolist()

    return {
        "version": RIG_VERSION,
        "image_size": [width, height],
        "face_box": face_box,
        "points": [[round(float(x), 2), round(float(y), 2)] for x, y in points],
        "triangles": triangles,
        "mouth_indices": MOUTH_INDICES,
        "inner_lip_ring": INNER_LIP_RING,
        "outer_lip_ring": OUTER_LIP_RING,
        "visemes": VISEME_PROFILES.get(face_type, VISEME_BLENDSHAPES),
        "blendshapes": blendshapes,
    }


def write_thumbnail_key(org_id: str, avatar_id: str, content_type: str) -> str:
    """Extension follows the format, so a cut-out does not keep a .jpg name."""
    ext = "png" if content_type == "image/png" else "jpg"
    return f"orgs/{org_id}/avatars/{avatar_id}/thumb.{ext}"


def make_thumbnail(data: bytes) -> tuple[bytes, str]:
    """Return (bytes, content_type).

    PNG when the source has an alpha channel, JPEG otherwise. This is not a
    detail: JPEG cannot store transparency at all, so a cut-out photo
    thumbnailed as JPEG comes back with its background composited onto black
    or white — the removal silently undone in every thumbnail.
    """
    image = Image.open(io.BytesIO(data))
    transparent = has_alpha(image)
    image = image.convert("RGBA" if transparent else "RGB")
    image.thumbnail((THUMBNAIL_SIZE, THUMBNAIL_SIZE) if max(image.size) > THUMBNAIL_SIZE
                    else image.size)
    # Keep aspect; the engine maps texture coords to naturalWidth/Height.
    if transparent:
        # Resampling blends colour into pixels it leaves fully transparent.
        return png_bytes(image), "image/png"
    out = io.BytesIO()
    image.save(out, format="JPEG", quality=88)
    return out.getvalue(), "image/jpeg"
