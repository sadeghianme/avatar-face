"""Photo -> talking 3D face GLB, fully in-house.

Pipeline: MediaPipe gives 3D positions for all 478 landmarks (synthetic
dome fallback without a model); the photo becomes the texture (UVs are just
normalized pixel coords); viseme + blink morph targets are generated
procedurally with the same deformation basis the 2D engine uses — so the
output GLB drives the existing Avatar3DEngine with zero changes.

The result is a textured face SHELL (no hair/back-of-head geometry): real
depth and parallax, sculpted mouth shapes, soft alpha-faded rim.
"""
from __future__ import annotations

import io
import json
import struct

import numpy as np
from PIL import Image
from scipy.spatial import Delaunay

from app.core.config import get_settings
from app.services.rig import (
    INNER_LIP_RING,
    MOUTH_INDICES,
    VISEME_BLENDSHAPES,
    synthetic_face_mesh,
)

FACE_WIDTH_M = 0.16  # real-world face width the mesh is scaled to

# Canonical MediaPipe lid rows (match the JS engine).
UPPER_LIDS = [
    [246, 161, 160, 159, 158, 157, 173],
    [466, 388, 387, 386, 385, 384, 398],
]
LOWER_LIDS = [
    [7, 163, 144, 145, 153, 154, 155],
    [249, 390, 373, 374, 380, 381, 382],
]

VISEME_MORPH_NAMES = {
    "sil": "viseme_sil", "PP": "viseme_PP", "FF": "viseme_FF", "TH": "viseme_TH",
    "DD": "viseme_DD", "kk": "viseme_kk", "CH": "viseme_CH", "SS": "viseme_SS",
    "nn": "viseme_nn", "RR": "viseme_RR", "aa": "viseme_aa", "E": "viseme_E",
    "ih": "viseme_I", "oh": "viseme_O", "ou": "viseme_U",
}


def landmarks_3d(image_bytes: bytes) -> tuple[np.ndarray, tuple[int, int]]:
    """478 landmarks as (x_px, y_px, z_px). MediaPipe when configured,
    else the synthetic mesh with a parallax-dome depth profile."""
    image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    width, height = image.size

    if get_settings().rig_model_path:
        try:
            import mediapipe as mp
            from mediapipe.tasks import python as mp_python
            from mediapipe.tasks.python import vision

            options = vision.FaceLandmarkerOptions(
                base_options=mp_python.BaseOptions(
                    model_asset_path=get_settings().rig_model_path
                ),
                num_faces=1,
            )
            with vision.FaceLandmarker.create_from_options(options) as landmarker:
                mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=np.asarray(image))
                result = landmarker.detect(mp_image)
            if result.face_landmarks:
                pts = np.array(
                    [[lm.x * width, lm.y * height, lm.z * width]
                     for lm in result.face_landmarks[0]],
                    dtype=np.float64,
                )
                return pts, (width, height)
        except Exception:
            pass  # fall through to synthetic

    flat = synthetic_face_mesh(width, height)
    cx, cy = flat[:, 0].mean(), flat[:, 1].mean()
    half_w = max((flat[:, 0].max() - flat[:, 0].min()) / 2, 1.0)
    half_h = max((flat[:, 1].max() - flat[:, 1].min()) / 2, 1.0)
    dx = (flat[:, 0] - cx) / half_w
    dy = (flat[:, 1] - cy) / half_h
    depth = np.clip(1.0 - (dx**2 + dy**2), 0, 1)
    # MediaPipe convention: negative z toward the camera.
    z = -depth * half_w * 0.55
    return np.column_stack([flat, z]), (width, height)


def _viseme_displacements(points: np.ndarray) -> dict[str, np.ndarray]:
    """Per-viseme (x,y,z) displacement arrays in IMAGE-space pixels,
    mirroring the 2D engine's blendshape deformation basis (+ z pushes
    for pucker/funnel that only 3D can show)."""
    mouth = np.array(MOUTH_INDICES)
    mcx, mcy = points[mouth, 0].mean(), points[mouth, 1].mean()
    mw = max(points[mouth, 0].max() - points[mouth, 0].min(), 1.0)
    mh = max(points[mouth, 1].max() - points[mouth, 1].min(), 1.0)
    inner = set(INNER_LIP_RING)

    out: dict[str, np.ndarray] = {}
    for viseme, weights in VISEME_BLENDSHAPES.items():
        disp = np.zeros_like(points)
        jaw = weights["jawOpen"]
        close = weights["mouthClose"]
        pucker = weights["mouthPucker"]
        funnel = weights["mouthFunnel"]
        stretch = weights["mouthStretch"]
        smile = weights["mouthSmile"]

        for i in mouth:
            nx = (points[i, 0] - mcx) / (mw / 2)
            ny = (points[i, 1] - mcy) / (mh / 2)
            dx = dy = dz = 0.0
            if ny > 0:
                dy += jaw * mh * 0.5 * min(1.0, ny)
            else:
                dy -= jaw * mh * 0.07 * -ny
            dx -= (pucker * 0.20 + funnel * 0.12) * nx * (mw / 2)
            dx += (stretch * 0.14 + smile * 0.08) * nx * (mw / 2)
            if abs(nx) > 0.55:
                dy -= smile * mh * 0.18 * (abs(nx) - 0.55)
            if i in inner:
                dy += (mcy - points[i, 1]) * close * 0.8
            # Lips push FORWARD (toward camera = negative z) on rounded sounds.
            dz -= (pucker * 0.35 + funnel * 0.4) * mw * 0.12
            disp[i] = (dx, dy, dz)

        # Chin follows the jaw with radial falloff.
        if jaw > 0.01:
            below = points[:, 1] > mcy
            dist = np.hypot(points[:, 0] - mcx, points[:, 1] - mcy)
            falloff = np.clip(1 - dist / (mw * 1.4), 0, 1) * below
            mouth_mask = np.zeros(len(points), dtype=bool)
            mouth_mask[mouth] = True
            disp[~mouth_mask, 1] += (jaw * mh * 0.4 * falloff[~mouth_mask])

        out[VISEME_MORPH_NAMES[viseme]] = disp
    return out


def _blink_displacements(points: np.ndarray) -> dict[str, np.ndarray]:
    out: dict[str, np.ndarray] = {}
    for name, upper, lower in (
        ("eyeBlinkLeft", UPPER_LIDS[0], LOWER_LIDS[0]),
        ("eyeBlinkRight", UPPER_LIDS[1], LOWER_LIDS[1]),
    ):
        disp = np.zeros_like(points)
        eye_bottom = points[lower, 1].max()
        xs = points[upper, 0]
        ecx = xs.mean()
        half_w = max((xs.max() - xs.min()) / 2, 1.0)
        for i in upper:
            centrality = max(0.0, 1 - ((points[i, 0] - ecx) / half_w) ** 2)
            disp[i, 1] = (eye_bottom - points[i, 1]) * (0.15 + 0.85 * centrality)
        for i in lower:
            centrality = max(0.0, 1 - ((points[i, 0] - ecx) / half_w) ** 2)
            disp[i, 1] = -(points[i, 1] - points[upper, 1].min()) * 0.1 * centrality
        out[name] = disp
    return out


def build_face_glb(image_bytes: bytes) -> bytes:
    """The whole show: landmarks -> textured, morph-targeted GLB."""
    points_px, (width, height) = landmarks_3d(image_bytes)

    # Image space -> glTF space (y up, z toward camera, meters).
    xs, ys = points_px[:, 0], points_px[:, 1]
    cx, cy = xs.mean(), ys.mean()
    face_w = max(xs.max() - xs.min(), 1.0)
    scale = FACE_WIDTH_M / face_w

    def to_gltf(p: np.ndarray) -> np.ndarray:
        out = np.empty_like(p, dtype=np.float32)
        out[:, 0] = (p[:, 0] - cx) * scale
        out[:, 1] = (cy - p[:, 1]) * scale  # flip y
        out[:, 2] = -p[:, 2] * scale        # mp z is negative toward camera
        return out

    positions = to_gltf(points_px)

    def disp_to_gltf(d: np.ndarray) -> np.ndarray:
        out = np.empty_like(d, dtype=np.float32)
        out[:, 0] = d[:, 0] * scale
        out[:, 1] = -d[:, 1] * scale
        out[:, 2] = -d[:, 2] * scale
        return out

    morphs: dict[str, np.ndarray] = {
        name: disp_to_gltf(d)
        for name, d in {**_viseme_displacements(points_px), **_blink_displacements(points_px)}.items()
    }
    target_names = list(morphs.keys())

    # UVs: normalized pixel coords (glTF UV origin = image top-left).
    uvs = np.column_stack([xs / width, ys / height]).astype(np.float32)

    # Vertex colors: white with alpha fading at the face rim. The band is
    # WIDE on purpose: border triangles are large, and a narrow fade reads
    # as polygon sawtooth instead of a soft edge.
    half_w = max((xs.max() - xs.min()) / 2, 1.0)
    half_h = max((ys.max() - ys.min()) / 2, 1.0)
    radial = np.sqrt(((xs - cx) / half_w) ** 2 + ((ys - cy) / half_h) ** 2)
    alpha = np.clip((1.08 - radial) / 0.5, 0, 1)
    alpha = alpha * alpha * (3 - 2 * alpha)  # smoothstep: no hard fade start
    colors = np.column_stack(
        [np.ones_like(alpha), np.ones_like(alpha), np.ones_like(alpha), alpha]
    ).astype(np.float32)

    triangles = Delaunay(points_px[:, :2]).simplices.astype(np.uint16)

    # Texture: the photo, capped to 1024px.
    image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    if max(image.size) > 1024:
        image.thumbnail((1024, 1024))
    tex_buf = io.BytesIO()
    image.save(tex_buf, format="JPEG", quality=88)
    texture_bytes = tex_buf.getvalue()

    return _write_glb(positions, uvs, colors, triangles, morphs, target_names, texture_bytes)


def _pad4(data: bytes, fill: bytes = b"\x00") -> bytes:
    return data + fill * (-len(data) % 4)


def _write_glb(
    positions: np.ndarray,
    uvs: np.ndarray,
    colors: np.ndarray,
    triangles: np.ndarray,
    morphs: dict[str, np.ndarray],
    target_names: list[str],
    texture_bytes: bytes,
) -> bytes:
    """Minimal-but-valid GLB writer (no external deps)."""
    blobs: list[bytes] = []
    buffer_views: list[dict] = []
    accessors: list[dict] = []
    offset = 0

    def add_blob(data: bytes, target: int | None = None) -> int:
        nonlocal offset
        data = _pad4(data)
        view = {"buffer": 0, "byteOffset": offset, "byteLength": len(data)}
        if target is not None:
            view["target"] = target
        buffer_views.append(view)
        blobs.append(data)
        offset += len(data)
        return len(buffer_views) - 1

    def add_accessor(view: int, comp_type: int, count: int, acc_type: str,
                     vmin=None, vmax=None) -> int:
        acc: dict = {
            "bufferView": view, "componentType": comp_type,
            "count": count, "type": acc_type,
        }
        if vmin is not None:
            acc["min"] = vmin
            acc["max"] = vmax
        accessors.append(acc)
        return len(accessors) - 1

    FLOAT, USHORT = 5126, 5123
    ARRAY_BUFFER, ELEMENT_ARRAY_BUFFER = 34962, 34963

    pos_acc = add_accessor(
        add_blob(positions.tobytes(), ARRAY_BUFFER), FLOAT, len(positions), "VEC3",
        positions.min(axis=0).tolist(), positions.max(axis=0).tolist(),
    )
    uv_acc = add_accessor(add_blob(uvs.tobytes(), ARRAY_BUFFER), FLOAT, len(uvs), "VEC2")
    col_acc = add_accessor(add_blob(colors.tobytes(), ARRAY_BUFFER), FLOAT, len(colors), "VEC4")
    idx_acc = add_accessor(
        add_blob(triangles.tobytes(), ELEMENT_ARRAY_BUFFER), USHORT, triangles.size, "SCALAR"
    )

    targets = []
    for name in target_names:
        deltas = morphs[name]
        acc = add_accessor(
            add_blob(deltas.tobytes(), ARRAY_BUFFER), FLOAT, len(deltas), "VEC3",
            deltas.min(axis=0).tolist(), deltas.max(axis=0).tolist(),
        )
        targets.append({"POSITION": acc})

    tex_view = add_blob(texture_bytes)

    gltf = {
        "asset": {"version": "2.0", "generator": "liveface-glb-builder"},
        "extensionsUsed": ["KHR_materials_unlit"],
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0, "name": "GeneratedFace"}],
        "meshes": [
            {
                "name": "GeneratedFace",
                "primitives": [
                    {
                        "attributes": {
                            "POSITION": pos_acc,
                            "TEXCOORD_0": uv_acc,
                            "COLOR_0": col_acc,
                        },
                        "indices": idx_acc,
                        "material": 0,
                        "targets": targets,
                    }
                ],
                "extras": {"targetNames": target_names},
                "weights": [0.0] * len(target_names),
            }
        ],
        "materials": [
            {
                "name": "photo",
                "pbrMetallicRoughness": {
                    "baseColorTexture": {"index": 0},
                    "metallicFactor": 0.0,
                    "roughnessFactor": 1.0,
                },
                "extensions": {"KHR_materials_unlit": {}},
                "alphaMode": "BLEND",
                "doubleSided": True,
            }
        ],
        "textures": [{"source": 0, "sampler": 0}],
        "samplers": [{"magFilter": 9729, "minFilter": 9987, "wrapS": 33071, "wrapT": 33071}],
        "images": [{"bufferView": tex_view, "mimeType": "image/jpeg"}],
        "bufferViews": buffer_views,
        "accessors": accessors,
        "buffers": [{"byteLength": offset}],
    }

    json_chunk = _pad4(json.dumps(gltf, separators=(",", ":")).encode(), b" ")
    bin_chunk = b"".join(blobs)
    total = 12 + 8 + len(json_chunk) + 8 + len(bin_chunk)
    return (
        b"glTF" + struct.pack("<II", 2, total)
        + struct.pack("<I4s", len(json_chunk), b"JSON") + json_chunk
        + struct.pack("<I4s", len(bin_chunk), b"BIN\x00") + bin_chunk
    )

