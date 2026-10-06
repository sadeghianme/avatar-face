"""What the picture gives each surface of the head.

The face is textured by the picture itself (its UVs are the landmarks'
positions); everything else is sampled from it: the cranium from the band
of picture between the face oval and the silhouette, stretched round the
back; the neck from the picture's own neck column, mirrored; the hair card
and the body card from the cut-out with complementary alphas; the mouth
interior from the lips' own colour and a teeth photograph.

Images are numpy RGBA float arrays in 0..1 here (h, w, 4); Pillow at the
edges. Pure functions of their inputs.
"""
from __future__ import annotations

import io
import math
from typing import cast

import numpy as np
from PIL import Image, ImageDraw
from scipy.ndimage import distance_transform_edt

from app.services.head3d import geometry as G
from app.services.head3d import topology as T

#: The cranium texture: columns around the head, rows from the face edge to
#: the back pole. 16 texels per oval column: the hairline falls on the
#: skirt, and at 4 per column it came out as a staircase.
SKULL_TEXTURE = (576, 192)
#: How far the silhouette is searched beyond the oval, face widths.
SILHOUETTE_MAX = 1.6
#: Shading baked into the skull texture: the skirt from 1.0 to this at the
#: equator, the back from there to this at the pole. The lights add the
#: rest; this hides the stretched pixels of the far side.
SKULL_SHADE_EQUATOR, SKULL_SHADE_POLE = 0.85, 0.6
NECK_TEXTURE = (64, 32)
#: The neck fades out over this share of its length, into the body card,
#: and its sides darken by this share of the front's brightness.
NECK_FADE = 0.35
NECK_SIDE_SHADE = 0.35
#: The body card's face hole is the oval dilated by this many face widths,
#: so nothing face-like sits behind the face mesh at a turn.
BODY_HOLE_DILATE = 0.12
TEETH_TEXTURE = (256, 96)
#: Share of a teeth row's width over which each end fades out.
TEETH_SIDE_FADE = 0.2
#: Standard tooth colours for cel art, where photographed enamel reads as a
#: photo pasted on a drawing.
FLAT_TOOTH = (247, 243, 232)
FLAT_TOOTH_LINE = (205, 196, 182)
#: The cavity's shade at its top, middle and bottom, as multiples of the lip
#: colour (kind-profile.ts: human, toon, animal).
CAVITY_SHADES = {
    "human": (0.3, 0.46, 0.62),
    "toon": (0.3, 0.46, 0.62),
    "animal": (0.2, 0.3, 0.44),
}
TONGUE_RED = (190, 80, 90)


def to_array(image: Image.Image) -> np.ndarray:
    """(h, w, 4) float RGBA in 0..1; an opaque picture gets alpha 1."""
    return np.asarray(image.convert("RGBA"), dtype=np.float32) / 255.0


def to_image(array: np.ndarray, mode: str = "RGBA") -> Image.Image:
    data = np.clip(np.asarray(array) * 255.0 + 0.5, 0, 255).astype(np.uint8)
    if mode == "RGB":
        data = data[..., :3]
    return Image.fromarray(data, mode)


def sample(array: np.ndarray, xs: np.ndarray, ys: np.ndarray) -> np.ndarray:
    """Bilinear samples (n, c) at image px, clamped to the picture."""
    h, w = array.shape[:2]
    x = np.clip(np.asarray(xs, dtype=np.float64), 0, w - 1)
    y = np.clip(np.asarray(ys, dtype=np.float64), 0, h - 1)
    x0 = np.floor(x).astype(int)
    y0 = np.floor(y).astype(int)
    x1 = np.minimum(x0 + 1, w - 1)
    y1 = np.minimum(y0 + 1, h - 1)
    fx = (x - x0)[:, None]
    fy = (y - y0)[:, None]
    top = array[y0, x0] * (1 - fx) + array[y0, x1] * fx
    bottom = array[y1, x0] * (1 - fx) + array[y1, x1] * fx
    return top * (1 - fy) + bottom * fy


def is_cut_out(array: np.ndarray) -> bool:
    """A picture with a transparent corner or two is a cut-out (the 2D
    engine's own test: two clear corners of four)."""
    h, w = array.shape[:2]
    corners = [array[1, 1, 3], array[1, w - 2, 3], array[h - 2, 1, 3], array[h - 2, w - 2, 3]]
    return sum(1 for a in corners if a < 0.1) >= 2


def hair_top(array: np.ndarray, frame: G.FaceFrame) -> float | None:
    """The topmost opaque row over the head's centre (image y), or None for
    an opaque picture."""
    if not is_cut_out(array):
        return None
    x0 = int(max(0, frame.centre_x - frame.width * 0.25))
    x1 = int(min(array.shape[1], frame.centre_x + frame.width * 0.25))
    rows = np.flatnonzero((array[:, x0:x1, 3] > 0.5).any(axis=1))
    if not len(rows):
        return None
    return float(rows[0])


def silhouette_reach(
    array: np.ndarray, face: np.ndarray, frame: G.FaceFrame, pivot: tuple[float, float, float], scale: float,
) -> np.ndarray | None:
    """How far the cut-out reaches from the pivot along each oval column's
    equator direction, head units (36,): the last opaque pixel before the
    first transparent one beyond the oval. None for an opaque picture."""
    if not is_cut_out(array):
        return None
    directions = G.oval_directions(face)
    oval_r = np.linalg.norm(face[T.FACE_OVAL][:, :2], axis=1)
    out = np.empty(len(directions))
    step_px = 2.0
    for i, (dx, dy) in enumerate(directions):
        start = oval_r[i] / scale
        steps = np.arange(start, SILHOUETTE_MAX * frame.width, step_px)
        px = pivot[0] + dx * steps
        py = pivot[1] - dy * steps  # head y is up, image y is down
        alpha = sample(array, px, py)[:, 3]
        clear = np.flatnonzero(alpha < 0.5)
        reach_px = float(steps[clear[0]] - step_px) if len(clear) else float(steps[-1])
        out[i] = max(reach_px, start) * scale
    return out


def lip_colour(array: np.ndarray, points: np.ndarray) -> tuple[float, float, float]:
    """The lips' own colour (0..1 RGB): the median over the outer lip ring."""
    p = np.asarray(points)[T.OUTER_LIP_RING]
    rgb = sample(array, p[:, 0], p[:, 1])[:, :3]
    r, g, b = (float(v) for v in np.median(rgb, axis=0))
    return r, g, b


def is_flat_art(array: np.ndarray, frame: G.FaceFrame) -> bool:
    """Cel art, told the way the 2D character mouth tells it: a handful of
    colours cover nearly all of the area round the mouth (the top eight
    4-bit bins hold 70%), and neighbouring pixels are alike (median step
    at most 4/255)."""
    sx, sy = frame.seam
    w = frame.mouth_width
    n = 28
    xs = sx + (np.arange(n) + 0.5) / n * 3 * w - 1.5 * w
    ys = sy + (np.arange(n) + 0.5) / n * 2.4 * w - 0.9 * w
    gx, gy = np.meshgrid(xs, ys)
    c = sample(array, gx.ravel(), gy.ravel())
    opaque = c[:, 3] > 0.5
    if opaque.sum() < 10:
        return False
    rgb = np.clip(c[opaque, :3] * 255, 0, 255).astype(int)
    keys = (rgb[:, 0] >> 4) * 256 + (rgb[:, 1] >> 4) * 16 + (rgb[:, 2] >> 4)
    _, counts = np.unique(keys, return_counts=True)
    top = np.sort(counts)[::-1][:8].sum() / len(keys)
    right = sample(array, gx.ravel() + 1, gy.ravel())
    steps = np.abs(c[opaque, :3] - right[opaque, :3]).max(axis=1) * 255
    return bool(top >= 0.7 and np.median(steps) <= 4)


def encode(image: Image.Image, fmt: str, quality: int = 88) -> tuple[bytes, str]:
    """(bytes, mime) for a texture: "webp" (lossy, alpha kept), "png", or
    "jpeg" (alpha dropped)."""
    out = io.BytesIO()
    if fmt == "webp":
        image.save(out, format="WEBP", quality=quality, method=4)
        return out.getvalue(), "image/webp"
    if fmt == "jpeg":
        image.convert("RGB").save(out, format="JPEG", quality=quality)
        return out.getvalue(), "image/jpeg"
    if fmt == "png":
        image.save(out, format="PNG", optimize=True)
        return out.getvalue(), "image/png"
    raise ValueError(f"unknown texture format {fmt!r}")


# --- The face -----------------------------------------------------------------


def face_crop(array: np.ndarray, frame: G.FaceFrame, pad: float = 0.12) -> tuple[Image.Image, tuple[int, int, int, int]]:
    """The face box grown by `pad` of its size, as an opaque RGB image, and
    the crop box (x0, y0, x1, y1) its UVs are relative to."""
    x0, y0, x1, y1 = frame.box
    w, h = x1 - x0, y1 - y0
    H, W = array.shape[:2]
    box = (
        int(max(0, math.floor(x0 - w * pad))), int(max(0, math.floor(y0 - h * pad))),
        int(min(W, math.ceil(x1 + w * pad))), int(min(H, math.ceil(y1 + h * pad))),
    )
    crop = array[box[1]:box[3], box[0]:box[2]]
    return to_image(crop, "RGB"), box


def crop_uvs(points: np.ndarray, box: tuple[int, int, int, int]) -> np.ndarray:
    """Image px -> UVs over a crop box, origin top-left."""
    p = np.asarray(points, dtype=np.float64)
    x0, y0, x1, y1 = box
    return np.column_stack(((p[:, 0] - x0) / max(1, x1 - x0), (p[:, 1] - y0) / max(1, y1 - y0)))


# --- The skull ----------------------------------------------------------------


def skull_texture(
    array: np.ndarray, fit: G.SkullFit,
    pivot: tuple[float, float, float], scale: float, size: tuple[int, int] = SKULL_TEXTURE,
) -> Image.Image:
    """Columns follow the skull's oval columns (interpolated between them),
    rows the surface from the face edge (0) to the back pole (1).

    The skirt, which faces the camera, is the picture PROJECTED onto it:
    each texel samples the picture where its point of the surface lands in
    the image, so at rest the cranium's front shows exactly the hair, ears
    and skin the picture has there, and a turn curves them. Past the
    cut-out's silhouette a column holds its last opaque colour, and the back
    rows hold the equator's, darkened: the back of the head is a smear of
    its own edge, which is honest about what one picture knows."""
    columns, rows = size
    n = len(fit.theta)
    s_equator = G.SKIRT_RINGS / (G.SKIRT_RINGS + G.BACK_RINGS)
    skirt_rows = [r for r in range(rows) if (r + 0.5) / rows <= s_equator]
    # The skirt rings this texture's rows lie on, projected into the image.
    ring_px = {r: G.to_image(G.skirt_ring(fit, min(1.0, (r + 0.5) / rows / s_equator)), pivot, scale) for r in skirt_rows}
    # A column whose face edge already lies outside the picture (a template
    # face placed by guess) takes the subject's mean colour, not black.
    opaque = array[..., 3] > 0.5
    fallback = array[opaque, :3].mean(axis=0) if opaque.any() else np.zeros(3)
    out = np.zeros((rows, columns, 3), dtype=np.float32)
    for c in range(columns):
        u = c / columns * n
        i0, i1 = int(math.floor(u)) % n, (int(math.floor(u)) + 1) % n
        f = u - math.floor(u)
        held: np.ndarray | None = None
        for r in range(rows):
            s = (r + 0.5) / rows
            if r in ring_px:
                px = ring_px[r][i0] * (1 - f) + ring_px[r][i1] * f
                rgba = sample(array, px[None, 0], px[None, 1])[0]
                # Past the silhouette the column keeps its last opaque colour.
                if rgba[3] >= 0.5:
                    held = rgba[:3]
                elif held is None:
                    held = fallback
                t = s / s_equator
                shade = 1 - (1 - SKULL_SHADE_EQUATOR) * t
            else:
                shade = SKULL_SHADE_EQUATOR - (SKULL_SHADE_EQUATOR - SKULL_SHADE_POLE) * (s - s_equator) / (1 - s_equator)
            out[r, c] = (held if held is not None else np.zeros(3)) * shade
    return to_image(out, "RGB")


# --- The neck -----------------------------------------------------------------


def neck_texture(
    array: np.ndarray, frame: G.FaceFrame, neck: G.Mesh, pivot: tuple[float, float, float], scale: float,
    size: tuple[int, int] = NECK_TEXTURE,
) -> Image.Image:
    """The picture's neck, wrapped: column u maps to the picture's x at
    radius * sin(angle) (so the back mirrors the front), rows to the neck's
    height; samples clamp to the opaque run of each row; alpha fades out at
    the bottom."""
    columns, rows = size
    radius_px = G.NECK_RADIUS * frame.width
    y_top = float(neck.positions[:, 1].max())
    y_bottom = float(neck.positions[:, 1].min())
    out = np.zeros((rows, columns, 4), dtype=np.float32)
    H, W = array.shape[:2]
    for r in range(rows):
        v = (r + 0.5) / rows
        y_model = y_top + (y_bottom - y_top) * v
        py = float(np.clip(pivot[1] - y_model / scale, 0, H - 1))
        row = array[int(round(py))]
        band_lo = int(max(0, frame.centre_x - 1.3 * radius_px))
        band_hi = int(min(W, frame.centre_x + 1.3 * radius_px))
        opaque = np.flatnonzero(row[band_lo:band_hi, 3] > 0.5)
        if len(opaque):
            xl, xr = band_lo + opaque[0], band_lo + opaque[-1]
        else:
            xl, xr = frame.centre_x, frame.centre_x
        # The picture's own neck column, never its edges or what lies beside
        # it (hair, a collar): the outer fifth of the cylinder repeats the
        # last sample.
        xl, xr = max(xl, frame.centre_x - 0.8 * radius_px), min(xr, frame.centre_x + 0.8 * radius_px)
        u = (np.arange(columns) + 0.5) / columns
        angle = (u - 0.5) * 2 * math.pi
        px = np.clip(frame.centre_x + radius_px * np.sin(angle), xl, xr)
        colour = sample(array, px, np.full(columns, py))[:, :3]
        fade = float(np.clip((1 - v) / NECK_FADE, 0, 1))
        # The sides of a neck turn away from the light; the picture's front
        # column is the brightest it gets.
        side = np.abs(np.sin(angle))
        out[r, :, :3] = colour * (1 - NECK_SIDE_SHADE * side)[:, None]
        out[r, :, 3] = fade * fade * (3 - 2 * fade)
    return to_image(out)


# --- Cards --------------------------------------------------------------------


def _feather(box_w: int, box_h: int) -> np.ndarray:
    """The 2D head layer's feather over a box: linear ramps on the sides,
    the top, and a deep one at the neck; 1 inside."""
    x = np.arange(box_w) + 0.5
    y = np.arange(box_h) + 0.5
    side = box_w * G.HEAD_FEATHER_SIDE
    top = box_h * G.HEAD_FEATHER_TOP
    neck = box_h * G.HEAD_FEATHER_NECK
    fx = np.minimum(np.clip(x / side, 0, 1), np.clip((box_w - x) / side, 0, 1))
    fy = np.minimum(np.clip(y / top, 0, 1), np.clip((box_h - y) / neck, 0, 1))
    return fy[:, None] * fx[None, :]


def _oval_hole(shape: tuple[int, ...], oval_px: np.ndarray, feather: float, dilate: float = 0.0) -> np.ndarray:
    """0 inside the oval (grown by `dilate` px), rising to 1 over `feather`
    px outside it."""
    mask = Image.new("L", (shape[1], shape[0]), 0)
    ImageDraw.Draw(mask).polygon([(float(x), float(y)) for x, y in oval_px], fill=255)
    inside = np.asarray(mask) > 0
    # The distances alone: scipy's stub also allows the indices it returns
    # only when asked for them.
    outside_distance = cast(np.ndarray, distance_transform_edt(~inside))
    return np.asarray(G.smoothstep((outside_distance - dilate) / max(feather, 1e-6)), dtype=np.float32)


def hair_card_image(
    array: np.ndarray, frame: G.FaceFrame, box: tuple[float, float, float, float], oval_px: np.ndarray,
) -> Image.Image:
    """The head region of the cut-out, feathered as the 2D head layer is,
    with the face oval cut out (feathered outward)."""
    x0, y0, x1, y1 = (int(round(v)) for v in box)
    crop = array[y0:y1, x0:x1].copy()
    hole = _oval_hole(crop.shape[:2], oval_px - np.array((x0, y0)), G.OVAL_HOLE_FEATHER * frame.width)
    crop[..., 3] *= _feather(x1 - x0, y1 - y0) * hole
    return to_image(crop)


def body_card_image(
    array: np.ndarray, frame: G.FaceFrame, box: tuple[float, float, float, float], oval_px: np.ndarray,
) -> tuple[Image.Image, tuple[int, int, int, int]]:
    """What the head layer leaves of the cut-out, with a wider face hole,
    cropped to its opaque box; (image, crop box)."""
    x0, y0, x1, y1 = (int(round(v)) for v in box)
    whole = array.copy()
    head = np.zeros(whole.shape[:2], dtype=np.float32)
    head[y0:y1, x0:x1] = _feather(x1 - x0, y1 - y0)
    hole = _oval_hole(whole.shape[:2], oval_px, G.OVAL_HOLE_FEATHER * frame.width, BODY_HOLE_DILATE * frame.width)
    whole[..., 3] *= (1 - head) * hole
    rows = np.flatnonzero((whole[..., 3] > 0.02).any(axis=1))
    cols = np.flatnonzero((whole[..., 3] > 0.02).any(axis=0))
    if not len(rows) or not len(cols):
        crop = (0, 0, 1, 1)
    else:
        crop = (int(cols[0]), int(rows[0]), int(cols[-1]) + 1, int(rows[-1]) + 1)
    return to_image(whole[crop[1]:crop[3], crop[0]:crop[2]]), crop


# --- The mouth interior -------------------------------------------------------


def cavity_texture(lip: tuple[float, float, float], shades: tuple[float, float, float], size: tuple[int, int] = (8, 32)) -> Image.Image:
    """A vertical gradient of the lip colour at the three shades."""
    w, h = size
    v = (np.arange(h) + 0.5) / h
    top, mid, bottom = shades
    shade = np.where(v < 0.5, top + (mid - top) * v * 2, mid + (bottom - mid) * (v - 0.5) * 2)
    column = np.asarray(lip)[None, :] * shade[:, None]
    return to_image(np.repeat(column[:, None, :], w, axis=1), "RGB")


def tongue_colour(lip: tuple[float, float, float]) -> tuple[float, float, float]:
    red = np.asarray(TONGUE_RED) / 255.0
    r, g, b = (float(v) for v in (np.asarray(lip) * 0.5 + red * 0.5))
    return r, g, b


def _row_y(points: np.ndarray, row: list[int], x: np.ndarray) -> np.ndarray:
    """The y of a lip row at each x, by linear interpolation along the row."""
    p = points[row]
    order = np.argsort(p[:, 0])
    return np.interp(x, p[order, 0], p[order, 1])


def teeth_textures(teeth: np.ndarray, rig_points: np.ndarray, size: tuple[int, int] = TEETH_TEXTURE) -> tuple[Image.Image, Image.Image]:
    """Upper and lower teeth bands from a teeth photograph and its rig: for
    each column between the inner mouth corners, the band between the inner
    upper lip and the dark inter-arch gap, and between the gap and the inner
    lower lip (the gap found as the 2D dental model finds it: the darkest
    row of the middle of the aperture, preferring 60% down)."""
    columns, rows = size
    p = np.asarray(rig_points, dtype=np.float64)
    xl, xr = p[78, 0], p[308, 0]
    if xr - xl < 4:
        raise ValueError("teeth photograph has no mouth width")
    xs = xl + (np.arange(columns) + 0.5) / columns * (xr - xl)
    top = _row_y(p, T.UPPER_LIP_ROWS[0] + [78, 308], xs)
    bottom = _row_y(p, T.LOWER_LIP_ROWS[0] + [78, 308], xs)
    upper = np.zeros((rows, columns, 4), dtype=np.float32)
    lower = np.zeros((rows, columns, 4), dtype=np.float32)
    v = (np.arange(rows) + 0.5) / rows
    for c in range(columns):
        t, b = top[c], bottom[c]
        if b - t < 2:
            continue
        ys = np.arange(math.ceil(t + (b - t) * 0.28), math.floor(b - (b - t) * 0.18))
        if len(ys):
            green = sample(teeth, np.full(len(ys), xs[c]), ys.astype(float))[:, 1]
            preference = np.abs((ys - t) / (b - t) - 0.6) * 20 / 255
            split = float(ys[np.argmin(green + preference)])
        else:
            split = t + (b - t) * 0.6
        upper[:, c, :3] = sample(teeth, np.full(rows, xs[c]), t + (split - t) * v)[:, :3]
        lower[:, c, :3] = sample(teeth, np.full(rows, xs[c]), split + (b - split) * v)[:, :3]
        upper[:, c, 3] = 1.0
        lower[:, c, 3] = 1.0
    # A soft edge top and bottom so the band does not end in a hard line,
    # and a fade over the outer fifth of each side: the photograph's mouth
    # corners are dark cavity, not teeth.
    edge = np.minimum(np.clip(v * rows / 3, 0, 1), np.clip((1 - v) * rows / 3, 0, 1))
    u = (np.arange(columns) + 0.5) / columns
    side = np.minimum(np.clip(u / TEETH_SIDE_FADE, 0, 1), np.clip((1 - u) / TEETH_SIDE_FADE, 0, 1))
    upper[..., 3] *= edge[:, None] * side[None, :]
    lower[..., 3] *= edge[:, None] * side[None, :]
    return to_image(upper), to_image(lower)


def flat_teeth_texture(size: tuple[int, int] = TEETH_TEXTURE, teeth: int = 8) -> Image.Image:
    """A toon's teeth: an ivory band with faint lines between the teeth."""
    columns, rows = size
    out = np.zeros((rows, columns, 4), dtype=np.float32)
    out[..., :3] = np.asarray(FLAT_TOOTH) / 255.0
    out[..., 3] = 1.0
    for k in range(1, teeth):
        x = int(columns * k / teeth)
        out[:, max(0, x - 1):x + 1, :3] = np.asarray(FLAT_TOOTH_LINE) / 255.0
    v = (np.arange(rows) + 0.5) / rows
    edge = np.minimum(np.clip(v * rows / 3, 0, 1), np.clip((1 - v) * rows / 3, 0, 1))
    u = (np.arange(columns) + 0.5) / columns
    side = np.minimum(np.clip(u / TEETH_SIDE_FADE, 0, 1), np.clip((1 - u) / TEETH_SIDE_FADE, 0, 1))
    out[..., 3] *= edge[:, None] * side[None, :]
    return to_image(out)
