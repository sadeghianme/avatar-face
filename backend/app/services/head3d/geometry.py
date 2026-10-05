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
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from app.services.head3d import topology as T

# --- Constants ----------------------------------------------------------------

#: Bizygomatic width of an adult face, ear-level landmark to landmark, metres.
#: Only the model's unit; every proportion below is relative to the face.
FACE_WIDTH_M = 0.14

#: How far the nose tip stands ahead of the mid-cheek plane, in face widths.
#: Anthropometry puts the pronasale about 3 cm ahead of the malar surface on a
#: 13.5 cm face (0.22); MediaPipe's own z, measured on the frontal subjects of
#: this spike, gives 0.24-0.25 on humans. Calibrating to one constant keeps
#: that relief and guards against a detection whose z scale drifted (a tilted
#: head, a long lens), and it is the one place a muzzle is made human-deep.
NOSE_PROTRUSION = 0.25

#: Laplacian passes over the face oval's z (MediaPipe's z is noisiest there).
OVAL_SMOOTH_PASSES = 3

#: The cranium's half-width over the face's half-width: head breadth (~15 cm)
#: over bizygomatic width (~13.5 cm).
HEAD_BREADTH = 1.10
#: The back of the skull behind the ear plane, in face half-widths: head
#: length (~19 cm) minus tragion-to-nose (~11.5 cm) = 7.5 cm over 6.75 cm.
HEAD_BACK = 1.10
#: The crown's height above the forehead landmark (10), in face heights,
#: when the cut-out's hair gives no better answer: clamp of the hair top.
CROWN_ABOVE_FOREHEAD = (0.25, 0.60)
#: How far the skirt between the face edge and the cranium's equator bulges
#: outward, as a share of the chord: a convex skull, not a cone.
SKIRT_BULGE = 0.18
SKIRT_RINGS = 3
BACK_RINGS = 4
#: The neck's radius in face widths (narrower than a real ~12 cm neck on a
#: 13.5 cm face, because every neck the picture shows thinner than the
#: cylinder would show the cylinder beside it) and its length below the chin
#: in face heights. Its axis sits back so its front stays behind the hair
#: card: the hair that hangs over a neck must stay in front of it, and under
#: the chin a turn reveals the cylinder, not the card.
NECK_RADIUS = 0.33
NECK_LENGTH = 0.45
NECK_SEGMENTS = 20
NECK_BEHIND_CARD = 0.03
#: The hair card sits this far behind the deepest oval landmark, and the body
#: card this far behind the hair card, in face widths.
HAIR_CARD_BEHIND = 0.02
BODY_CARD_BEHIND = 0.08
#: The 2D engine's head layer: the face box grown by these shares of the face
#: width (sides) and height (above, below), feathered by these shares of the
#: box's own width/height (sides, top) and of its height at the neck.
HEAD_BOX_SIDE, HEAD_BOX_ABOVE, HEAD_BOX_BELOW = 0.42, 0.9, 0.5
HEAD_FEATHER_SIDE, HEAD_FEATHER_TOP, HEAD_FEATHER_NECK = 0.16, 0.13, 0.26
#: The hair card's face hole: the oval shrunk by this many face widths, with
#: a feather of the same width outward.
OVAL_HOLE_FEATHER = 0.03

#: Morph z rules. The jaw rotates about the ears: a chin that drops moves back
#: by this share of the drop (a hinge 11 cm behind the chin dropping 2 cm
#: moves it back 0.2 cm... measured on a profile of an open "aa" it is nearer
#: 0.3 because the lip everts). Pucker and funnel push the lips forward by
#: these shares of the mouth width at the lip centre; a spread mouth pulls its
#: corners back around the teeth by this share of their lateral travel.
JAW_BACK = 0.30
LIP_PROTRUSION = {"mouthPucker": 0.08, "mouthFunnel": 0.06}
CORNER_RECESS = 0.15
#: Where the Left and Right halves of a symmetric target cross over, in
#: mouth widths about the face's centre line.
SIDE_BLEND = 0.15

#: The mouth interior, in mouth widths (corner to corner), as a SHELL just
#: behind the face surface: every part sits at the face's own depth at its
#: (x, y) minus an offset, because the face curves back below the lips (the
#: chin crease is ~0.12 widths behind the lip surface) and a flat part at
#: one depth pokes through it. The upper incisors hang from just above the
#: seam, the lower ones meet them with a small overbite; the cavity's
#: backdrop recedes further below the seam, behind where the jaw's back
#: travel (JAW_BACK) takes the lower lip on an open vowel.
#: The rows span the incisors and canines (the premolars sit behind the
#: corners), and recede toward their ends: a pucker slides the cheek skin
#: inward over a deeper part of the face, and a row that stayed at the
#: corners' rest depth would stand in front of it.
TEETH_WIDTH = 0.78
TEETH_ARCH_DEPTH = 0.12
UPPER_TEETH = {"top": 0.03, "bottom": -0.14, "behind": 0.03}
LOWER_TEETH = {"top": -0.09, "bottom": -0.24, "behind": 0.045}
TONGUE = {"centre": (0.0, -0.22, -0.10), "radii": (0.28, 0.07, 0.07)}
TONGUE_UNDER_SKIN = 0.03
CAVITY = {"top": 0.12, "bottom": -0.5, "width": 1.15, "behind": 0.06, "behind_low": 0.2}
#: Share of the chin's jaw drop the lower teeth and the tongue take. The
#: chin drops CHIN_SHARE (0.68) of the lower lip, so lower incisors riding
#: the chin stay mostly behind the lip, showing a sliver on an open vowel.
LOWER_TEETH_JAW_SHARE = 1.0
TONGUE_JAW_SHARE = 0.8

MORPH_NAMES = (
    "jawOpen", "mouthClose", "mouthPucker", "mouthFunnel",
    "mouthStretchLeft", "mouthStretchRight", "mouthSmileLeft", "mouthSmileRight",
    "eyeBlinkLeft", "eyeBlinkRight",
)
#: The viseme shapes' target names: the Ready Player Me convention the 3D
#: engine drives from its cue track (ih/oh/ou are I/O/U there).
VISEME_MORPH_NAMES = {
    "sil": "viseme_sil", "PP": "viseme_PP", "FF": "viseme_FF", "TH": "viseme_TH", "DD": "viseme_DD",
    "kk": "viseme_kk", "CH": "viseme_CH", "SS": "viseme_SS", "nn": "viseme_nn", "RR": "viseme_RR",
    "aa": "viseme_aa", "E": "viseme_E", "ih": "viseme_I", "oh": "viseme_O", "ou": "viseme_U",
}
#: The 2D rig's six symmetric weights and the targets each one becomes.
SYMMETRIC_TO_ARKIT = {
    "jawOpen": ("jawOpen",),
    "mouthClose": ("mouthClose",),
    "mouthPucker": ("mouthPucker",),
    "mouthFunnel": ("mouthFunnel",),
    "mouthStretch": ("mouthStretchLeft", "mouthStretchRight"),
    "mouthSmile": ("mouthSmileLeft", "mouthSmileRight"),
    "eyeBlink": ("eyeBlinkLeft", "eyeBlinkRight"),
}


def smoothstep(x: np.ndarray | float) -> np.ndarray | float:
    t = np.clip(x, 0.0, 1.0)
    return t * t * (3 - 2 * t)


# --- The face -----------------------------------------------------------------


@dataclass(frozen=True)
class FaceFrame:
    """Measurements of the rest face, image pixels."""
    width: float       # ear-level landmark to landmark
    height: float      # forehead (10) to chin (152)
    centre_x: float    # between the ear-level landmarks
    ear_y: float       # their mean height
    chin_y: float
    forehead_y: float
    mouth_width: float  # corner to corner
    seam: tuple[float, float]  # between the inner lips
    box: tuple[float, float, float, float]  # bounding box of all landmarks


def face_frame(points: np.ndarray) -> FaceFrame:
    p = np.asarray(points, dtype=np.float64)
    if p.shape != (T.NUM_LANDMARKS, 2):
        raise ValueError("expected 478 landmarks")
    width = float(abs(p[T.EAR_RIGHT, 0] - p[T.EAR_LEFT, 0]))
    height = float(abs(p[T.CHIN, 1] - p[T.FOREHEAD, 1]))
    if width < 2 or height < 2:
        raise ValueError("degenerate face")
    return FaceFrame(
        width=width,
        height=height,
        centre_x=float((p[T.EAR_RIGHT, 0] + p[T.EAR_LEFT, 0]) / 2),
        ear_y=float((p[T.EAR_RIGHT, 1] + p[T.EAR_LEFT, 1]) / 2),
        chin_y=float(p[T.CHIN, 1]),
        forehead_y=float(p[T.FOREHEAD, 1]),
        mouth_width=float(max(np.hypot(*(p[T.MOUTH_RIGHT] - p[T.MOUTH_LEFT])), 1.0)),
        seam=(float((p[13, 0] + p[14, 0]) / 2), float((p[13, 1] + p[14, 1]) / 2)),
        box=(float(p[:, 0].min()), float(p[:, 1].min()), float(p[:, 0].max()), float(p[:, 1].max())),
    )


def calibrate_depth(points: np.ndarray, z: np.ndarray) -> tuple[np.ndarray, float]:
    """MediaPipe z -> relief in image pixels, toward the camera positive, with
    the mid-cheek plane at 0 and the nose tip NOSE_PROTRUSION face widths
    ahead of it. Returns (relief, the scale applied to MediaPipe's z)."""
    frame = face_frame(points)
    z = np.asarray(z, dtype=np.float64)
    cheek = float(np.mean(z[T.CHEEK_LANDMARKS]))
    nose = float(z[T.NOSE_TIP])
    raw = cheek - nose  # MediaPipe: smaller z is nearer, so this is positive on a face
    if raw <= 1e-6:
        raise ValueError("the nose is not ahead of the cheeks: not a frontal face")
    scale = NOSE_PROTRUSION * frame.width / raw
    return (cheek - z) * scale, scale


def smooth_oval_depth(relief: np.ndarray, passes: int = OVAL_SMOOTH_PASSES) -> np.ndarray:
    """Smooth the relief ALONG the face oval (a 1-2-1 pass round the ring,
    `passes` times); the rest of the face keeps its measured depth.

    Along the ring, not over the mesh: the oval is the face's deepest rim
    and every neighbour it has lies forward of it, so a Laplacian pass over
    the mesh pulled the whole rim toward the cheeks (measured: a 5 px noise
    became a 17 px bias) instead of taking the jitter out of it."""
    out = np.array(relief, dtype=np.float64)
    ring = np.array(T.FACE_OVAL)
    for _ in range(passes):
        z = out[ring]
        out[ring] = (np.roll(z, 1) + 2 * z + np.roll(z, -1)) / 4
    return out


def head_pivot(points: np.ndarray, relief: np.ndarray) -> tuple[float, float, float]:
    """The pivot in image space (x, y, relief): between the ear-level
    landmarks, on their depth."""
    p = np.asarray(points, dtype=np.float64)
    ears = [T.EAR_LEFT, T.EAR_RIGHT]
    return (
        float(p[ears, 0].mean()),
        float(p[ears, 1].mean()),
        float(np.asarray(relief)[ears].mean()),
    )


def model_scale(frame: FaceFrame) -> float:
    """Metres per image pixel."""
    return FACE_WIDTH_M / frame.width


def to_model(points: np.ndarray, relief: np.ndarray, pivot: tuple[float, float, float], scale: float) -> np.ndarray:
    """Image (x, y) + relief -> head-frame positions (n, 3)."""
    p = np.asarray(points, dtype=np.float64)
    r = np.asarray(relief, dtype=np.float64)
    return np.column_stack((
        (p[:, 0] - pivot[0]) * scale,
        (pivot[1] - p[:, 1]) * scale,
        (r - pivot[2]) * scale,
    ))


def to_image(positions: np.ndarray, pivot: tuple[float, float, float], scale: float) -> np.ndarray:
    """Head-frame (x, y, *) -> image (x, y)."""
    q = np.asarray(positions, dtype=np.float64)
    return np.column_stack((q[:, 0] / scale + pivot[0], pivot[1] - q[:, 1] / scale))


# --- Meshes -------------------------------------------------------------------


@dataclass
class Mesh:
    """Positions (n, 3) in the head frame, UVs (n, 2) with the origin at the
    image's top-left (the glTF convention), triangles (m, 3)."""
    positions: np.ndarray
    uvs: np.ndarray
    triangles: np.ndarray

    def __post_init__(self) -> None:
        self.positions = np.ascontiguousarray(self.positions, dtype=np.float32)
        self.uvs = np.ascontiguousarray(self.uvs, dtype=np.float32)
        self.triangles = np.ascontiguousarray(self.triangles, dtype=np.uint32)


def orient_outward(positions: np.ndarray, triangles: np.ndarray, centre: np.ndarray) -> np.ndarray:
    """Wind every triangle so its normal points away from `centre`."""
    p = np.asarray(positions, dtype=np.float64)
    tris = np.array(triangles, dtype=np.int64)
    a, b, c = p[tris[:, 0]], p[tris[:, 1]], p[tris[:, 2]]
    normal = np.cross(b - a, c - a)
    outward = (a + b + c) / 3 - np.asarray(centre, dtype=np.float64)
    flip = np.einsum("ij,ij->i", normal, outward) < 0
    tris[flip, 1], tris[flip, 2] = tris[flip, 2], tris[flip, 1]
    return tris


def vertex_normals(positions: np.ndarray, triangles: np.ndarray) -> np.ndarray:
    """Area-weighted vertex normals (n, 3); an unreferenced vertex faces +z."""
    p = np.asarray(positions, dtype=np.float64)
    tris = np.asarray(triangles, dtype=np.int64)
    normals = np.zeros_like(p)
    face = np.cross(p[tris[:, 1]] - p[tris[:, 0]], p[tris[:, 2]] - p[tris[:, 0]])
    for k in range(3):
        np.add.at(normals, tris[:, k], face)
    length = np.linalg.norm(normals, axis=1)
    normals[length < 1e-12] = (0, 0, 1)
    length = np.linalg.norm(normals, axis=1)
    return normals / length[:, None]


def grid_triangles(rows: int, columns: int, wrap: bool = False) -> np.ndarray:
    """Two triangles per cell of a rows x columns vertex grid (row-major).
    `wrap` closes the last column onto the first."""
    tris = []
    cols = columns if wrap else columns - 1
    for r in range(rows - 1):
        for c in range(cols):
            c1 = (c + 1) % columns
            a, b = r * columns + c, r * columns + c1
            d, e = (r + 1) * columns + c, (r + 1) * columns + c1
            tris.append((a, b, e))
            tris.append((a, e, d))
    return np.array(tris, dtype=np.int64).reshape(-1, 3)


# --- The skull ----------------------------------------------------------------


@dataclass(frozen=True)
class SkullFit:
    """A cranium behind the face, head frame. The ellipsoid is centred at the
    pivot (ear level, ear plane): half-width `a_x`, `b_top` up to the crown,
    `b_bottom` down to chin level, `c` back to the occiput. `theta` is each
    oval column's angle about the centre (atan2(y, x), y up), `oval` the 36
    oval landmarks, `equator` where each column meets the ellipsoid's widest
    ring (z = 0), pulled in to the cut-out's silhouette where the picture is
    narrower than the ellipse and pushed out to clear the face edge where
    the ellipse would cut it; `k` is that per-column factor (1 = the
    ellipse), which the back rings share so the whole cranium follows."""
    a_x: float
    b_top: float
    b_bottom: float
    c: float
    theta: np.ndarray
    oval: np.ndarray
    equator: np.ndarray
    k: np.ndarray


#: The equator stays this many face widths inside the silhouette, and at
#: least this far outside the oval landmark (as a factor of its radius).
SILHOUETTE_MARGIN = 0.015
EQUATOR_PAST_OVAL = 1.03


def oval_directions(face: np.ndarray) -> np.ndarray:
    """Each oval column's unit direction from the pivot in the head frame's
    x, y (36, 2) — along which the ellipse's equator point lies."""
    fit = fit_skull(face, _frame_of(face), 1.0, None)
    q = fit.equator[:, :2]
    return q / np.linalg.norm(q, axis=1)[:, None]


def _frame_of(face: np.ndarray) -> FaceFrame:
    """A face frame in the head frame's own units (for direction-only uses)."""
    width = float(abs(face[T.EAR_RIGHT, 0] - face[T.EAR_LEFT, 0]))
    height = float(abs(face[T.CHIN, 1] - face[T.FOREHEAD, 1]))
    return FaceFrame(width=width, height=height, centre_x=0.0, ear_y=0.0, chin_y=float(-face[T.CHIN, 1]),
                     forehead_y=float(-face[T.FOREHEAD, 1]), mouth_width=1.0, seam=(0.0, 0.0), box=(0, 0, 1, 1))


def fit_skull(
    face: np.ndarray, frame: FaceFrame, scale: float, hair_top_y: float | None,
    silhouette: np.ndarray | None = None,
) -> SkullFit:
    """Fit the cranium to the face (head-frame positions (478, 3)).

    `hair_top_y` is the cut-out's topmost opaque row at the head's centre,
    image px, or None for an opaque picture; the crown reaches it within
    CROWN_ABOVE_FOREHEAD of the forehead landmark. `silhouette` is how far
    the cut-out reaches from the pivot along each oval column's equator
    direction (36, head units; texture.silhouette_reach), or None: the
    equator never leaves the picture, so the cranium wears the picture's
    own outline rather than a generic ellipse poking out beside it."""
    half_width = frame.width * scale / 2
    forehead = float(face[T.FOREHEAD, 1])
    face_h = frame.height * scale
    low, high = (forehead + k * face_h for k in CROWN_ABOVE_FOREHEAD)
    if hair_top_y is None:
        crown = forehead + 0.4 * face_h
    else:
        crown = (frame.ear_y - hair_top_y) * scale  # image y -> head y
    b_top = float(np.clip(crown, low, high))
    b_bottom = float(max(-face[T.CHIN, 1], 0.3 * face_h))
    a_x = HEAD_BREADTH * half_width
    c = HEAD_BACK * half_width
    oval = face[T.FACE_OVAL]
    theta = np.arctan2(oval[:, 1], oval[:, 0])
    b = np.where(np.sin(theta) >= 0, b_top, b_bottom)
    ellipse = np.column_stack((a_x * np.cos(theta), b * np.sin(theta)))
    radius = np.linalg.norm(ellipse, axis=1)
    direction = ellipse / radius[:, None]
    # The equator always clears the face edge (the generic ellipse can fall
    # inside a wide jaw's oval on the diagonals), and never leaves the
    # silhouette where one is known.
    floor = np.einsum("ij,ij->i", oval[:, :2], direction) * EQUATOR_PAST_OVAL
    k = np.ones(len(theta))
    if silhouette is not None:
        reach = np.asarray(silhouette, dtype=np.float64) - SILHOUETTE_MARGIN * frame.width * scale
        k = np.minimum(1.0, reach / radius)
    k = np.maximum(k, floor / radius)
    equator = np.column_stack((ellipse * k[:, None], np.zeros(len(theta))))
    return SkullFit(a_x=a_x, b_top=b_top, b_bottom=b_bottom, c=c, theta=theta, oval=oval, equator=equator, k=k)


@dataclass
class SkullMesh(Mesh):
    """The skull with, per vertex, its oval column (-1 for the pole) and its
    surface parameter s (0 at the face edge, SKIRT_RINGS/(rings) at the
    equator, 1 at the back pole) — what the texture and the morph share key on."""
    column: np.ndarray
    s: np.ndarray
    skirt_share: np.ndarray


def skirt_ring(fit: SkullFit, t: float) -> np.ndarray:
    """The skirt's ring at `t` (0 the oval landmarks, 1 the equator): the
    chord between them, bulged outward so the skull is convex. (36, 3)."""
    n_cols = len(fit.theta)
    chord = fit.equator - fit.oval
    bulge = SKIRT_BULGE * np.linalg.norm(chord, axis=1) * math.sin(math.pi * t)
    outward = np.column_stack((np.cos(fit.theta), np.sin(fit.theta), np.zeros(n_cols)))
    return fit.oval + chord * t + outward * bulge[:, None]


def back_ring(fit: SkullFit, psi: float) -> np.ndarray:
    """The cranium's ring `psi` radians behind the equator (pi/2 the pole),
    narrowed per column as the equator was. (36, 3)."""
    n_cols = len(fit.theta)
    b = np.where(np.sin(fit.theta) >= 0, fit.b_top, fit.b_bottom)
    return np.column_stack((
        fit.k * fit.a_x * math.cos(psi) * np.cos(fit.theta),
        fit.k * b * math.cos(psi) * np.sin(fit.theta),
        np.full(n_cols, -fit.c * math.sin(psi)),
    ))


def skull_mesh(fit: SkullFit) -> SkullMesh:
    """Rings of 36 columns + a wrap column: SKIRT_RINGS+1 rings from the oval
    landmarks to the equator (a bulged chord), BACK_RINGS-1 rings around the
    back, and the pole."""
    n_cols = len(fit.theta)
    rings = SKIRT_RINGS + BACK_RINGS  # ring rows before the pole
    positions, uvs, column, s_param, share = [], [], [], [], []
    for r in range(rings):
        if r <= SKIRT_RINGS:
            t = r / SKIRT_RINGS
            ring = skirt_ring(fit, t)
            ring_share = (1 - t) ** 1.5
        else:
            ring = back_ring(fit, (r - SKIRT_RINGS) / BACK_RINGS * (math.pi / 2))
            ring_share = 0.0
        s = r / rings
        for i in range(n_cols + 1):  # the wrap column repeats column 0
            k = i % n_cols
            positions.append(ring[k])
            uvs.append((i / n_cols, s))
            column.append(k)
            s_param.append(s)
            share.append(ring_share)
    pole_index = len(positions)
    positions.append((0.0, 0.0, -fit.c))
    uvs.append((0.5, 1.0))
    column.append(-1)
    s_param.append(1.0)
    share.append(0.0)
    tris = list(grid_triangles(rings, n_cols + 1, wrap=False))
    last = (rings - 1) * (n_cols + 1)
    for i in range(n_cols):
        tris.append((last + i, last + i + 1, pole_index))
    P = np.array(positions)
    tri = orient_outward(P, np.array(tris), np.array((0.0, 0.0, -0.4 * fit.c)))
    return SkullMesh(
        positions=P, uvs=np.array(uvs), triangles=tri,
        column=np.array(column, dtype=np.int32), s=np.array(s_param), skirt_share=np.array(share),
    )


# --- The neck -----------------------------------------------------------------


def neck_mesh(face: np.ndarray, frame: FaceFrame, scale: float, card_z: float) -> Mesh:
    """A cylinder under the head, its front NECK_BEHIND_CARD face widths
    behind the hair card at `card_z`, from inside the skull to NECK_LENGTH
    below the chin. UV u runs around it with the front at 0.5, v down it."""
    face_w = frame.width * scale
    radius = NECK_RADIUS * face_w
    axis_z = card_z - NECK_BEHIND_CARD * face_w - radius
    face_h = frame.height * scale
    top = float(face[T.CHIN, 1]) + 0.12 * face_h
    bottom = float(face[T.CHIN, 1]) - NECK_LENGTH * face_h
    rows = 4
    positions, uvs = [], []
    for r in range(rows):
        y = top + (bottom - top) * r / (rows - 1)
        for i in range(NECK_SEGMENTS + 1):
            u = i / NECK_SEGMENTS
            angle = (u - 0.5) * 2 * math.pi  # u = 0.5 faces the camera
            positions.append((radius * math.sin(angle), y, axis_z + radius * math.cos(angle)))
            uvs.append((u, r / (rows - 1)))
    P = np.array(positions)
    tri = orient_outward(P, grid_triangles(rows, NECK_SEGMENTS + 1), np.array((0.0, (top + bottom) / 2, axis_z)))
    return Mesh(positions=P, uvs=np.array(uvs), triangles=tri)


# --- Cards --------------------------------------------------------------------


def head_box(frame: FaceFrame, image_size: tuple[int, int]) -> tuple[float, float, float, float]:
    """The 2D engine's head layer box (image px): the face box grown by
    HEAD_BOX_* shares, clipped to the picture."""
    x0, y0, x1, y1 = frame.box
    fw, fh = x1 - x0, y1 - y0
    w, h = image_size
    return (
        max(0.0, x0 - fw * HEAD_BOX_SIDE), max(0.0, y0 - fh * HEAD_BOX_ABOVE),
        min(float(w), x1 + fw * HEAD_BOX_SIDE), min(float(h), y1 + fh * HEAD_BOX_BELOW),
    )


def card_mesh(box: tuple[float, float, float, float], z: float, pivot: tuple[float, float, float], scale: float) -> Mesh:
    """A quad over an image box at depth `z` (head frame), UVs over the box."""
    x0, y0, x1, y1 = box
    corners = np.array([(x0, y0), (x1, y0), (x1, y1), (x0, y1)], dtype=np.float64)
    positions = to_model(corners, np.zeros(4), pivot, scale)
    positions[:, 2] = z
    uvs = np.array([(0, 0), (1, 0), (1, 1), (0, 1)], dtype=np.float64)
    tris = np.array([(0, 2, 1), (0, 3, 2)])  # counter-clockwise seen from +z
    return Mesh(positions=positions, uvs=uvs, triangles=tris)


# --- The mouth interior -------------------------------------------------------


@dataclass
class InteriorPart:
    name: str
    mesh: Mesh
    #: Share of the chin's jaw drop every vertex of the part takes.
    jaw_share: float
    #: For a part that hugs the skin (the cavity backdrop): where each vertex
    #: sits on the face, so every face target carries it along. None for a
    #: part fixed to the skull (teeth) or hung from the jaw (tongue).
    skin: tuple[np.ndarray, np.ndarray] | None = None


def mouth_frame(face: np.ndarray) -> tuple[np.ndarray, float]:
    """(seam position, mouth width) in the head frame."""
    seam = (face[T.UPPER_INNER_LIP] + face[T.LOWER_INNER_LIP]) / 2
    width = float(max(np.linalg.norm(face[T.MOUTH_RIGHT] - face[T.MOUTH_LEFT]), 1e-6))
    return seam, width


def surface_weights(face: np.ndarray, xy: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Where each (x, y) sits on the face: three vertex indices and their
    barycentric weights (n, 3), from the canonical triangle under the point,
    or the nearest vertex alone outside them (and inside the mouth hole)."""
    p = np.asarray(face, dtype=np.float64)
    q = np.asarray(xy, dtype=np.float64).reshape(-1, 2)
    tris = T.face_triangles().astype(np.int64)
    a, b, c = p[tris[:, 0], :2], p[tris[:, 1], :2], p[tris[:, 2], :2]
    det = (b[:, 0] - a[:, 0]) * (c[:, 1] - a[:, 1]) - (c[:, 0] - a[:, 0]) * (b[:, 1] - a[:, 1])
    ok = np.abs(det) > 1e-12
    safe = np.where(ok, det, 1)
    indices = np.zeros((len(q), 3), dtype=np.int64)
    weights = np.zeros((len(q), 3))
    for k, (x, y) in enumerate(q):
        l1 = ((b[:, 0] - x) * (c[:, 1] - y) - (c[:, 0] - x) * (b[:, 1] - y)) / safe
        l2 = ((c[:, 0] - x) * (a[:, 1] - y) - (a[:, 0] - x) * (c[:, 1] - y)) / safe
        l3 = 1 - l1 - l2
        hits = np.flatnonzero(ok & (l1 >= -1e-6) & (l2 >= -1e-6) & (l3 >= -1e-6))
        if len(hits):
            t = hits[0]
            indices[k] = tris[t]
            weights[k] = (l1[t], l2[t], l3[t])
        else:
            nearest = int(np.argmin(np.hypot(p[:T.NUM_MESH_VERTICES, 0] - x, p[:T.NUM_MESH_VERTICES, 1] - y)))
            indices[k] = nearest
            weights[k] = (1.0, 0.0, 0.0)
    return indices, weights


def surface_depth(face: np.ndarray, xy: np.ndarray) -> np.ndarray:
    """The face surface's z at each (x, y)."""
    indices, weights = surface_weights(face, xy)
    return np.einsum("ij,ij->i", np.asarray(face, dtype=np.float64)[indices][..., 2], weights)


def surface_delta(delta: np.ndarray, indices: np.ndarray, weights: np.ndarray) -> np.ndarray:
    """A face target's delta carried to points on the surface (n, 3)."""
    return np.einsum("ijk,ij->ik", np.asarray(delta, dtype=np.float64)[indices], weights)


def _shell(face: np.ndarray, xy: np.ndarray, behind: np.ndarray | float) -> np.ndarray:
    """Positions (n, 3) on the face surface at `xy`, set `behind` it."""
    xy = np.asarray(xy, dtype=np.float64).reshape(-1, 2)
    return np.column_stack((xy, surface_depth(face, xy) - np.asarray(behind, dtype=np.float64)))


def _teeth_arch(face: np.ndarray, seam: np.ndarray, width: float, spec: dict[str, float], columns: int = 7) -> Mesh:
    """A row of teeth: a strip `columns` wide on the face's own depth, a
    little behind it, bending back a touch more toward the corners. UV u
    left to right, v top to bottom."""
    xy, behind, uvs = [], [], []
    for yv, v in ((spec["top"], 0.0), (spec["bottom"], 1.0)):
        for c in range(columns):
            u = c / (columns - 1)
            xy.append((seam[0] + (u - 0.5) * TEETH_WIDTH * width, seam[1] + yv * width))
            behind.append((spec["behind"] + TEETH_ARCH_DEPTH * (2 * abs(u - 0.5)) ** 2) * width)
            uvs.append((u, v))
    P = _shell(face, np.array(xy), np.array(behind))
    tris = orient_outward(P, grid_triangles(2, columns), seam + np.array((0, 0, -width)))
    return Mesh(positions=P, uvs=np.array(uvs), triangles=tris)


def _cavity(face: np.ndarray, seam: np.ndarray, width: float, columns: int = 7, rows: int = 5) -> InteriorPart:
    """The dark backdrop: a grid on the face's depth, CAVITY["behind"] widths
    behind it above the seam and CAVITY["behind_low"] below, where the
    lower lip travels back as the jaw opens. It hugs the skin: every face
    target carries it, so a pucker that slides the curved corner skin over
    it cannot bring the skin behind it. UV v top to bottom."""
    xy, behind, uvs = [], [], []
    for r in range(rows):
        v = r / (rows - 1)
        y = CAVITY["top"] + (CAVITY["bottom"] - CAVITY["top"]) * v
        depth = CAVITY["behind"] + (CAVITY["behind_low"] - CAVITY["behind"]) * float(smoothstep(-y / 0.25))
        for c in range(columns):
            u = c / (columns - 1)
            xy.append((seam[0] + (u - 0.5) * CAVITY["width"] * width, seam[1] + y * width))
            behind.append(depth * width)
            uvs.append((u, v))
    grid = np.array(xy)
    P = _shell(face, grid, np.array(behind))
    tris = orient_outward(P, grid_triangles(rows, columns), seam + np.array((0, 0, -width)))
    return InteriorPart("Cavity", Mesh(positions=P, uvs=np.array(uvs), triangles=tris), jaw_share=0.0,
                        skin=surface_weights(face, grid))


def _ellipsoid(centre: np.ndarray, radii: np.ndarray, lat: int = 6, lon: int = 12) -> Mesh:
    positions, uvs = [], []
    for i in range(lat + 1):
        phi = math.pi * i / lat
        for j in range(lon + 1):
            lam = 2 * math.pi * j / lon
            n = np.array((math.sin(phi) * math.cos(lam), math.cos(phi), math.sin(phi) * math.sin(lam)))
            positions.append(centre + n * radii)
            uvs.append((j / lon, i / lat))
    P = np.array(positions)
    tris = orient_outward(P, grid_triangles(lat + 1, lon + 1), centre)
    return Mesh(positions=P, uvs=np.array(uvs), triangles=tris)


def mouth_interior(face: np.ndarray, teeth: str, tongue: bool) -> list[InteriorPart]:
    """The interior behind the lips: a dark cavity backdrop, the teeth rows
    the look wears ("both", "upper", "none"), and a tongue, each a shell on
    the face's own depth. Positions in the head frame, sized by the mouth
    width."""
    if teeth not in ("both", "upper", "none"):
        raise ValueError(f"unknown teeth {teeth!r}")
    seam, width = mouth_frame(face)
    parts: list[InteriorPart] = [_cavity(face, seam, width)]
    if teeth in ("both", "upper"):
        parts.append(InteriorPart("TeethUpper", _teeth_arch(face, seam, width, UPPER_TEETH), jaw_share=0.0))
    if teeth == "both":
        parts.append(InteriorPart("TeethLower", _teeth_arch(face, seam, width, LOWER_TEETH), jaw_share=LOWER_TEETH_JAW_SHARE))
    if tongue:
        cx, cy, cz = TONGUE["centre"]
        xy = np.array([[seam[0] + cx * width, seam[1] + cy * width]])
        centre = _shell(face, xy, -cz * width)[0]
        blob = _ellipsoid(centre, np.array(TONGUE["radii"]) * width)
        # It lies on the floor of the mouth: nowhere nearer the camera than
        # the skin over it (the chin crease comes back behind its centre).
        floor = surface_depth(face, blob.positions[:, :2]) - TONGUE_UNDER_SKIN * width
        blob.positions[:, 2] = np.minimum(blob.positions[:, 2].astype(np.float64), floor)
        parts.append(InteriorPart("Tongue", blob, jaw_share=TONGUE_JAW_SHARE))
    return parts


# --- Morph targets ------------------------------------------------------------


def side_weights(points: np.ndarray, frame: FaceFrame) -> np.ndarray:
    """How much of a symmetric target each landmark gives to the ARKit LEFT
    target (the subject's left: image right), 0..1, crossing over smoothly
    about the face's centre line. Left + right = the whole delta."""
    p = np.asarray(points, dtype=np.float64)
    x = (p[:, 0] - frame.centre_x) / (SIDE_BLEND * frame.mouth_width)
    return np.asarray(smoothstep(x + 0.5))


def lip_forward_weights(points: np.ndarray, frame: FaceFrame) -> np.ndarray:
    """Where a pucker pushes forward: 1 on the lip rows at the centre, fading
    toward the corners, 0.5 at the corners, and a smooth falloff over the
    skin to 0.35 mouth widths from the seam."""
    p = np.asarray(points, dtype=np.float64)
    sx, sy = frame.seam
    w = frame.mouth_width
    nx = np.abs(p[:, 0] - sx) / (w / 2)
    dist = np.hypot(p[:, 0] - sx, (p[:, 1] - sy) * 1.35) / w
    out = np.asarray(1 - smoothstep(dist / 0.35)) * 0.4
    for i in T.LIP_VERTICES:
        out[i] = 1.0 - 0.6 * min(1.0, nx[i]) ** 2
    for i in T.LIP_CORNERS:
        out[i] = 0.5
    return out


def morph_delta(name: str, dx: np.ndarray, dy: np.ndarray, points: np.ndarray, frame: FaceFrame, scale: float) -> np.ndarray:
    """A symmetric target's head-frame delta (478, 3) from the baked image-px
    deltas per unit weight, with z from the rules above."""
    dx = np.asarray(dx, dtype=np.float64)
    dy = np.asarray(dy, dtype=np.float64)
    out = np.column_stack((dx * scale, -dy * scale, np.zeros(len(dx))))
    if name == "jawOpen":
        out[:, 2] = -JAW_BACK * np.maximum(0.0, -out[:, 1])
    elif name in LIP_PROTRUSION:
        out[:, 2] = LIP_PROTRUSION[name] * frame.mouth_width * scale * lip_forward_weights(points, frame)
    elif name in ("mouthStretch", "mouthSmile"):
        out[:, 2] = -CORNER_RECESS * np.abs(out[:, 0])
    return out


def viseme_delta(
    dx: np.ndarray, dy: np.ndarray, weights: dict[str, float], points: np.ndarray, frame: FaceFrame, scale: float,
) -> np.ndarray:
    """A whole viseme shape's head-frame delta (478, 3) from its baked
    image-px deltas, with z from the same rules as the symmetric targets,
    weighted by the viseme's own table weights."""
    dx = np.asarray(dx, dtype=np.float64)
    dy = np.asarray(dy, dtype=np.float64)
    out = np.column_stack((dx * scale, -dy * scale, np.zeros(len(dx))))
    out[:, 2] = -JAW_BACK * np.maximum(0.0, -out[:, 1])
    forward = sum(LIP_PROTRUSION[k] * weights.get(k, 0.0) for k in LIP_PROTRUSION)
    if forward > 0:
        out[:, 2] += forward * frame.mouth_width * scale * lip_forward_weights(points, frame)
    spread = min(1.0, weights.get("mouthStretch", 0.0) + weights.get("mouthSmile", 0.0))
    if spread > 0:
        out[:, 2] -= CORNER_RECESS * spread * np.abs(out[:, 0])
    return out


def split_sides(delta: np.ndarray, left_weight: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """(left, right) halves of a symmetric delta; they sum to the whole."""
    w = np.asarray(left_weight)[:, None]
    return delta * w, delta * (1 - w)


def skirt_morph(skull: SkullMesh, face_delta: np.ndarray) -> np.ndarray:
    """The skull's delta for a face target: each skirt vertex follows its
    oval landmark by its share (1 at the face edge, 0 at the equator)."""
    out = np.zeros((len(skull.positions), 3))
    oval = np.array(T.FACE_OVAL)
    mask = skull.column >= 0
    out[mask] = face_delta[oval[skull.column[mask]]] * skull.skirt_share[mask][:, None]
    return out


def interior_morphs(part: InteriorPart, face_targets: dict[str, np.ndarray]) -> list[tuple[str, np.ndarray]]:
    """A mouth part's morph targets: a skin-hugging part takes every face
    target at its own points; a jaw-hung part takes the chin's jawOpen by
    its share; a skull-fixed part none."""
    if part.skin is not None:
        indices, weights = part.skin
        return [(name, surface_delta(delta, indices, weights)) for name, delta in face_targets.items()]
    if part.jaw_share > 0:
        chin = np.asarray(face_targets["jawOpen"][T.CHIN], dtype=np.float64) * part.jaw_share
        return [("jawOpen", np.tile(chin, (len(part.mesh.positions), 1)))]
    return []


#: The view: this many face heights tall, centred this far above the face's
#: middle (hair takes more room than a chin) — about the 2D engine's face
#: framing, so the two can be compared.
FRAME_HEIGHTS = 2.0
FRAME_LIFT = 0.12


def frame_box(face: np.ndarray, frame: FaceFrame, scale: float) -> tuple[tuple[float, float, float], float]:
    """Where a camera should look and how tall the view is, head frame."""
    face_h = frame.height * scale
    middle = (float(face[T.FOREHEAD, 1]) + float(face[T.CHIN, 1])) / 2
    centre = (float(face[:, 0].mean()), middle + FRAME_LIFT * face_h, float(face[T.NOSE_TIP, 2]) / 2)
    return centre, FRAME_HEIGHTS * face_h
