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

logger = logging.getLogger("liveface.rig")

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

# Canonical MediaPipe FaceMesh lip landmark indices.
OUTER_LIP_RING = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291,
                  409, 270, 269, 267, 0, 37, 39, 40, 185]
INNER_LIP_RING = [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308,
                  415, 310, 311, 312, 13, 82, 81, 80, 191]
MOUTH_INDICES = sorted(set(OUTER_LIP_RING + INNER_LIP_RING))


def landmarks_from_image(data: bytes) -> tuple[np.ndarray, dict[str, float] | None, tuple[int, int]]:
    """Return (points[478,2] in pixel coords, neutral blendshapes|None, (w,h)).

    Tries MediaPipe when configured; falls back to the synthetic mesh.
    """
    image = Image.open(io.BytesIO(data)).convert("RGB")
    width, height = image.size

    model_path = get_settings().rig_model_path
    if model_path:
        try:
            return _mediapipe_landmarks(image), None, (width, height)
        except Exception:
            logger.exception("MediaPipe landmarking failed; using synthetic mesh")

    points = synthetic_face_mesh(width, height)
    return points, None, (width, height)


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
              blendshapes: dict[str, float] | None = None) -> dict:
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
        "visemes": VISEME_BLENDSHAPES,
        "blendshapes": blendshapes,
    }


def make_thumbnail(data: bytes) -> bytes:
    image = Image.open(io.BytesIO(data)).convert("RGB")
    image.thumbnail((THUMBNAIL_SIZE, THUMBNAIL_SIZE) if max(image.size) > THUMBNAIL_SIZE
                    else image.size)
    # Keep aspect; the engine maps texture coords to naturalWidth/Height.
    out = io.BytesIO()
    image.save(out, format="JPEG", quality=88)
    return out.getvalue()


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

            image_bytes = await storage.get_bytes(avatar.image_key)
            if avatar.kind == AvatarKind.model3d:
                rig = build_model_rig(image_bytes)
                thumb = make_model_thumbnail()
            else:
                points, blendshapes, size = landmarks_from_image(image_bytes)
                rig = build_rig(points, size, blendshapes)
                thumb = make_thumbnail(image_bytes)

            rig_key = f"orgs/{avatar.org_id}/avatars/{avatar.id}/rig.json"
            thumb_key = f"orgs/{avatar.org_id}/avatars/{avatar.id}/thumb.jpg"
            await storage.put_bytes(rig_key, json.dumps(rig).encode(), "application/json")
            await storage.put_bytes(thumb_key, thumb, "image/jpeg")

            avatar.rig_key = rig_key
            avatar.thumbnail_key = thumb_key
            avatar.status = AvatarStatus.ready
            avatar.error = None
        except Exception as exc:
            logger.exception("rig pipeline failed for avatar %s", avatar_id)
            avatar.status = AvatarStatus.failed
            avatar.error = str(exc)[:1000]
        await db.commit()
