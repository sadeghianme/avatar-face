"""GLB (binary glTF) inspection for 3D avatars.

We don't render server-side — we validate the container and extract the
morph-target names so the client engine knows whether the model can
lip-sync (it needs ARKit/Oculus blendshapes, e.g. a Ready Player Me
avatar's viseme_* / eyeBlink* targets).
"""
from __future__ import annotations

import io
import json
import struct

from PIL import Image, ImageDraw

GLB_MAGIC = b"glTF"
# The 15 Oculus visemes as morph-target names (Ready Player Me convention).
VISEME_MORPHS = [
    "viseme_sil", "viseme_PP", "viseme_FF", "viseme_TH", "viseme_DD",
    "viseme_kk", "viseme_CH", "viseme_SS", "viseme_nn", "viseme_RR",
    "viseme_aa", "viseme_E", "viseme_I", "viseme_O", "viseme_U",
]


def parse_glb_json(data: bytes) -> dict:
    """Return the glTF JSON chunk of a GLB, validating the container."""
    if len(data) < 20 or data[:4] != GLB_MAGIC:
        raise ValueError("not a GLB file (bad magic)")
    version, declared_length = struct.unpack_from("<II", data, 4)
    if version != 2:
        raise ValueError(f"unsupported glTF version {version}")
    if declared_length > len(data):
        raise ValueError("truncated GLB")
    chunk_length, chunk_type = struct.unpack_from("<I4s", data, 12)
    if chunk_type != b"JSON":
        raise ValueError("first GLB chunk is not JSON")
    if 20 + chunk_length > len(data):
        raise ValueError("truncated GLB JSON chunk")
    return json.loads(data[20 : 20 + chunk_length])


def extract_morph_targets(gltf: dict) -> list[str]:
    """All morph-target names across meshes (mesh or primitive extras)."""
    names: set[str] = set()
    for mesh in gltf.get("meshes", []):
        target_names = (mesh.get("extras") or {}).get("targetNames")
        if not target_names:
            for primitive in mesh.get("primitives", []):
                target_names = (primitive.get("extras") or {}).get("targetNames")
                if target_names:
                    break
        if target_names:
            names.update(str(n) for n in target_names)
    return sorted(names)


def build_model_rig(data: bytes) -> dict:
    """Rig JSON for a 3D avatar: capabilities, not geometry.

    Two lip-sync modes: dedicated viseme_* morphs (Ready Player Me
    convention) or raw ARKit blendshapes (jawOpen & friends — Avaturn,
    Avatar SDK, Blender ARKit rigs); the client engine picks accordingly.
    """
    gltf = parse_glb_json(data)
    morphs = extract_morph_targets(gltf)
    morph_set = set(morphs)
    visemes_present = [v for v in VISEME_MORPHS if v in morph_set]
    if len(visemes_present) >= 8:
        lipsync_mode = "visemes"
    elif "jawOpen" in morph_set:
        lipsync_mode = "arkit"
    else:
        lipsync_mode = None
    return {
        "version": 3,
        "kind": "model3d",
        "morph_targets": morphs,
        "viseme_morphs": visemes_present,
        "lipsync_mode": lipsync_mode,
        "can_lipsync": lipsync_mode is not None,
        # Both ARKit naming conventions: eyeBlinkLeft and eyeBlink_L.
        "can_blink": bool({"eyeBlinkLeft", "eyeBlink_L"} & morph_set)
        and bool({"eyeBlinkRight", "eyeBlink_R"} & morph_set),
        "node_names": [n.get("name", "") for n in gltf.get("nodes", [])][:200],
    }


def make_model_thumbnail(size: int = 256) -> bytes:
    """Placeholder thumbnail for 3D avatars (no server-side GL)."""
    img = Image.new("RGB", (size, size), "#312e81")
    draw = ImageDraw.Draw(img)
    cx, cy = size / 2, size / 2 - size * 0.04
    r = size * 0.30
    # Stylized wireframe head: circle + meridians
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], outline="#a5b4fc", width=3)
    draw.ellipse([cx - r * 0.45, cy - r, cx + r * 0.45, cy + r], outline="#818cf8", width=2)
    draw.ellipse([cx - r, cy - r * 0.45, cx + r, cy + r * 0.45], outline="#818cf8", width=2)
    draw.line([cx - r, cy, cx + r, cy], fill="#818cf8", width=2)
    draw.line([cx, cy - r, cx, cy + r], fill="#818cf8", width=2)
    text = "3D"
    draw.text((cx, size * 0.88), text, fill="#c7d2fe", anchor="mm")
    out = io.BytesIO()
    img.save(out, format="JPEG", quality=88)
    return out.getvalue()
