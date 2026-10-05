/**
 * How sharp the picture is: the width of its crispest edges, in its own
 * pixels, read once from the texture.
 *
 * The photographic mouth feathers the edge of its aperture, and the teeth
 * photo is softened, to the width of the picture's own edges. That width
 * was read across the lip seam (character-mouth.ts edgeWidth), and the seam
 * of a closed mouth is the wrong edge to read: it is a shadow in a crease,
 * a rounded shading, 3 to 5 px wide in a crisp photograph as in a soft scan.
 * The edge the aperture stands for is a depth edge (lip against cavity),
 * and a picture's depth edges are as sharp as its sharpest strong edges
 * anywhere near: the lashes against the sclera, the iris, a nostril's rim,
 * a drawn line. So this reads the strong edges in a box round the mouth
 * and in a box round each eye, measures each one's width along its own
 * gradient (the 10-90% rise of the luma profile, sub-pixel), and takes a
 * low percentile of the widths in the sharpest box: the sharpest this
 * picture gets.
 *
 * Grain is not an edge. A scan's noise reads as 1 to 2 px "edges" to any
 * local measure, so an edge counts only above a contrast no grain reaches
 * (EDGE_CONTRAST) and only where the gradient keeps its direction for a
 * couple of pixels along the edge (EDGE_COHERENCE); measured on the three
 * published people and the lab Reference, the scan's grain stops under 50
 * levels while the lashes, the iris and the lip corners of a crisp photo
 * carry 80 to 150.
 *
 * Everything is in texture pixels. A 4K photograph's edges are wider in
 * pixels than a 500 px one's, and so is the feather drawn from them, in
 * the same pixels: nothing here is clamped in px.
 */

export interface Pt { x: number; y: number }
export interface Box { x: number; y: number; w: number; h: number }

/** The luma of a box of the texture, row-major; NaN where the texture is
 *  transparent (a cut-out's hole). */
export interface LumaField { width: number; height: number; luma: Float32Array }

/** The percentile of the strong edges' widths that is the box's sharpness:
 *  low, "the sharpest this picture gets", but not the single sharpest
 *  edge, which is one pixel pair somewhere. */
export const SHARPNESS_SHARE = 0.15;
/** A step counts as an edge above this contrast (luma levels): under it,
 *  a scan's grain, over it, a picture's features. */
export const EDGE_CONTRAST = 50;
/** The gradient must keep its direction (cosine >= EDGE_ALIGN, magnitude
 *  >= EDGE_HOLD of the centre's) this far each way along the edge. */
export const EDGE_COHERENCE = 2;
export const EDGE_ALIGN = 0.8;
export const EDGE_HOLD = 0.5;
/** Only the strongest gradients are probed: those above this share of
 *  the box's gradient magnitudes. */
export const STRONG_SHARE = 0.9;
/** A box says nothing with fewer edges than this. */
export const MIN_EDGES = 40;
/** At most this many probes per box; a huge box is strided. */
export const MAX_PROBES = 4000;
/** How much of a mouth width the box round it spans, across and down. */
export const MOUTH_BOX: readonly [number, number] = [2.2, 1.6];
/** ...and of an eye's width, the box round it. */
export const EYE_BOX: readonly [number, number] = [1.8, 1.2];

const EYES: readonly [number, number][] = [[33, 133], [362, 263]];

/** The boxes to read, in texture pixels: round the mouth (landmarks 61 and
 *  291 are its corners), and round each eye (33/133, 362/263); clamped to
 *  the texture, dropped when degenerate. */
export function sharpnessBoxes(points: readonly (Pt | undefined)[], width: number, height: number): Box[] {
  const boxes: Box[] = [];
  const add = (a: Pt | undefined, b: Pt | undefined, span: readonly [number, number]) => {
    if (!a || !b) return;
    const w = Math.hypot(b.x - a.x, b.y - a.y);
    if (!(w > 4)) return;
    const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
    const x0 = Math.max(0, Math.floor(cx - (w * span[0]) / 2)), y0 = Math.max(0, Math.floor(cy - (w * span[1]) / 2));
    const x1 = Math.min(width, Math.ceil(cx + (w * span[0]) / 2)), y1 = Math.min(height, Math.ceil(cy + (w * span[1]) / 2));
    if (x1 - x0 >= 24 && y1 - y0 >= 24) boxes.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
  };
  add(points[61], points[291], MOUTH_BOX);
  for (const [i, j] of EYES) add(points[i], points[j], EYE_BOX);
  return boxes;
}

/** A luma field from RGBA pixels (getImageData's), transparent ones NaN. */
export function lumaField(data: Uint8ClampedArray, width: number, height: number): LumaField {
  const luma = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const k = i * 4;
    luma[i] = data[k + 3] < 128 ? NaN : 0.299 * data[k] + 0.587 * data[k + 1] + 0.114 * data[k + 2];
  }
  return { width, height, luma };
}

/** How far each way the luma profile across an edge is read, px: enough
 *  for an edge several px wide, more on a big picture whose edges are. */
export function profileReach(boxWidth: number): number {
  return Math.max(8, Math.min(24, Math.round(boxWidth / 40)));
}

/**
 * The widths of the strong, coherent edges in `field`, in pixels each:
 * the 10-90% rise of the luma profile along the edge's own gradient, read
 * sub-pixel, over the monotone run of the profile through the edge.
 */
export function edgeWidths(field: LumaField, reach = profileReach(field.width)): number[] {
  const { width: w, height: h, luma } = field;
  if (w < 2 * reach + 3 || h < 2 * reach + 3) return [];
  // Sobel gradients; a hole in the texture makes no gradient.
  const gx = new Float32Array(w * h), gy = new Float32Array(w * h), mag = new Float32Array(w * h);
  let maxMag = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const a = luma[i - w - 1], b = luma[i - w], c = luma[i - w + 1], d = luma[i - 1], f = luma[i + 1], g = luma[i + w - 1], k = luma[i + w], l = luma[i + w + 1];
      const sx = (c + 2 * f + l - a - 2 * d - g) / 8, sy = (g + 2 * k + l - a - 2 * b - c) / 8;
      if (Number.isNaN(sx) || Number.isNaN(sy)) continue;
      gx[i] = sx; gy[i] = sy;
      const m = Math.hypot(sx, sy);
      mag[i] = m;
      if (m > maxMag) maxMag = m;
    }
  }
  if (!(maxMag > 0)) return [];
  // The strong gradients: above the STRONG_SHARE percentile, by histogram.
  const bins = 512, hist = new Uint32Array(bins);
  let counted = 0;
  for (let y = reach; y < h - reach; y++) {
    for (let x = reach; x < w - reach; x++) {
      hist[Math.min(bins - 1, Math.floor((mag[y * w + x] / maxMag) * bins))]++;
      counted++;
    }
  }
  let acc = 0, bin = 0;
  for (; bin < bins; bin++) { acc += hist[bin]; if (acc >= counted * STRONG_SHARE) break; }
  const threshold = Math.max(1e-3, ((bin + 1) / bins) * maxMag);
  const candidates: number[] = [];
  for (let y = reach; y < h - reach; y++) {
    for (let x = reach; x < w - reach; x++) {
      if (mag[y * w + x] > threshold) candidates.push(y * w + x);
    }
  }
  const stride = Math.max(1, Math.ceil(candidates.length / MAX_PROBES));
  const at = (x: number, y: number): number => {
    // Bilinear luma; NaN off the field or over a hole.
    const ix = Math.floor(x), iy = Math.floor(y);
    if (ix < 0 || iy < 0 || ix + 1 >= w || iy + 1 >= h) return NaN;
    const tx = x - ix, ty = y - iy, i = iy * w + ix;
    return (luma[i] * (1 - tx) + luma[i + 1] * tx) * (1 - ty) + (luma[i + w] * (1 - tx) + luma[i + w + 1] * tx) * ty;
  };
  const widths: number[] = [];
  const profile = new Float64Array(2 * reach + 1);
  for (let n = 0; n < candidates.length; n += stride) {
    const i = candidates[n], x = i % w, y = (i - x) / w;
    const m = mag[i], nx = gx[i] / m, ny = gy[i] / m;
    // The crest of the edge: no stronger gradient a pixel either way along it.
    if (m < mag[Math.round(y + ny) * w + Math.round(x + nx)] || m < mag[Math.round(y - ny) * w + Math.round(x - nx)]) continue;
    // Coherent: the gradient holds its direction along the edge.
    let coherent = true;
    for (let s = 1; s <= EDGE_COHERENCE && coherent; s++) {
      for (const sign of [1, -1]) {
        const qx = Math.round(x - ny * s * sign), qy = Math.round(y + nx * s * sign);
        if (qx < 0 || qy < 0 || qx >= w || qy >= h) { coherent = false; break; }
        const q = qy * w + qx, mq = mag[q];
        if (mq < EDGE_HOLD * m || (gx[q] * nx + gy[q] * ny) / mq < EDGE_ALIGN) { coherent = false; break; }
      }
    }
    if (!coherent) continue;
    // The luma along the gradient, rising with it.
    let whole = true;
    for (let t = -reach; t <= reach; t++) {
      const v = at(x + nx * t, y + ny * t);
      if (Number.isNaN(v)) { whole = false; break; }
      profile[t + reach] = v;
    }
    if (!whole) continue;
    const width = riseWidth(profile, reach);
    if (width !== null) widths.push(width);
  }
  return widths;
}

/** The 10-90% rise, px, of the monotone run of `profile` through its
 *  middle sample `c`; null under EDGE_CONTRAST of contrast or when a
 *  crossing is missing. A rise of 0.5 levels against the run is noise. */
export function riseWidth(profile: ArrayLike<number>, c: number): number | null {
  let lo = c, hi = c;
  while (lo > 0 && profile[lo - 1] <= profile[lo] + 0.5) lo--;
  while (hi < profile.length - 1 && profile[hi + 1] >= profile[hi] - 0.5) hi++;
  const min = profile[lo], max = profile[hi], contrast = max - min;
  if (!(contrast >= EDGE_CONTRAST)) return null;
  const cross = (level: number): number | null => {
    for (let k = lo; k < hi; k++) {
      if (profile[k] <= level && level <= profile[k + 1]) return k + (level - profile[k]) / Math.max(1e-9, profile[k + 1] - profile[k]);
    }
    return null;
  };
  const a = cross(min + 0.1 * contrast), b = cross(min + 0.9 * contrast);
  return a === null || b === null ? null : b - a;
}

/** The SHARPNESS_SHARE percentile of `widths`, or null with too few. */
export function boxSharpness(widths: readonly number[]): number | null {
  if (widths.length < MIN_EDGES) return null;
  const sorted = [...widths].sort((p, q) => p - q);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * SHARPNESS_SHARE))];
}

/** The picture's sharpness, px: the sharpest of its boxes that holds
 *  enough edges; null when none does (a flat picture, a tainted one). */
export function faceSharpness(fields: readonly LumaField[]): number | null {
  let best: number | null = null;
  for (const field of fields) {
    const s = boxSharpness(edgeWidths(field));
    if (s !== null && (best === null || s < best)) best = s;
  }
  return best;
}
