"""Assemble one head: picture + landmarks + bake -> GLB.

The node hierarchy the GLB carries (the engine reads it by name):

    Head (the pivot: ear level, ear plane)
    ├── Face        the 478-landmark mesh, canonical triangles, the picture
    ├── Skull       cranium + skirt, the picture projected, then its edge
    ├── HairCard    the cut-out's head region, flat, behind the face
    ├── Cavity, TeethUpper, TeethLower, Tongue (per look)
    Neck            a cylinder, the picture's own neck wrapped, still
    Body            the rest of the cut-out, flat, still

Face, Skull and the mouth parts carry the morph targets: the ARKit-named
set (the engine's fallback decomposition path, and the blink) and the 15
`viseme_*` shapes (the path the engine prefers, exact at each viseme). The
scene's extras carry what the engine needs beside them: the rig's own
viseme table, the look, where to frame.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field

import numpy as np
from PIL import Image

from app.services.head3d import geometry as G
from app.services.head3d import texture as X
from app.services.head3d import topology as T
from app.services.head3d.gltf import GlbBuilder

EXTRAS_VERSION = 1
LOOKS = ("photo", "render", "flat")
#: Roughness per look: a photograph has its lighting baked in and gets no
#: specular; a 3D render may keep a little sheen.
ROUGHNESS = {"photo": 1.0, "render": 0.7, "flat": 1.0}


@dataclass
class HeadSubject:
    name: str
    picture: Image.Image
    points: np.ndarray
    z: np.ndarray
    rig: dict
    bake: dict
    look: str = "photo"
    #: A teeth photograph and its 478 landmarks (the owner's own kit, or the
    #: standard teeth); None means painted teeth.
    teeth: tuple[Image.Image, np.ndarray] | None = None


@dataclass
class HeadBuild:
    glb: bytes
    report: dict = field(default_factory=dict)


def interior_for(profile: str | None) -> tuple[str, bool, str]:
    """(teeth rows, tongue, cavity shade key) a render profile wears:
    the 2D kind profiles' rules, not their code."""
    if not profile:
        return "both", True, "human"
    if profile.startswith("toon"):
        return "upper", True, "toon"
    if profile.startswith("animal"):
        return "none", True, "animal"
    return "both", True, "human"


def _targets_for_face(
    subject: HeadSubject, frame: G.FaceFrame, scale: float
) -> dict[str, np.ndarray]:
    """Every target's head-frame delta (478, 3): the ARKit set in
    MORPH_NAMES order, then the viseme shapes the rig's table names."""
    left = G.side_weights(subject.points, frame)
    out: dict[str, np.ndarray] = {}
    for symmetric, arkit in G.SYMMETRIC_TO_ARKIT.items():
        baked = subject.bake["targets"].get(symmetric)
        if baked is None:
            delta = np.zeros((T.NUM_LANDMARKS, 3))
        else:
            delta = G.morph_delta(symmetric, baked["dx"], baked["dy"], subject.points, frame, scale)
        if len(arkit) == 1:
            out[arkit[0]] = delta
        else:
            out[arkit[0]], out[arkit[1]] = G.split_sides(delta, left)
    targets = {name: out[name] for name in G.MORPH_NAMES}
    table = subject.rig.get("visemes", {})
    for viseme, baked in subject.bake.get("visemes", {}).items():
        name = G.VISEME_MORPH_NAMES.get(viseme)
        if name is None:
            continue
        targets[name] = G.viseme_delta(
            baked["dx"], baked["dy"], table.get(viseme, {}), subject.points, frame, scale
        )
    return targets


def build_head(subject: HeadSubject, texture_format: str = "webp", quality: int = 88) -> HeadBuild:
    if subject.look not in LOOKS:
        raise ValueError(f"unknown look {subject.look!r}")
    timings: dict[str, float] = {}
    clock = time.perf_counter()

    def lap(name: str) -> None:
        nonlocal clock
        now = time.perf_counter()
        timings[name] = round(now - clock, 4)
        clock = now

    picture = X.to_array(subject.picture)
    points = np.asarray(subject.points, dtype=np.float64)
    frame = G.face_frame(points)
    relief, z_scale = G.calibrate_depth(points, subject.z)
    relief = G.smooth_oval_depth(relief)
    pivot = G.head_pivot(points, relief)
    scale = G.model_scale(frame)
    face = G.to_model(points, relief, pivot, scale)
    lap("landmarks")

    glb = GlbBuilder()
    fmt_alpha = "png" if texture_format == "png" else "webp"
    fmt_opaque = "jpeg" if texture_format == "png" else texture_format

    def texture(image: Image.Image, fmt: str) -> tuple[int, int]:
        data, mime = X.encode(image, fmt, quality)
        return glb.add_texture(glb.add_image(data, mime)), len(data)

    unlit = subject.look == "flat"
    roughness = ROUGHNESS[subject.look]
    sizes: dict[str, int] = {}

    # --- the face ---
    face_image, crop = X.face_crop(picture, frame)
    face_tex, sizes["face"] = texture(face_image, fmt_opaque)
    # Double-sided: a pucker folds a few triangles at the mouth corners (the
    # corner moves in faster than the skin beside it), and culled, a folded
    # triangle is a hole showing the cavity. The 2D engine draws them flipped.
    face_material = glb.add_material(
        "Face", face_tex, unlit=unlit, roughness=roughness, double_sided=True
    )
    triangles = T.face_triangles()
    normals = G.vertex_normals(face, triangles)
    face_targets = _targets_for_face(subject, frame, scale)
    face_mesh = glb.add_mesh(
        "Face",
        face,
        X.crop_uvs(points, crop),
        triangles,
        face_material,
        normals,
        [(name, delta) for name, delta in face_targets.items()],
    )
    lap("face")

    # --- the skull and neck ---
    top = X.hair_top(picture, frame)
    fit = G.fit_skull(
        face, frame, scale, top, X.silhouette_reach(picture, face, frame, pivot, scale)
    )
    skull = G.skull_mesh(fit)
    skull_tex, sizes["skull"] = texture(X.skull_texture(picture, fit, pivot, scale), fmt_opaque)
    skull_material = glb.add_material("Skull", skull_tex, unlit=unlit, roughness=roughness)
    skull_mesh = glb.add_mesh(
        "Skull",
        skull.positions,
        skull.uvs,
        skull.triangles,
        skull_material,
        G.vertex_normals(skull.positions, skull.triangles),
        [(name, G.skirt_morph(skull, delta)) for name, delta in face_targets.items()],
    )
    face_width_m = frame.width * scale
    z_card = float(face[T.FACE_OVAL, 2].min()) - G.HAIR_CARD_BEHIND * face_width_m
    neck = G.neck_mesh(face, frame, scale, z_card)
    neck_tex, sizes["neck"] = texture(X.neck_texture(picture, frame, neck, pivot, scale), fmt_alpha)
    neck_material = glb.add_material(
        "Neck", neck_tex, alpha_mode="BLEND", unlit=unlit, roughness=roughness
    )
    neck_mesh = glb.add_mesh(
        "Neck",
        neck.positions,
        neck.uvs,
        neck.triangles,
        neck_material,
        G.vertex_normals(neck.positions, neck.triangles),
    )
    lap("skull")

    # --- the cards ---
    oval_px = points[T.FACE_OVAL]
    box = G.head_box(frame, subject.picture.size)
    hair_tex, sizes["hair"] = texture(X.hair_card_image(picture, frame, box, oval_px), fmt_alpha)
    hair_material = glb.add_material("HairCard", hair_tex, alpha_mode="BLEND", unlit=True)
    hair_quad = G.card_mesh(box, z_card, pivot, scale)
    hair_mesh = glb.add_mesh(
        "HairCard", hair_quad.positions, hair_quad.uvs, hair_quad.triangles, hair_material
    )
    body_image, body_box = X.body_card_image(picture, frame, box, oval_px)
    body_tex, sizes["body"] = texture(body_image, fmt_alpha)
    body_material = glb.add_material("Body", body_tex, alpha_mode="BLEND", unlit=True)
    body_quad = G.card_mesh(body_box, z_card - G.BODY_CARD_BEHIND * face_width_m, pivot, scale)
    body_mesh = glb.add_mesh(
        "Body", body_quad.positions, body_quad.uvs, body_quad.triangles, body_material
    )
    lap("cards")

    # --- the mouth interior ---
    teeth_rows, tongue, shade_key = interior_for(subject.rig.get("render_profile"))
    lip = X.lip_colour(picture, points)
    parts = G.mouth_interior(face, teeth_rows, tongue)
    cavity_tex, sizes["cavity"] = texture(X.cavity_texture(lip, X.CAVITY_SHADES[shade_key]), "png")
    teeth_textures: dict[str, int] = {}
    if teeth_rows != "none":
        if subject.teeth is not None and subject.look != "flat":
            upper, lower = X.teeth_textures(X.to_array(subject.teeth[0]), subject.teeth[1])
        else:
            upper = lower = X.flat_teeth_texture()
        teeth_textures["TeethUpper"], sizes["teeth_upper"] = texture(upper, fmt_alpha)
        if teeth_rows == "both":
            teeth_textures["TeethLower"], sizes["teeth_lower"] = texture(lower, fmt_alpha)
    interior_nodes: list[int] = []
    for part in parts:
        if part.name == "Cavity":
            material = glb.add_material("Cavity", cavity_tex, unlit=True, double_sided=True)
        elif part.name in teeth_textures:
            material = glb.add_material(
                part.name, teeth_textures[part.name], alpha_mode="BLEND", roughness=0.5
            )
        else:
            material = glb.add_material(
                "Tongue", colour=(*X.tongue_colour(lip), 1.0), roughness=0.6, unlit=unlit
            )
        targets = G.interior_morphs(part, face_targets) or None
        mesh = glb.add_mesh(
            part.name,
            part.mesh.positions,
            part.mesh.uvs,
            part.mesh.triangles,
            material,
            G.vertex_normals(part.mesh.positions, part.mesh.triangles),
            targets,
        )
        interior_nodes.append(glb.add_node(part.name, mesh))
    lap("mouth")

    # --- the nodes ---
    children = [
        glb.add_node("Face", face_mesh),
        glb.add_node("Skull", skull_mesh),
        glb.add_node("HairCard", hair_mesh),
        *interior_nodes,
    ]
    head = glb.add_node("Head", children=children)
    # The neck stays with the body: a head turns on it.
    neck_node = glb.add_node("Neck", neck_mesh)
    body = glb.add_node("Body", body_mesh)
    centre, height = G.frame_box(face, frame, scale)
    extras = {
        "liveface": {
            "version": EXTRAS_VERSION,
            "kind": "head3d",
            "subject": subject.name,
            "look": subject.look,
            "profile": subject.rig.get("render_profile"),
            "visemes": subject.rig.get("visemes", {}),
            "frame": {"center": [round(v, 5) for v in centre], "height": round(height, 5)},
            "face_width_m": G.FACE_WIDTH_M,
            "morphs": list(face_targets.keys()),
            "fidelity": subject.bake.get("fidelity", {}),
        }
    }
    data = glb.build([head, neck_node, body], scene_extras=extras)
    lap("write")

    report = {
        "subject": subject.name,
        "look": subject.look,
        "profile": subject.rig.get("render_profile"),
        "image_size": list(subject.picture.size),
        "face_width_px": round(frame.width, 1),
        "depth_scale": round(z_scale, 4),
        "hair_top_px": top,
        "skull": {
            "a_x": round(fit.a_x, 4),
            "b_top": round(fit.b_top, 4),
            "b_bottom": round(fit.b_bottom, 4),
            "c": round(fit.c, 4),
        },
        "vertices": {
            "face": int(len(face)),
            "skull": int(len(skull.positions)),
            "neck": int(len(neck.positions)),
            "mouth": int(sum(len(p.mesh.positions) for p in parts)),
        },
        "triangles": {
            "face": int(len(triangles)),
            "skull": int(len(skull.triangles)),
            "neck": int(len(neck.triangles)),
            "mouth": int(sum(len(p.mesh.triangles) for p in parts)),
        },
        "draw_calls": 5 + len(parts),
        "textures_bytes": sizes,
        "glb_bytes": len(data),
        "texture_format": texture_format,
        "timings_s": timings,
        "build_s": round(sum(timings.values()), 4),
    }
    return HeadBuild(glb=data, report=report)
