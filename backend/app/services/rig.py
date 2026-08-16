"""Avatar rigging pipeline.

Input: an uploaded portrait image. Output: a rig JSON (v3) + 256px thumbnail
stored in object storage.

Landmarking uses MediaPipe FaceLandmarker (478 points + 52 ARKit blendshapes)
when RIG_MODEL_PATH points at a .task model; otherwise a synthetic frontal
mesh with valid topology keeps the whole flow working with zero setup.

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
}
"""
from __future__ import annotations

import io
import json
import logging
import math

import numpy as np
from PIL import Image
from scipy.spatial import Delaunay

from app.core.config import get_settings
from app.services.riggable import check_landmarks

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
            return _mediapipe_landmarks(image), None, (width, height), True
        except Exception:
            logger.exception("MediaPipe landmarking failed; using synthetic mesh")

    points = synthetic_face_mesh(width, height)
    return points, None, (width, height), False


def _mediapipe_landmarks(image: Image.Image) -> np.ndarray:
    import mediapipe as mp
    from mediapipe.tasks import python as mp_python
    from mediapipe.tasks.python import vision

    options = vision.FaceLandmarkerOptions(
        base_options=mp_python.BaseOptions(model_asset_path=get_settings().rig_model_path),
        output_face_blendshapes=True,
        num_faces=1,
    )
    with vision.FaceLandmarker.create_from_options(options) as landmarker:
        mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=np.asarray(image))
        result = landmarker.detect(mp_image)
    if not result.face_landmarks:
        raise ValueError("no face detected")
    width, height = image.size
    points = np.array(
        [[lm.x * width, lm.y * height] for lm in result.face_landmarks[0]], dtype=np.float64
    )
    return points


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
        put(idx,
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
    transparent = image.mode in ("RGBA", "LA") or "transparency" in image.info
    image = image.convert("RGBA" if transparent else "RGB")
    image.thumbnail((THUMBNAIL_SIZE, THUMBNAIL_SIZE) if max(image.size) > THUMBNAIL_SIZE
                    else image.size)
    # Keep aspect; the engine maps texture coords to naturalWidth/Height.
    out = io.BytesIO()
    if transparent:
        image.save(out, format="PNG", optimize=True)
        return out.getvalue(), "image/png"
    image.save(out, format="JPEG", quality=88)
    return out.getvalue(), "image/jpeg"


async def process_avatar(avatar_id: str) -> None:
    """Background job: image -> landmarks -> rig JSON + thumbnail -> storage."""
    from sqlalchemy import select

    from app.db import get_session_factory
    from app.models import Avatar, AvatarStatus
    from app.services.storage import get_storage

    factory = get_session_factory()
    storage = get_storage()

    async with factory() as db:
        avatar = (await db.execute(select(Avatar).where(Avatar.id == avatar_id))).scalar_one_or_none()
        if avatar is None or avatar.image_key is None:
            return
        avatar.status = AvatarStatus.processing
        await db.commit()

        try:
            from app.models import AvatarKind
            from app.services.model3d import build_model_rig, make_model_thumbnail

            # Set before the branch: only the photo path computes one, and a
            # 3D avatar reaching the assignment below would raise.
            quality_note: str | None = None

            image_bytes = await storage.get_bytes(avatar.image_key)
            if avatar.kind == AvatarKind.model3d:
                rig = build_model_rig(image_bytes)
                thumb, thumb_type = make_model_thumbnail(), "image/jpeg"
            else:
                points, blendshapes, size, detected = landmarks_from_image(image_bytes)

                # An undetected face is NOT a failure: the synthetic fallback
                # mesh is a complete, well-proportioned 478-point rig (iris
                # ring included), which is exactly what the manual marking
                # panel needs as a starting point. Failing here used to dead-
                # end stylised art, mascots and animal faces that Mark the
                # face can rescue in a minute. The note tells the user the
                # mouth is a guess until they place it.
                animal = avatar.face_type == "animal"
                if get_settings().rig_model_path and not detected:
                    quality_note = (
                        "The muzzle could not be located automatically — no "
                        "detector is trained on animal faces. Open “Mark the "
                        "face” and place the head, eyes and mouth by hand."
                        if animal else
                        "No face was detected in this image, so the animation "
                        "points are a guess. Open “Mark the face” and place "
                        "the head, eyes, mouth and pupils by hand."
                    )
                elif animal:
                    # The riggable checks measure HUMAN proportions — face
                    # fraction, nose-offset frontality. A muzzle fails them
                    # for being a muzzle, and warning about that would be
                    # noise the user can do nothing with.
                    quality_note = None
                else:
                    verdict = check_landmarks(points, size, detected)
                    # Geometry problems are a warning, not a failure: the
                    # avatar works, it just will not look its best, and the
                    # thresholds are heuristics that should not veto a
                    # picture the user chose.
                    quality_note = None if verdict.ok else verdict.reason

                rig = build_rig(points, size, blendshapes, face_type=avatar.face_type)
                thumb, thumb_type = make_thumbnail(image_bytes)

            rig_key = f"orgs/{avatar.org_id}/avatars/{avatar.id}/rig.json"
            thumb_key = write_thumbnail_key(avatar.org_id, avatar.id, thumb_type)
            await storage.put_bytes(rig_key, json.dumps(rig).encode(), "application/json")
            await storage.put_bytes(thumb_key, thumb, thumb_type)

            avatar.rig_key = rig_key
            avatar.thumbnail_key = thumb_key
            avatar.status = AvatarStatus.ready
            avatar.error = None
            avatar.quality_note = quality_note

            # Layer decomposition, photo avatars only. Optional by contract:
            # a failure (no segmenter, odd geometry) leaves a working
            # single-photo avatar.
            avatar.has_layers = False
            if avatar.kind != AvatarKind.model3d and rig.get("face_box"):
                from app.services.layers import store_layers

                avatar.has_layers = await store_layers(
                    avatar, storage, image_bytes, rig["face_box"]
                )
        except NoFaceDetected as exc:
            # Expected, and the user can act on it — no stack trace.
            logger.info("no face in avatar %s", avatar_id)
            avatar.status = AvatarStatus.failed
            avatar.error = str(exc)
        except Exception as exc:
            logger.exception("rig pipeline failed for avatar %s", avatar_id)
            avatar.status = AvatarStatus.failed
            avatar.error = str(exc)[:1000]
        await db.commit()
