"""The embed's teeth-photo acceptance, ported: will this photo be drawn?

The continuous mouth draws a person's own teeth from a photo of them
(`oral`: an image and its rig). DentalOralSurface (embed/src/mouth/
dental-oral-surface.ts) cuts the upper and lower arches out of it with
extractDentalLayers (dental-texture-model.ts) and throws DentalPhotoError
unless the upper arch is wide, solid and shows enough of the central
crowns. That error drops the whole avatar to the classic mouth, and the
bundled-motion fallback reuses the same photo, so it fails again.

The backend therefore asks the embed's own question before it hands a photo
on as the teeth photo: this module reproduces the extraction canvas (the
photo turned into the mouth's frame, a mouth width to 512 pixels, clipped to
the inner lip ring) and the layer extraction step for step, and applies the
same three limits. Keep it in step with those two files: the constants and
the order of every pass are theirs.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
from PIL import Image, ImageDraw

MOUTH_LEFT, MOUTH_RIGHT, UPPER_INNER = 61, 291, 13

# DentalOralSurface's extraction canvas: 640 x 480, the inner upper lip (13)
# at (320, 120), one mouth width (61 to 291) = 512 pixels, corners level.
CANVAS_WIDTH, CANVAS_HEIGHT = 640, 480
CANVAS_ORIGIN = (320.0, 120.0)
CANVAS_MOUTH_WIDTH = 512.0

# Its acceptance limits for the upper arch.
MIN_ARCH_WIDTH = 110
MIN_ARCH_PIXELS = 180
MIN_CROWN_COVERAGE = 0.10

# extractDentalLayers.
_ALPHA_SEED = 40
_ENAMEL_SEED = 0.35
_MIN_COMPONENT = (150, 12)  # upper, lower
_CROWN_ALPHA = 150
# Anti-aliasing of the canvas clip: sub-samples per pixel side.
_CLIP_SUPERSAMPLE = 4


def _smooth(a: float, b: float, n: np.ndarray) -> np.ndarray:
    t = np.clip((n - a) / (b - a), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def enamel_mask(rgb: np.ndarray) -> np.ndarray:
    """dental-texture-model.ts enamelMask, vectorised over (..., 3)."""
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    red = np.maximum(r, 1.0)
    return (_smooth(70, 130, np.minimum(np.minimum(r, g), b))
            * _smooth(0.72, 0.86, g / red) * _smooth(0.57, 0.76, b / red))


def _js_round(value: float) -> int:
    return int(math.floor(value + 0.5))


@dataclass(frozen=True)
class Layer:
    """One arch as extractDentalLayers returns it: RGBA pixels (H, W, 4),
    the bounding box of its opaque pixels and how many there are."""

    pixels: np.ndarray
    box: tuple[int, int, int, int]  # x, y, width, height
    count: int


@dataclass(frozen=True)
class Acceptance:
    """What DentalOralSurface would decide about this photo."""

    accepted: bool
    arch_width: int
    arch_pixels: int
    crown_coverage: float
    # The upper arch's lowest opaque row below the inner upper lip, in the
    # photo's mouth widths: the edge the renderer seats. None without teeth.
    upper_edge: float | None

    def as_dict(self) -> dict:
        return {"accepted": self.accepted, "arch_width": self.arch_width,
                "arch_pixels": self.arch_pixels, "crown_coverage": round(self.crown_coverage, 4),
                "upper_edge": None if self.upper_edge is None else round(self.upper_edge, 4)}


def _mouth_axes(points: np.ndarray) -> tuple[np.ndarray, np.ndarray, float] | None:
    a, b = points[MOUTH_LEFT], points[MOUTH_RIGHT]
    width = float(math.hypot(b[0] - a[0], b[1] - a[1]))
    if not width > 0:
        return None
    ux = (b - a) / width
    return ux, np.array([-ux[1], ux[0]]), width


def extraction_canvas(image: Image.Image, points: np.ndarray, inner_ring: list[int]) -> tuple[np.ndarray, np.ndarray]:
    """The canvas DentalOralSurface reads: RGBA (480, 640, 4) uint8, and the
    inner lip ring in canvas pixels.

    The browser draws the photo through the mouth-frame transform with
    bilinear smoothing, clipped (anti-aliased) to the inner lip ring; here
    every canvas pixel centre is mapped back into the photo and sampled
    bilinearly, and the clip's coverage is the ring's polygon drawn at
    _CLIP_SUPERSAMPLE times the resolution and averaged.
    """
    from scipy.ndimage import map_coordinates

    axes = _mouth_axes(points)
    if axes is None:
        raise ValueError("the teeth photo's mouth has no width")
    ux, uy, width = axes
    scale = CANVAS_MOUTH_WIDTH / width
    centre = points[UPPER_INNER]
    ox, oy = CANVAS_ORIGIN

    def to_canvas(p: np.ndarray) -> np.ndarray:
        d = p - centre
        return np.stack((ox + (d @ ux) * scale, oy + (d @ uy) * scale), axis=-1)

    ring = to_canvas(points[inner_ring])

    rgb = np.asarray(image.convert("RGB"), dtype=np.float64)
    height, width_px = rgb.shape[:2]
    cx, cy = np.meshgrid(np.arange(CANVAS_WIDTH) + 0.5, np.arange(CANVAS_HEIGHT) + 0.5)
    # Canvas to photo: the inverse of the similarity above.
    u, v = (cx - ox) / scale, (cy - oy) / scale
    px = centre[0] + u * ux[0] + v * uy[0]
    py = centre[1] + u * ux[1] + v * uy[1]
    # Photo pixel i covers [i, i + 1): its centre is i + 0.5.
    inside = (px >= 0) & (px <= width_px) & (py >= 0) & (py <= height)
    sampled = np.stack([
        map_coordinates(rgb[..., k], [py - 0.5, px - 0.5], order=1, mode="nearest") for k in range(3)
    ], axis=-1)

    s = _CLIP_SUPERSAMPLE
    mask = Image.new("L", (CANVAS_WIDTH * s, CANVAS_HEIGHT * s), 0)
    ImageDraw.Draw(mask).polygon([(float(x) * s, float(y) * s) for x, y in ring], fill=255)
    coverage = np.asarray(mask, dtype=np.float64).reshape(CANVAS_HEIGHT, s, CANVAS_WIDTH, s).mean(axis=(1, 3))
    alpha = np.where(inside, coverage, 0.0)

    canvas = np.zeros((CANVAS_HEIGHT, CANVAS_WIDTH, 4), dtype=np.uint8)
    canvas[..., :3] = np.clip(np.round(sampled), 0, 255).astype(np.uint8)
    canvas[..., 3] = np.clip(np.round(alpha), 0, 255).astype(np.uint8)
    canvas[canvas[..., 3] == 0] = 0  # a transparent canvas pixel is (0, 0, 0, 0)
    return canvas, ring


def _boundary(contour: np.ndarray, x: float) -> float:
    """dental-texture-model.ts boundary(): `contour` sorted by x."""
    for i in range(1, len(contour)):
        if x <= contour[i, 0]:
            a, b = contour[i - 1], contour[i]
            t = min(1.0, max(0.0, (x - a[0]) / max(0.001, b[0] - a[0])))
            return float(a[1] + (b[1] - a[1]) * t)
    return float(contour[-1, 1])


def extract_dental_layers(image: np.ndarray, upper_contour: np.ndarray,
                          lower_contour: np.ndarray) -> tuple[Layer, Layer]:
    """dental-texture-model.ts extractDentalLayers, pass for pass.

    `image` is RGBA (H, W, 4) uint8; contours are (n, 2) canvas points."""
    from scipy.ndimage import label

    height, width = image.shape[:2]
    upper = np.asarray(upper_contour, dtype=np.float64)
    lower = np.asarray(lower_contour, dtype=np.float64)
    # JavaScript's sort is stable: keep equal x in their given order.
    upper = upper[np.argsort(upper[:, 0], kind="stable")]
    lower = lower[np.argsort(lower[:, 0], kind="stable")]
    data = [np.zeros_like(image), np.zeros_like(image)]
    x0 = math.ceil(max(upper[0, 0], lower[0, 0]))
    x1 = math.floor(min(upper[-1, 0], lower[-1, 0]))
    green = image[..., 1].astype(np.float64)
    enamel = enamel_mask(image[..., :3].astype(np.float64))
    source_alpha = image[..., 3]

    for x in range(max(0, x0), min(width - 1, x1) + 1):
        top, bottom = _boundary(upper, x), _boundary(lower, x)
        if bottom - top < 2:
            continue
        # The dark inter-arch gap: the lowest green (5 columns, clamped at
        # the edges) near 60% of the opening.
        split, best = top + (bottom - top) * 0.6, math.inf
        y_from = max(0, math.ceil(top + (bottom - top) * 0.28))
        y_to = min(height, bottom - (bottom - top) * 0.18)
        ys = np.arange(y_from, math.ceil(y_to)) if y_to > y_from else np.arange(0)
        ys = ys[ys < y_to]
        if len(ys):
            columns = np.clip(np.arange(x - 2, x + 3), 0, width - 1)
            value = green[np.ix_(ys, columns)].sum(axis=1) / 5
            score = value + np.abs((ys - top) / (bottom - top) - 0.6) * 20
            k = int(np.argmin(score))  # the first minimum, as the strict `<`
            if score[k] < best:
                split = float(ys[k])
        rows = np.arange(max(0, math.ceil(top)), min(height, math.ceil(bottom)))
        rows = rows[rows < bottom]
        keep = rows[(source_alpha[rows, x] >= _ALPHA_SEED) & (enamel[rows, x] >= _ENAMEL_SEED)]
        for index, chosen in enumerate((keep[keep < split], keep[keep >= split])):
            data[index][chosen, x] = image[chosen, x]

    layers = []
    for index, layer in enumerate(data):
        # Isolated highlights: 4-connected components below the size limit.
        opaque = layer[..., 3] >= _ALPHA_SEED
        labels, found = label(opaque)
        if found:
            sizes = np.bincount(labels.ravel())
            small = sizes < _MIN_COMPONENT[index]
            small[0] = False
            layer[..., 3][small[labels]] = 0
        opaque = layer[..., 3] >= _ALPHA_SEED
        any_column = opaque.any(axis=0)
        tops = np.full(width, np.nan)
        bottoms = np.full(width, np.nan)
        tops[any_column] = np.argmax(opaque, axis=0)[any_column]
        bottoms[any_column] = (height - 1 - np.argmax(opaque[::-1], axis=0))[any_column]

        # Bridge short unseeded columns (interdental shadows).
        bridge = max(2, _js_round((x1 - x0) * 0.035))
        previous = -1
        for x in range(width):
            if not math.isfinite(tops[x]):
                continue
            if previous >= 0 and x - previous <= bridge:
                for n in range(previous + 1, x):
                    t = (n - previous) / (x - previous)
                    tops[n] = tops[previous] * (1 - t) + tops[x] * t
                    bottoms[n] = bottoms[previous] * (1 - t) + bottoms[x] * t
            previous = x

        # Refill each column's span from the photo, shading and all.
        filled = np.zeros_like(image)
        for x in range(width):
            if not math.isfinite(tops[x]):
                continue
            y0, y1 = math.ceil(tops[x]), math.floor(bottoms[x])
            if y1 >= y0:
                filled[y0:y1 + 1, x] = image[y0:y1 + 1, x]

        # Close short horizontal notches with their original pixels. A
        # filled pixel lies behind the scan, so each row's gaps are those
        # between the opaque pixels it had before the pass.
        for y in range(height):
            xs = np.flatnonzero(filled[y, :, 3] >= _ALPHA_SEED)
            if len(xs) < 2:
                continue
            gaps = np.flatnonzero((np.diff(xs) > 1) & (np.diff(xs) <= bridge))
            for g in gaps:
                a, b = xs[g] + 1, xs[g + 1]
                filled[y, a:b] = image[y, a:b]

        opaque = filled[..., 3] >= _ALPHA_SEED
        count = int(opaque.sum())
        if count:
            ys, xs = np.nonzero(opaque)
            box = (int(xs.min()), int(ys.min()), int(xs.max() - xs.min() + 1), int(ys.max() - ys.min() + 1))
        else:
            box = (width, height, 0, 0)
        layers.append(Layer(filled, box, count))
    return layers[0], layers[1]


def crown_coverage(layer: Layer, centre: float = CANVAS_ORIGIN[0],
                   mouth_width: float = CANVAS_MOUTH_WIDTH) -> float:
    """dental-texture-model.ts dentalCrownCoverage: the median height of
    solid (alpha >= 150) enamel over the central 5% of the mouth, in mouth
    widths."""
    height, width = layer.pixels.shape[:2]
    solid = layer.pixels[..., 3] >= _CROWN_ALPHA
    heights = []
    x = max(0, math.ceil(centre - mouth_width * 0.025))
    while x <= min(width - 1, centre + mouth_width * 0.025):
        rows = np.flatnonzero(solid[:, x])
        heights.append(0 if len(rows) == 0 else int(rows[-1] - rows[0] + 1))
        x += 1
    if not heights or mouth_width <= 0:
        return 0.0
    return sorted(heights)[len(heights) // 2] / mouth_width


def accept_teeth_photo(image: Image.Image, points: np.ndarray, inner_ring: list[int]) -> Acceptance:
    """DentalOralSurface's constructor test on this photo and its rig's
    points: the upper arch at least MIN_ARCH_WIDTH canvas pixels wide, with
    MIN_ARCH_PIXELS of enamel and MIN_CROWN_COVERAGE mouth widths of
    central crown. CPU work (about a tenth of a second)."""
    points = np.asarray(points, dtype=np.float64)
    if _mouth_axes(points) is None:
        return Acceptance(False, 0, 0, 0.0, None)
    canvas, ring = extraction_canvas(image, points, inner_ring)
    upper, _ = extract_dental_layers(canvas, np.vstack((ring[10:], ring[:1])), ring[:11])
    coverage = crown_coverage(upper)
    x, y, w, h = upper.box
    edge = None if upper.count == 0 else (y + h - CANVAS_ORIGIN[1]) / CANVAS_MOUTH_WIDTH
    accepted = w >= MIN_ARCH_WIDTH and upper.count >= MIN_ARCH_PIXELS and coverage >= MIN_CROWN_COVERAGE
    return Acceptance(accepted, w, upper.count, coverage, edge)
