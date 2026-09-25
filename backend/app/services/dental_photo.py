"""The browser's teeth check, on the server: will a mouth photo draw teeth?

A mouth photo ("ee", upper teeth showing) feeds the photographic mouth
(embed/src/mouth/dental-oral-surface.ts). The browser lifts the enamel out
of it and refuses a photo whose upper row is too small, too sparse or only
the tips of the teeth (`DentalPhotoError`). That refusal happens on every
visitor's page, and it is silent there: the widget keeps the classic mouth.

For a photo a person uploads the owner sees the refusal in the Mouth panel.
A photo the server makes itself (the AI "ee" photo, services.mouth_photo)
has no one looking at it before it is published, so the server applies the
browser's own test first and never stores a photo the browser would drop.
This module is that test, ported line for line:

- `mouth_canvas`: the 640x480 canvas the browser draws, the source photo
  rotated onto the mouth axis, 512 px per mouth width (61 to 291), the
  centre of the upper inner lip (13) at (320, 120), clipped to the inner
  lip ring;
- `extract_dental_layers`: dental-texture-model.ts `extractDentalLayers`
  (colour seeds, the dark inter-arch split, speck removal, column and
  notch bridging);
- `dental_crown_coverage` and the thresholds of the DentalOralSurface
  constructor.

The one place it cannot be exact is the rasterisation (a browser's canvas
smoothing and anti-aliased clip against Pillow's bilinear warp and hard
polygon), which moves a few edge pixels; the thresholds are counts of
hundreds and a width of 110 px, so that does not decide a photo.

It also measures where the upper incisal edge is (`upper_incisal_edge`), in
the source photo's pixels: what services.mouth_photo fits the teeth height
from. Everything here is CPU work.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
from PIL import Image, ImageDraw

# The browser's extraction canvas (DentalOralSurface).
CANVAS_WIDTH, CANVAS_HEIGHT = 640, 480
MOUTH_PIXELS = 512
ORIGIN = (320.0, 120.0)
# DentalOralSurface's refusal: an upper row narrower than this, with fewer
# opaque pixels than this, or whose central crowns are shorter than this
# fraction of the mouth width, is `DentalPhotoError`.
MIN_UPPER_WIDTH = 110
MIN_UPPER_COUNT = 180
MIN_CROWN_COVERAGE = 0.10
# A pixel counts as drawn from this alpha (the extraction's own threshold),
# and as solid enamel from this one (the coverage and incisal measures).
DRAWN_ALPHA = 40
SOLID_ALPHA = 150


@dataclass
class DentalLayer:
    """One arch lifted out of the canvas: RGBA pixels, bounding box (x, y,
    width, height; width 0 when empty) and the number of drawn pixels."""

    pixels: np.ndarray
    box: tuple[int, int, int, int]
    count: int


@dataclass
class DentalCheck:
    ok: bool
    upper_width: int
    upper_count: int
    coverage: float
    # The upper row's lowest drawn row + 1 (its bounding box's bottom), and
    # the median incisal edge of the central incisors, in canvas pixels;
    # None when the upper row is empty.
    upper_bottom: int | None
    central_edge: float | None


def _smooth(a: float, b: float, n: np.ndarray) -> np.ndarray:
    t = np.clip((n - a) / (b - a), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def enamel_mask(rgb: np.ndarray) -> np.ndarray:
    """dental-texture-model.ts `enamelMask`, over an (..., 3) array."""
    rgb = np.asarray(rgb, dtype=np.float64)
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    red = np.maximum(r, 1.0)
    return (
        _smooth(70, 130, np.minimum(np.minimum(r, g), b))
        * _smooth(0.72, 0.86, g / red)
        * _smooth(0.57, 0.76, b / red)
    )


def _js_round(value: float) -> int:
    """Math.round: halves go up (Python's round goes to even)."""
    return int(math.floor(value + 0.5))


def mouth_frame(points: np.ndarray) -> tuple[float, float, float, float, float]:
    """(cx, cy, ux, uy, scale): the canvas transform of a photo whose
    landmarks are `points`, as DentalOralSurface builds it."""
    a, b = points[61], points[291]
    width = float(math.hypot(b[0] - a[0], b[1] - a[1]))
    if width < 2:
        raise ValueError("mouth too small")
    ux, uy = (b[0] - a[0]) / width, (b[1] - a[1]) / width
    return float(points[13][0]), float(points[13][1]), float(ux), float(uy), MOUTH_PIXELS / width


def to_canvas(frame, x: float, y: float) -> tuple[float, float]:
    cx, cy, ux, uy, scale = frame
    return (
        ORIGIN[0] + ((x - cx) * ux + (y - cy) * uy) * scale,
        ORIGIN[1] + (-(x - cx) * uy + (y - cy) * ux) * scale,
    )


def from_canvas(frame, x: float, y: float) -> tuple[float, float]:
    """The inverse of `to_canvas`: canvas pixels back to the photo's."""
    cx, cy, ux, uy, scale = frame
    dx, dy = (x - ORIGIN[0]) / scale, (y - ORIGIN[1]) / scale
    return cx + dx * ux - dy * uy, cy + dx * uy + dy * ux


def mouth_canvas(image: Image.Image, points: np.ndarray, inner_ring: list[int]) -> np.ndarray:
    """The browser's extraction canvas: (480, 640, 4) uint8 RGBA, transparent
    outside the inner lip ring and outside the photo."""
    frame = mouth_frame(points)
    cx, cy, ux, uy, scale = frame
    # Pillow's affine takes the inverse map, canvas → photo.
    inverse = (
        ux / scale, -uy / scale, cx - (ORIGIN[0] * ux - ORIGIN[1] * uy) / scale,
        uy / scale, ux / scale, cy - (ORIGIN[0] * uy + ORIGIN[1] * ux) / scale,
    )
    size = (CANVAS_WIDTH, CANVAS_HEIGHT)
    rgb = image.convert("RGB").transform(
        size, Image.Transform.AFFINE, inverse, resample=Image.Resampling.BILINEAR
    )
    inside_photo = Image.new("L", image.size, 255).transform(
        size, Image.Transform.AFFINE, inverse, resample=Image.Resampling.NEAREST
    )
    clip = Image.new("L", size, 0)
    ImageDraw.Draw(clip).polygon(
        [to_canvas(frame, *points[i]) for i in inner_ring], fill=255
    )
    alpha = np.minimum(np.asarray(clip), np.asarray(inside_photo))
    out = np.zeros((CANVAS_HEIGHT, CANVAS_WIDTH, 4), dtype=np.uint8)
    out[..., :3] = np.asarray(rgb)
    out[..., 3] = alpha
    out[alpha == 0] = 0
    return out


def _boundary(contour: list[tuple[float, float]], x: float) -> float:
    for i in range(1, len(contour)):
        if x <= contour[i][0]:
            (ax, ay), (bx, by) = contour[i - 1], contour[i]
            t = max(0.0, min(1.0, (x - ax) / max(0.001, bx - ax)))
            return ay + (by - ay) * t
    return contour[-1][1]


def extract_dental_layers(
    image: np.ndarray,
    upper_contour: list[tuple[float, float]],
    lower_contour: list[tuple[float, float]],
) -> tuple[DentalLayer, DentalLayer]:
    """dental-texture-model.ts `extractDentalLayers` on an (H, W, 4) uint8
    canvas: the upper and lower arches."""
    from scipy.ndimage import label

    height, width = image.shape[:2]
    if len(upper_contour) < 2 or len(lower_contour) < 2:
        raise ValueError("Invalid dental image or lip contours")
    upper = sorted(upper_contour, key=lambda p: p[0])
    lower = sorted(lower_contour, key=lambda p: p[0])
    source_alpha = image[..., 3].astype(np.int32)
    seeds = (source_alpha >= DRAWN_ALPHA) & (enamel_mask(image[..., :3]) >= 0.35)
    # The split search averages green over five columns, clamped at the edges.
    green = np.pad(image[..., 1].astype(np.float64), ((0, 0), (2, 2)), mode="edge")
    green5 = sum(green[:, i:i + width] for i in range(5))

    drawn = [np.zeros((height, width), dtype=bool), np.zeros((height, width), dtype=bool)]
    x0 = math.ceil(max(upper[0][0], lower[0][0]))
    x1 = math.floor(min(upper[-1][0], lower[-1][0]))
    for x in range(max(0, x0), min(width - 1, x1) + 1):
        top, bottom = _boundary(upper, x), _boundary(lower, x)
        if bottom - top < 2:
            continue
        # The dark gap between the arches, not a rectangular crop.
        split = top + (bottom - top) * 0.6
        start = max(0, math.ceil(top + (bottom - top) * 0.28))
        stop = min(height, bottom - (bottom - top) * 0.18)
        ys = np.arange(start, math.ceil(stop)) if stop > start else np.arange(0)
        ys = ys[ys < stop]
        if len(ys):
            score = green5[ys, x] / 5 + np.abs((ys - top) / (bottom - top) - 0.6) * 20
            split = float(ys[int(np.argmin(score))])
        first = max(0, math.ceil(top))
        rows = np.arange(first, math.ceil(min(height, bottom)))
        rows = rows[rows < min(height, bottom)]
        if not len(rows):
            continue
        hit = rows[seeds[rows, x]]
        drawn[0][hit[hit < split], x] = True
        drawn[1][hit[hit >= split], x] = True

    layers = []
    for index, mask in enumerate(drawn):
        # Isolated highlights are not teeth.
        labels, found = label(mask)
        if found:
            sizes = np.bincount(labels.ravel())
            small = sizes < (150 if index == 0 else 12)
            small[0] = False
            mask = mask & ~small[labels]
        # Columns: the source's own shading from the top drawn pixel to the
        # bottom one, short unseeded runs of columns bridged.
        any_col = mask.any(axis=0)
        tops = np.full(width, np.nan)
        bottoms = np.full(width, np.nan)
        cols = np.flatnonzero(any_col)
        if len(cols):
            tops[cols] = mask[:, cols].argmax(axis=0)
            bottoms[cols] = height - 1 - mask[::-1, cols].argmax(axis=0)
        bridge = max(2, _js_round((x1 - x0) * 0.035))
        previous = -1
        for x in cols:
            if previous >= 0 and x - previous <= bridge:
                for n in range(previous + 1, x):
                    t = (n - previous) / (x - previous)
                    tops[n] = tops[previous] * (1 - t) + tops[x] * t
                    bottoms[n] = bottoms[previous] * (1 - t) + bottoms[x] * t
            previous = x
        region = np.zeros((height, width), dtype=bool)
        ys = np.arange(height)[:, None]
        finite = np.isfinite(tops)
        region[:, finite] = (ys >= np.ceil(tops[finite])) & (ys <= np.floor(bottoms[finite]))
        opaque = region & (source_alpha >= DRAWN_ALPHA)
        # Rows: short notches between crowns closed with their own pixels.
        filled = opaque.copy()
        for y in np.flatnonzero(opaque.any(axis=1)):
            xs = np.flatnonzero(opaque[y])
            gaps = np.flatnonzero((np.diff(xs) > 1) & (np.diff(xs) <= bridge))
            for g in gaps:
                filled[y, xs[g] + 1:xs[g + 1]] = True
        copied = region | filled
        pixels = np.zeros_like(image)
        pixels[copied] = image[copied]
        final = pixels[..., 3] >= DRAWN_ALPHA
        count = int(final.sum())
        if count:
            ys_, xs_ = np.nonzero(final)
            box = (int(xs_.min()), int(ys_.min()),
                   int(xs_.max() - xs_.min() + 1), int(ys_.max() - ys_.min() + 1))
        else:
            box = (width, height, 0, 0)
        layers.append(DentalLayer(pixels, box, count))
    return layers[0], layers[1]


def _central_columns(center: float, mouth_width: float, width: int) -> range:
    return range(max(0, math.ceil(center - mouth_width * 0.025)),
                 min(width - 1, math.floor(center + mouth_width * 0.025)) + 1)


def dental_crown_coverage(layer: DentalLayer, center: float = ORIGIN[0],
                          mouth_width: float = MOUTH_PIXELS) -> float:
    """dental-texture-model.ts `dentalCrownCoverage`: the median height of
    the central crowns, as a fraction of the mouth width."""
    solid = layer.pixels[..., 3] >= SOLID_ALPHA
    heights = []
    for x in _central_columns(center, mouth_width, solid.shape[1]):
        rows = np.flatnonzero(solid[:, x])
        heights.append(int(rows[-1] - rows[0] + 1) if len(rows) else 0)
    if not heights or mouth_width <= 0:
        return 0.0
    return sorted(heights)[len(heights) // 2] / mouth_width


def upper_incisal_edge(layer: DentalLayer) -> float | None:
    """The median bottom (+1) of the solid upper enamel over the central
    columns, in canvas rows: the edge of the central incisors. None when
    fewer than half the central columns have enamel."""
    solid = layer.pixels[..., 3] >= SOLID_ALPHA
    columns = list(_central_columns(ORIGIN[0], MOUTH_PIXELS, solid.shape[1]))
    edges = []
    for x in columns:
        rows = np.flatnonzero(solid[:, x])
        if len(rows):
            edges.append(float(rows[-1] + 1))
    if len(edges) * 2 < len(columns):
        return None
    return float(np.median(edges))


def check(image: Image.Image, points: np.ndarray, inner_ring: list[int]) -> DentalCheck:
    """The DentalOralSurface constructor's verdict on a mouth photo, with
    the measures behind it. CPU work."""
    points = np.asarray(points, dtype=np.float64)
    canvas = mouth_canvas(image, points, inner_ring)
    frame = mouth_frame(points)
    ring = [to_canvas(frame, *points[i]) for i in inner_ring]
    upper_layer, _ = extract_dental_layers(canvas, ring[10:] + [ring[0]], ring[:11])
    x, y, width, height = upper_layer.box
    coverage = dental_crown_coverage(upper_layer)
    ok = (
        width >= MIN_UPPER_WIDTH
        and upper_layer.count >= MIN_UPPER_COUNT
        and coverage >= MIN_CROWN_COVERAGE
    )
    return DentalCheck(
        ok=ok,
        upper_width=width,
        upper_count=upper_layer.count,
        coverage=round(coverage, 4),
        upper_bottom=y + height if width else None,
        central_edge=upper_incisal_edge(upper_layer) if width else None,
    )
