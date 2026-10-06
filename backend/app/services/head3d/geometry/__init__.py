"""The head's geometry, as pure functions of the landmarks.

Spaces. The landmarks come in IMAGE pixels (x right, y down) with MediaPipe's
z (same pixel scale, negative toward the camera). Everything built here lives
in the HEAD frame: metres, x right, y up, z toward the camera, origin at the
head's pivot — the point between the ear-level oval landmarks (234/454), on
the ear plane, which is where a head turns and nods about. A face is
FACE_WIDTH_M wide (ear-level landmark to landmark), so a 400 px face and a
4000 px face build the same head.

Every constant is named and justified where it is declared; nothing is
measured from a GPU, a neural model or a sample head.

The package, by part of the head:

    constants  every named constant, with its justification, and smoothstep
    face       the face frame, its depth calibrated, the pivot and the frames
    meshes     the mesh type, normals, winding, grids
    skull      the skull fitted round the face oval, and its mesh
    parts      the neck, the hair and body cards, the mouth interior
    morphs     the morph targets, and the camera framing

Everything is re-exported here, so `geometry.X` (build and texture read it
as G.X) keeps working.
"""

from __future__ import annotations

from app.services.head3d.geometry.constants import (
    BACK_RINGS,
    BODY_CARD_BEHIND,
    CAVITY,
    CORNER_RECESS,
    CROWN_ABOVE_FOREHEAD,
    FACE_WIDTH_M,
    HAIR_CARD_BEHIND,
    HEAD_BACK,
    HEAD_BOX_ABOVE,
    HEAD_BOX_BELOW,
    HEAD_BOX_SIDE,
    HEAD_BREADTH,
    HEAD_FEATHER_NECK,
    HEAD_FEATHER_SIDE,
    HEAD_FEATHER_TOP,
    JAW_BACK,
    LIP_PROTRUSION,
    LOWER_TEETH,
    LOWER_TEETH_JAW_SHARE,
    MORPH_NAMES,
    NECK_BEHIND_CARD,
    NECK_LENGTH,
    NECK_RADIUS,
    NECK_SEGMENTS,
    NOSE_PROTRUSION,
    OVAL_HOLE_FEATHER,
    OVAL_SMOOTH_PASSES,
    SIDE_BLEND,
    SKIRT_BULGE,
    SKIRT_RINGS,
    SYMMETRIC_TO_ARKIT,
    TEETH_ARCH_DEPTH,
    TEETH_WIDTH,
    TONGUE,
    TONGUE_JAW_SHARE,
    TONGUE_UNDER_SKIN,
    UPPER_TEETH,
    VISEME_MORPH_NAMES,
    smoothstep,
)
from app.services.head3d.geometry.face import (
    FaceFrame,
    calibrate_depth,
    face_frame,
    head_pivot,
    model_scale,
    smooth_oval_depth,
    to_image,
    to_model,
)
from app.services.head3d.geometry.meshes import (
    Mesh,
    grid_triangles,
    orient_outward,
    vertex_normals,
)
from app.services.head3d.geometry.morphs import (
    FRAME_HEIGHTS,
    FRAME_LIFT,
    frame_box,
    interior_morphs,
    lip_forward_weights,
    morph_delta,
    side_weights,
    skirt_morph,
    split_sides,
    viseme_delta,
)
from app.services.head3d.geometry.parts import (
    InteriorPart,
    _cavity,
    _ellipsoid,
    _shell,
    _teeth_arch,
    card_mesh,
    head_box,
    mouth_frame,
    mouth_interior,
    neck_mesh,
    surface_delta,
    surface_depth,
    surface_weights,
)
from app.services.head3d.geometry.skull import (
    EQUATOR_PAST_OVAL,
    SILHOUETTE_MARGIN,
    SkullFit,
    SkullMesh,
    _frame_of,
    back_ring,
    fit_skull,
    oval_directions,
    skirt_ring,
    skull_mesh,
)

__all__ = [
    "back_ring",
    "BACK_RINGS",
    "BODY_CARD_BEHIND",
    "calibrate_depth",
    "card_mesh",
    "CAVITY",
    "_cavity",
    "CORNER_RECESS",
    "CROWN_ABOVE_FOREHEAD",
    "_ellipsoid",
    "EQUATOR_PAST_OVAL",
    "face_frame",
    "FACE_WIDTH_M",
    "FaceFrame",
    "fit_skull",
    "frame_box",
    "FRAME_HEIGHTS",
    "FRAME_LIFT",
    "_frame_of",
    "grid_triangles",
    "HAIR_CARD_BEHIND",
    "HEAD_BACK",
    "head_box",
    "HEAD_BOX_ABOVE",
    "HEAD_BOX_BELOW",
    "HEAD_BOX_SIDE",
    "HEAD_BREADTH",
    "HEAD_FEATHER_NECK",
    "HEAD_FEATHER_SIDE",
    "HEAD_FEATHER_TOP",
    "head_pivot",
    "interior_morphs",
    "InteriorPart",
    "JAW_BACK",
    "lip_forward_weights",
    "LIP_PROTRUSION",
    "LOWER_TEETH",
    "LOWER_TEETH_JAW_SHARE",
    "Mesh",
    "model_scale",
    "morph_delta",
    "MORPH_NAMES",
    "mouth_frame",
    "mouth_interior",
    "NECK_BEHIND_CARD",
    "NECK_LENGTH",
    "neck_mesh",
    "NECK_RADIUS",
    "NECK_SEGMENTS",
    "NOSE_PROTRUSION",
    "orient_outward",
    "oval_directions",
    "OVAL_HOLE_FEATHER",
    "OVAL_SMOOTH_PASSES",
    "_shell",
    "SIDE_BLEND",
    "side_weights",
    "SILHOUETTE_MARGIN",
    "SKIRT_BULGE",
    "skirt_morph",
    "skirt_ring",
    "SKIRT_RINGS",
    "skull_mesh",
    "SkullFit",
    "SkullMesh",
    "smooth_oval_depth",
    "smoothstep",
    "split_sides",
    "surface_delta",
    "surface_depth",
    "surface_weights",
    "SYMMETRIC_TO_ARKIT",
    "_teeth_arch",
    "TEETH_ARCH_DEPTH",
    "TEETH_WIDTH",
    "to_image",
    "to_model",
    "TONGUE",
    "TONGUE_JAW_SHARE",
    "TONGUE_UNDER_SKIN",
    "UPPER_TEETH",
    "vertex_normals",
    "viseme_delta",
    "VISEME_MORPH_NAMES",
]
