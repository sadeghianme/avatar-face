"""Fit a face mesh to the marks its owner placed by hand.

Every landmark the engine trusts either came from MediaPipe, which fits a
HUMAN face, or — for an animal or a cartoon nothing detects — from the face
template. Either way it is a guess until the owner has placed the head, the
eyes and the mouth, and this turns those marks into the rig.

These decisions carry the module.

**One global warp, always from the base.** The fit this replaces corrected
region by region, each correction a local warp chained on the last one's
output. Local warps pull in different directions where their falloffs
overlap, and on an animal — a big head, small eyes, a wide muzzle, all far
from where a human template put them — they folded 37 to 147 of the mesh's
918 triangles over themselves. Folded triangles render as texture flipped
inside out. Here ALL marks feed one thin-plate-spline warp, the smoothest
map that puts every marked landmark where it was marked, applied to all 478
points at once. It always starts from the unmodified base mesh (the
detection, or the template), never from a previous fit, so saving the same
marks twice stores the same rig.

**The mouth is a line on animals and cartoons.** A muzzle has no lips whose
edges could be marked, and a toon's mouth is often a single stroke. There
the owner marks the corners and three points along the seam, and every
inner-lip landmark is put ON that line at the fraction of the mouth width it
occupies in the base mesh — the upper ring a hair above the lower one, so no
lip triangle collapses to nothing — with the lip rings behind it following
in their order. A human mouth is still marked by its edges and its centre.

**The iris is not skin.** A marked pupil is placed after the warp, moved
and scaled as one piece, and never pins it. The iris ring overlaps both
lids in every detection (an eye shows part of its iris), so as a warp
constraint it counted any lid moved past its rim, or any pupil drawn
smaller than the detected one, as skin folded over the eye.

**The head is its outline.** Eight marks round the face (its four edges,
the temples and the jaw corners), and with all eight marked every oval
landmark between them goes on the smooth curve the owner sees through them
(`_outline_pairs`), so the mesh's edge is that outline. Marks saved with a
four-point head pin those four only and fit exactly as they always did.

**A fit that folds is refused, not saved.** `validate` names what is wrong
(folded triangles, lids upside down, eyes or mouth corners out of order,
features outside the head, a head outline that crosses itself or goes round
the face out of order, a pupil outside its eye) and rig-fit refuses to
store such a rig. The preview still returns it, with the reasons, so the
owner sees what to move.

The base mesh is kept beside the rig in storage (fit-base.json), never in
rig.json: the rig is published to every visitor, the base is only needed
here. It records the frame it was taken in (image size and crop origin), so
a base that no longer matches its rig — after an undo, say — is detected and
rebuilt rather than silently misapplied.

The package:

    scheme      the landmarks each mark attaches to, the lines' rules and
                render profiles, the fit's tolerances
    marks       what the owner marked, read and written, merged, and where
                each handle opens on a mesh
    warping     the marks turned into landmark targets, and the one
                thin-plate-spline warp from the base
    validation  what makes a fit unsaveable (folds, order, containment)
    fit         fit_rig, and the stored base (fit-base.json) it starts from

The public names are re-exported here, so `anchor_fit.X` keeps working.
Nothing private is: each module's helpers stay in it.
"""

from __future__ import annotations

from app.services.anchor_fit.fit import (
    FIT_BASE_VERSION,
    fit_base_key,
    fit_base_points,
    fit_base_record,
    fit_rig,
    move_fit_base,
    read_fit_base,
    write_fit_base,
)
from app.services.anchor_fit.marks import (
    SAME_MARK_PX,
    FaceMarks,
    PupilMarks,
    RegionMarks,
    for_face_type,
    marks_from_dict,
    marks_from_mesh,
    marks_to_dict,
    merge,
    saved_marks,
    seam_line,
    with_head_outline,
)
from app.services.anchor_fit.scheme import (
    CHIN,
    CHIN_MERGE,
    DIAGONALS,
    EYE_SLACK,
    FACE_OVAL,
    FLIP_EPSILON,
    HEAD,
    HEAD_DIAGONALS,
    HEAD_OUTLINE,
    HEAD_OUTLINE_EDGES,
    HEAD_SLACK,
    INNER_LOWER,
    INNER_UPPER,
    IRIS,
    LEFT_COMMISSURE,
    LEFT_EYE,
    LEFT_IRIS,
    LEGACY_PROFILES,
    LINE_CORNERS,
    LINE_FACE_TYPES,
    LIP_ROWS_LOWER,
    LIP_ROWS_UPPER,
    MOUTH,
    MOUTH_LINE_POINTS,
    MOUTH_STYLES,
    NO_PUPIL_FACE_TYPES,
    NUM_POINTS,
    RENDER_PROFILES,
    RIGHT_COMMISSURE,
    RIGHT_EYE,
    RIGHT_IRIS,
    SEAM,
    SEAM_GAP,
    SMOOTHING,
    Point,
    marks_mouth_as_line,
    marks_pupils,
    render_profile_for,
)
from app.services.anchor_fit.validation import (
    FitProblem,
    flipped_triangles,
    outline_crossed,
    outline_in_order,
    validate,
)
from app.services.anchor_fit.warping import (
    catmull_rom,
    correspondences,
    part_lips,
    pupil_pairs,
    warp,
)

__all__ = [
    "catmull_rom",
    "CHIN",
    "CHIN_MERGE",
    "correspondences",
    "DIAGONALS",
    "EYE_SLACK",
    "FACE_OVAL",
    "FaceMarks",
    "fit_base_key",
    "fit_base_points",
    "fit_base_record",
    "FIT_BASE_VERSION",
    "fit_rig",
    "FitProblem",
    "FLIP_EPSILON",
    "flipped_triangles",
    "for_face_type",
    "HEAD",
    "HEAD_DIAGONALS",
    "HEAD_OUTLINE",
    "HEAD_OUTLINE_EDGES",
    "HEAD_SLACK",
    "INNER_LOWER",
    "INNER_UPPER",
    "IRIS",
    "LEFT_COMMISSURE",
    "LEFT_EYE",
    "LEFT_IRIS",
    "LEGACY_PROFILES",
    "LINE_CORNERS",
    "LINE_FACE_TYPES",
    "LIP_ROWS_LOWER",
    "LIP_ROWS_UPPER",
    "marks_from_dict",
    "marks_from_mesh",
    "marks_mouth_as_line",
    "marks_pupils",
    "marks_to_dict",
    "merge",
    "MOUTH",
    "MOUTH_LINE_POINTS",
    "MOUTH_STYLES",
    "move_fit_base",
    "NO_PUPIL_FACE_TYPES",
    "NUM_POINTS",
    "outline_crossed",
    "outline_in_order",
    "part_lips",
    "Point",
    "pupil_pairs",
    "PupilMarks",
    "read_fit_base",
    "RegionMarks",
    "render_profile_for",
    "RENDER_PROFILES",
    "RIGHT_COMMISSURE",
    "RIGHT_EYE",
    "RIGHT_IRIS",
    "SAME_MARK_PX",
    "saved_marks",
    "SEAM",
    "SEAM_GAP",
    "seam_line",
    "SMOOTHING",
    "validate",
    "warp",
    "with_head_outline",
    "write_fit_base",
]
