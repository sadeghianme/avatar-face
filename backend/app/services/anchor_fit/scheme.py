"""The scheme: the landmarks each mark attaches to, what each line marks
and how it renders, and the tolerances the fit and its validator use."""

from __future__ import annotations

Point = tuple[float, float]

NUM_POINTS = 478

# The landmarks the marks attach to, in MediaPipe's index order. "Left" and
# "right" are the IMAGE's: 33 is the outer corner of the eye on the image's
# left, which is the subject's right eye.
HEAD = {"left": 234, "right": 454, "top": 10, "bottom": 152}
# MediaPipe's face oval, clockwise on screen from the top of the forehead.
FACE_OVAL = [
    10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377,
    152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109,
]
# The head's outline between its four edges: the temples above, the jaw
# corners below. Four edges alone drew the head as a diamond, and a warp
# pinned only there was free to bulge or pinch the cheeks and the jaw
# wherever a face is not diamond-shaped, which is every face and every muzzle.
#
# Each is the oval landmark nearest the DIAGONAL of the head's box, seen
# from its centre, on the face template. On an ellipse the point halfway
# round between two edges (parameter 45 degrees) lies exactly on that
# diagonal, so the eight marks are an ellipse's eight points and a smooth
# closed curve through them draws the oval. The two sides are MediaPipe's
# mirror pairs (54 and 284, 136 and 365); tests/test_anchor_fit pins them.
HEAD_DIAGONALS = {"upper_left": 54, "upper_right": 284, "lower_right": 365, "lower_left": 136}
DIAGONALS = tuple(HEAD_DIAGONALS)
# The eight head marks in order around the face, clockwise on screen from
# the top: the order the outline is drawn in, and checked in.
HEAD_OUTLINE_EDGES = (
    "top", "upper_right", "right", "lower_right", "bottom", "lower_left", "left", "upper_left",
)
HEAD_OUTLINE = [{**HEAD, **HEAD_DIAGONALS}[edge] for edge in HEAD_OUTLINE_EDGES]
LEFT_EYE = {"left": 33, "right": 133, "top": 159, "bottom": 145}
RIGHT_EYE = {"left": 362, "right": 263, "top": 386, "bottom": 374}
MOUTH = {"left": 61, "right": 291, "top": 0, "bottom": 17}
SEAM = (13, 14)
CHIN = HEAD["bottom"]
# Inner lip, corner to corner, image left to right. The corners are shared.
INNER_UPPER = [78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308]
INNER_LOWER = [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308]
# The rings behind the inner lip, seam outward, as MediaPipe's lip contours
# run them: semi-inner, semi-outer, outer. Corner to corner, image left to
# right, like the inner rings; their ends are the commissure below.
LIP_ROWS_UPPER = [
    INNER_UPPER,
    [62, 183, 42, 41, 38, 12, 268, 271, 272, 407, 292],
    [76, 184, 74, 73, 72, 11, 302, 303, 304, 408, 306],
    [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291],
]
LIP_ROWS_LOWER = [
    INNER_LOWER,
    [62, 96, 89, 179, 86, 15, 316, 403, 319, 325, 292],
    [76, 77, 90, 180, 85, 16, 315, 404, 320, 307, 306],
    [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291],
]
# The commissure, outer corner to inner corner. MediaPipe runs two more
# landmarks between them (76 and 62, 306 and 292), in a line; when a mouth
# line puts the inner corner on the outer one they must go there too, or
# they are left outside it and the triangles around them fold.
LEFT_COMMISSURE = [61, 76, 62, 78]
RIGHT_COMMISSURE = [291, 306, 292, 308]
# Iris centre, then four rim points.
LEFT_IRIS = [468, 469, 470, 471, 472]
RIGHT_IRIS = [473, 474, 475, 476, 477]
IRIS = LEFT_IRIS + RIGHT_IRIS
# The landmark each commissure is drawn with on a mouth line, where all four
# of a corner's landmarks sit on one point and a triangulation can only keep
# one of them: the inner corner, which the engine moves with the inner lip
# on closed-mouth shapes, so the drawn corner follows the seam it ends.
# Fixed, and the same on both sides; left to Qhull, the survivor differed
# from layout to layout and side to side, and one corner of the mouth moved
# on M/B/P while the other stayed.
LINE_CORNERS = dict.fromkeys(LEFT_COMMISSURE, LEFT_COMMISSURE[-1]) | dict.fromkeys(
    RIGHT_COMMISSURE, RIGHT_COMMISSURE[-1]
)

# How far the upper inner lip sits above the lower one on a marked mouth
# line, as a fraction of the mouth width. Zero collapses the lip triangles
# between them to no area at all, and one of them then flips on rounding
# alone (measured: every prototype layout folded exactly that one sliver).
SEAM_GAP = 0.004
MOUTH_LINE_POINTS = 5
# A chin this close to the head's bottom edge (fraction of head height) is
# the same mark: many faces end at the chin, and two correspondences a pixel
# apart would pull the jaw against itself.
CHIN_MERGE = 0.01
# Regularisation of the warp, in coordinates normalised to the face size.
# Only there to keep the solve well conditioned when two marked landmarks
# nearly coincide; small enough that every mark lands within a tenth of a
# pixel on a 1000px face.
SMOOTHING = 1e-7
# Triangles smaller than this (fraction of the face box area) are ignored by
# the fold count: a collapsed sliver, like the one between an outer mouth
# corner and the inner corner the mouth line puts on top of it, has no
# orientation to lose.
FLIP_EPSILON = 1e-7
# Slack on "inside the head", as a fraction of the head's size: a detected
# face turned slightly away can put the far eye corner a pixel past the
# cheek contour.
HEAD_SLACK = 0.02
# Slack on "the pupil is in its eye", as a fraction of the eye's width: a
# heavy upper lid can cover the iris down to its centre, which a detection
# then places on, or a hair above, the lid mark.
EYE_SLACK = 0.1

# The lines whose mouth is marked as a line, and the one without pupils.
LINE_FACE_TYPES = frozenset({"animal", "cartoon"})
NO_PUPIL_FACE_TYPES = frozenset({"animal"})
# Versioned renderer settings a fitted rig carries (see embed KindProfile).
# Absent means the classic human renderer, which humans keep.
#
# A new fit names the line's current profile: "toon@1" for the Animation and
# Cartoon looks (face type cartoon) and "animal@2" for animals, both of which
# move and paint the mouth as a character's (embed/src/engine/character-mouth.ts).
# A rig fitted before them keeps the profile it was saved with ("animal@1", or
# none) until its owner fits it again or switches its mouth style
# (LEGACY_PROFILES is what "classic" means), so nothing live changes by itself.
RENDER_PROFILES = {"animal": "animal@2", "cartoon": "toon@1"}
LEGACY_PROFILES = {"animal": "animal@1"}
# The mouth styles an owner may choose between on those lines.
MOUTH_STYLES = ("character", "classic")


def marks_mouth_as_line(face_type: str) -> bool:
    return face_type in LINE_FACE_TYPES


def marks_pupils(face_type: str) -> bool:
    return face_type not in NO_PUPIL_FACE_TYPES


def render_profile_for(face_type: str, style: str = "character") -> str | None:
    """The profile a rig of `face_type` is saved with, in the owner's mouth
    `style`: the line's current one, or (classic) the one the line had before
    the character mouth, which is none for animation and humans."""
    if style == "classic":
        return LEGACY_PROFILES.get(face_type)
    return RENDER_PROFILES.get(face_type)
