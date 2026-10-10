/**
 * Where each brow's hair really is (docs/emotions.md, "The brows"), read
 * from the picture: a fitted face mesh puts its brow landmarks near the
 * brows, not on them. On mehdi_avatar the picture's right brow's upper
 * edge landmarks sit 0.1 IOD up the forehead and its hair lies below the
 * "lower edge" row; a rigid move of the landmarks then left the hair in
 * triangles that stretched, which is the thick, fuzzy brow the owner
 * rejected. So the hair's own band is measured once, when the expressions
 * are first laid on a face, column by column across the brow: a vertical
 * luminance profile from the forehead down to just above the lid, the
 * darkest wide run in it (a wide run, so a lid's thin crease is not taken
 * for a brow), its edges where it crosses halfway between the hair and the
 * skin.
 *
 * The measurement is pure: the luminance comes from a sampler (textureLuma,
 * below, over the texture; a synthetic one in tests). In the face's frame
 * (IODs, x along the eye line to the picture's right, y down the face).
 */
import type { Point } from "./geometry";
import { BROW_LOWER, BROW_UPPER } from "./landmarks";

/** One brow's hair: columns inner end to outer, each its centre (face
 *  frame) and its half thickness, IODs. */
export interface BrowBand {
  readonly centre: readonly Point[];
  readonly half: readonly number[];
}

/** A luminance (0..255) at a point of the face frame, or NaN off the picture. */
export type LumaAt = (p: Point) => number;

/** Where the columns are, as shares of the landmarks' brow (0 inner, 1
 *  outer): a little past both ends, where hair often is. */
const COLUMNS = Array.from({ length: 13 }, (_, k) => -0.1 + (1.2 * k) / 12);
/** The search: this far above the landmarks' brow line, and down to this
 *  far above the lid, IODs; in steps of STEP. */
const SEARCH = { above: 0.15, lid: 0.035, below: 0.16 } as const;
const STEP = 0.004;
/** Each profile sample averages this many points across, this far apart. */
const ACROSS = [-0.012, 0, 0.012];
/** A column counts when its hair is this much darker than its skin: a share
 *  of the skin's luminance, and at least this many levels. */
const CONTRAST = { share: 0.12, least: 12 } as const;
/** A believable band, IODs: its thickness, and how far its centre may lie
 *  from the landmarks' line. */
const THICK = { least: 0.015, most: 0.24 } as const;
const STRAY = 0.16;
/** One column follows the next within a window round where the one
 *  before points: this many times its half thickness, this far more (and
 *  the way between's share), and filling at least this share of its
 *  thickness. */
const ALIKE = { thicker: 1.25, shift: 0.008, slope: 0.25, overlap: 0.4, depth: 0.4 } as const;
/** How many columns must be read for the band to be trusted. */
const ENOUGH = 7;

/** The hair is the part of a dark run darker than its darkest plus this
 *  share of the way to halfway. */
const CORE = 0.75;
/** A run brightening by this share of the hair's contrast between two
 *  darker parts of it is two runs. */
const SPLIT = 0.25;

/** The runs of `values` below `half` ([first, last] indices), each split
 *  where it rises by `rise` above its darker parts on both sides. */
function splitRuns(values: readonly number[], half: number, rise: number): [number, number][] {
  const runs: [number, number][] = [];
  let a = -1;
  for (let k = 0; k <= values.length; k++) {
    const below = k < values.length && values[k] < half;
    if (below && a < 0) a = k;
    if (!below && a >= 0) {
      runs.push(...split(values, a, k - 1, rise));
      a = -1;
    }
  }
  return runs;
}

function split(values: readonly number[], a: number, b: number, rise: number): [number, number][] {
  let at = -1,
    peak = -Infinity;
  let leftMin = values[a];
  for (let j = a + 1; j < b; j++) {
    leftMin = Math.min(leftMin, values[j - 1]);
    let rightMin = Infinity;
    for (let r = j + 1; r <= b; r++) rightMin = Math.min(rightMin, values[r]);
    if (values[j] - leftMin > rise && values[j] - rightMin > rise && values[j] > peak) {
      peak = values[j];
      at = j;
    }
  }
  return at < 0 ? [[a, b]] : [...split(values, a, at - 1, rise), ...split(values, at + 1, b, rise)];
}

/** The landmarks' brow on `side`: the mid line of its two edges, inner end
 *  first, as a function of the share along it. */
function landmarkLine(local: readonly Point[], side: 0 | 1): (t: number) => Point {
  const mid = BROW_UPPER[side].map((u, k) => {
    const a = local[u],
      b = local[BROW_LOWER[side][k]];
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  });
  return (t) => {
    const f = Math.max(-0.5, Math.min(mid.length - 0.5, t * (mid.length - 1)));
    const i = Math.max(0, Math.min(mid.length - 2, Math.floor(f)));
    const u = f - i;
    return { x: mid[i].x + (mid[i + 1].x - mid[i].x) * u, y: mid[i].y + (mid[i + 1].y - mid[i].y) * u };
  };
}

/** A dark run in one column: its top and bottom (face-frame y) and how
 *  much darkness it holds (its weight among the column's runs). */
export interface Run {
  readonly top: number;
  readonly bottom: number;
  readonly mass: number;
  /** How much darker than the column's skin it is on average, levels. */
  readonly depth: number;
}

/**
 * The dark runs in one profile `values` (top to bottom, STEP apart from
 * `y0`), the heaviest first: what is darker than halfway between the
 * column's skin and its darkest, each run split where it brightens between
 * two darker parts (a heavy brow over a dark lid crease are two runs, not
 * one); none when the column has nothing dark enough against its skin.
 */
export function hairRuns(values: readonly number[], y0: number): Run[] {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length < 8) return [];
  const skin = sorted[Math.floor(sorted.length * 0.85)];
  const dark = sorted[Math.floor(sorted.length * 0.03)];
  if (skin - dark < Math.max(CONTRAST.least, CONTRAST.share * skin)) return [];
  const half = (skin + dark) / 2;
  // An edge between samples, where the profile crosses halfway (a split's
  // edge, inside the dark, is where the split is).
  const edge = (inside: number, outside: number) => {
    const vi = values[inside],
      vo = values[outside];
    if (!(vo >= half)) return inside;
    return inside + ((outside - inside) * (half - vi)) / Math.max(1e-6, vo - vi);
  };
  return splitRuns(values, half, SPLIT * (skin - dark))
    .map(([a0, b0]) => {
      let mass = 0,
        sum = 0,
        least = Infinity,
        at = a0;
      for (let k = a0; k <= b0; k++) {
        mass += half - values[k];
        sum += values[k];
        if (values[k] < least) [least, at] = [values[k], k];
      }
      // The hair itself: the part of the run round its darkest that is
      // much darker than halfway. A painted brow over a shaded socket
      // (mehdi_avatar) is one run at halfway; its socket is skin, and
      // must stretch, not move with the hair.
      const core = least + CORE * (half - least);
      let a = at,
        b = at;
      while (a > a0 && values[a - 1] < core) a--;
      while (b < b0 && values[b + 1] < core) b++;
      const top = a > a0 ? a - 0.5 : edge(a0, a0 - 1);
      const bottom = b < b0 ? b + 0.5 : edge(b0, b0 + 1);
      return { top: y0 + top * STEP, bottom: y0 + bottom * STEP, mass, depth: skin - sum / (b0 - a0 + 1) };
    })
    .sort((p, q) => q.mass - p.mass);
}

/**
 * Each brow's hair on the face whose rest landmarks are `local`, read
 * through `luma`; null for a brow that could not be read (a tainted or flat
 * picture, a fringe over it, glasses): its landmarks stand for it then.
 * `lidTop(side, x)` is the upper lid's line.
 */
export function measureBrowBands(
  local: readonly Point[],
  luma: LumaAt,
  lidTop: (side: 0 | 1, x: number) => number
): [BrowBand | null, BrowBand | null] {
  return [measureOne(local, luma, lidTop, 0), measureOne(local, luma, lidTop, 1)];
}

function measureOne(
  local: readonly Point[],
  luma: LumaAt,
  lidTop: (side: 0 | 1, x: number) => number,
  side: 0 | 1
): BrowBand | null {
  const line = landmarkLine(local, side);
  const columns = COLUMNS.map((t) => {
    const at = line(t);
    const y0 = at.y - SEARCH.above;
    const y1 = Math.min(at.y + SEARCH.below, lidTop(side, at.x) - SEARCH.lid);
    if (!(y1 - y0 > 6 * STEP)) return { x: at.x, y: at.y, runs: [] as Run[] };
    const values: number[] = [];
    for (let y = y0; y <= y1; y += STEP) {
      let sum = 0;
      for (const dx of ACROSS) sum += luma({ x: at.x + dx, y });
      values.push(sum / ACROSS.length);
    }
    // A believable brow: not too thin or too thick, near the landmarks.
    const runs = hairRuns(values, y0).filter((r) => {
      const thick = r.bottom - r.top;
      return thick >= THICK.least && thick <= THICK.most && Math.abs((r.top + r.bottom) / 2 - at.y) <= STRAY;
    });
    return { x: at.x, y: at.y, runs };
  });
  // From the brow's middle (its heaviest run) outward, column by column,
  // the run most like the one before it, while one is like it: hair past
  // an end of the brow, or a column that would jump off it (the nose's
  // shadow, the orbit's under a tail), is not this brow.
  type Got = { x: number; top: number; bottom: number; depth: number };
  const middle = Math.floor(COLUMNS.length / 2);
  const first = columns[middle].runs[0];
  if (!first) return null;
  const start: Got = { x: columns[middle].x, top: first.top, bottom: first.bottom, depth: first.depth };
  const walk = (dir: 1 | -1): Got[] => {
    const out: Got[] = [];
    let prev = start,
      slope = 0;
    // Toward the midline a brow ends in its head, not a tail: the slope
    // is not carried on there (it would follow the nose's shadow down).
    // (The columns run inner end to outer.)
    const carry = dir === 1 ? 1 : 0.3;
    for (let k = middle + dir; k >= 0 && k < columns.length; k += dir) {
      const c = columns[k];
      // The window the brow can reach here: the column before carried on
      // along the brow's slope so far (a tail curves down), as thick as it
      // and a little more. The run that fills most of it, trimmed to it: a
      // run that merges the hair with a shadow below it keeps the hair.
      const dx = c.x - prev.x;
      const centre = (prev.top + prev.bottom) / 2 + carry * slope * dx;
      const reach = ALIKE.thicker * ((prev.bottom - prev.top) / 2) + ALIKE.shift + ALIKE.slope * Math.abs(dx);
      let best: Got | null = null;
      for (const r of c.runs) {
        const top = Math.max(r.top, centre - reach),
          bottom = Math.min(r.bottom, centre + reach);
        if (bottom - top < Math.max(THICK.least, ALIKE.overlap * (prev.bottom - prev.top))) continue;
        // As dark as hair: a shadow past the brow's end is fainter.
        if (r.depth < ALIKE.depth * prev.depth) continue;
        if (!best || bottom - top > best.bottom - best.top) best = { x: c.x, top, bottom, depth: r.depth };
      }
      if (!best) break;
      slope = ((best.top + best.bottom) / 2 - (prev.top + prev.bottom) / 2) / (dx || 1e-9);
      prev = best;
      out.push(prev);
    }
    return out;
  };
  const got = [...walk(-1).reverse(), start, ...walk(1)];
  if (got.length < ENOUGH) return null;
  // Smoothed along the brow (a 3-tap median, then a mean): one column's
  // stray hair or skin fleck does not bend the band.
  const tops = smooth(got.map((c) => c.top));
  const bottoms = smooth(got.map((c) => c.bottom));
  const centre = got.map((c, k) => ({ x: c.x, y: (tops[k] + bottoms[k]) / 2 }));
  const half = got.map((_, k) => Math.max(THICK.least, bottoms[k] - tops[k]) / 2);
  return extendByLandmarks({ centre, half }, landmarkBand(local, side));
}

/** A tail the columns could not follow (a drawn brow's steep outer end):
 *  how far a landmark column past the measured band's end may lie from
 *  it to be taken as more of it, IODs. */
const TAIL = 0.09;

/**
 * `band` with the landmarks' columns past each of its ends (`marks`, inner
 * end first), where they carry on from it: a steep tail the vertical
 * search loses is hair the landmarks still mark.
 */
function extendByLandmarks(band: BrowBand, marks: BrowBand): BrowBand {
  const centre = [...band.centre],
    half = [...band.half];
  const dir = Math.sign(centre[centre.length - 1].x - centre[0].x) || 1;
  // Past the outer end, outward; past the inner end, inward.
  for (let k = 0; k < marks.centre.length; k++) {
    const m = marks.centre[k];
    const end = centre[centre.length - 1];
    if ((m.x - end.x) * dir > 0 && Math.hypot(m.x - end.x, m.y - end.y) < TAIL) {
      centre.push(m);
      half.push(Math.min(marks.half[k], half[half.length - 1]));
    }
  }
  for (let k = marks.centre.length - 1; k >= 0; k--) {
    const m = marks.centre[k];
    const end = centre[0];
    if ((end.x - m.x) * dir > 0 && Math.hypot(m.x - end.x, m.y - end.y) < TAIL) {
      centre.unshift(m);
      half.unshift(Math.min(marks.half[k], half[0]));
    }
  }
  return { centre, half };
}

function smooth(v: readonly number[]): number[] {
  const med = v.map((_, k) => {
    const w = [v[Math.max(0, k - 1)], v[k], v[Math.min(v.length - 1, k + 1)]].sort((p, q) => p - q);
    return w[1];
  });
  return med.map((_, k) => (med[Math.max(0, k - 1)] + 2 * med[k] + med[Math.min(med.length - 1, k + 1)]) / 4);
}

/** The band the landmarks give `side`'s brow (its upper and lower edges),
 *  for a brow the picture could not tell. */
export function landmarkBand(local: readonly Point[], side: 0 | 1): BrowBand {
  const centre = BROW_UPPER[side].map((u, k) => {
    const a = local[u],
      b = local[BROW_LOWER[side][k]];
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  });
  const half = BROW_UPPER[side].map((u, k) => {
    const a = local[u],
      b = local[BROW_LOWER[side][k]];
    return Math.max(THICK.least, Math.hypot(a.x - b.x, a.y - b.y)) / 2;
  });
  return { centre, half };
}

/** The landmarks the picture is read round: the brows and the lids (the
 *  brows' search), and the cheeks (the skin's grain, expression-look.ts). */
const SEARCHED = [...BROW_UPPER.flat(), ...BROW_LOWER.flat(), 159, 386, 33, 263, 133, 362, 50, 280, 205, 425];

/**
 * The luminance of `texture` at a canvas point of the face laid as `mesh`
 * (its rest landmarks `basePoints` over the texture's `texPoints`), read
 * once round the brows and the cheeks; null when the picture cannot be
 * read (a cross-origin texture taints the canvas) or the face is
 * degenerate. Its `texel` is one texel's size in canvas px.
 */
export function textureLuma(
  texture: HTMLImageElement,
  mesh: { readonly basePoints: readonly Point[]; readonly texPoints: readonly Point[] }
): TextureLuma | null {
  const b = mesh.basePoints,
    t = mesh.texPoints;
  const kx = (t[263].x - t[33].x) / (b[263].x - b[33].x);
  const ky = (t[152].y - t[10].y) / (b[152].y - b[10].y);
  if (!(kx > 0) || !(ky > 0)) return null;
  const iod = Math.hypot(t[263].x - t[33].x, t[263].y - t[33].y);
  const xs = SEARCHED.map((i) => t[i].x),
    ys = SEARCHED.map((i) => t[i].y);
  const x0 = Math.max(0, Math.floor(Math.min(...xs) - 0.3 * iod));
  const y0 = Math.max(0, Math.floor(Math.min(...ys) - 0.35 * iod));
  const x1 = Math.min(texture.naturalWidth, Math.ceil(Math.max(...xs) + 0.3 * iod));
  const y1 = Math.min(texture.naturalHeight, Math.ceil(Math.max(...ys) + 0.12 * iod));
  const w = x1 - x0,
    h = y1 - y0;
  if (!(w > 0 && h > 0)) return null;
  let data: Uint8ClampedArray;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(texture, x0, y0, w, h, 0, 0, w, h);
    data = ctx.getImageData(0, 0, w, h).data;
  } catch {
    return null;
  }
  const read = (p: Point) => {
    const x = Math.round(t[33].x + (p.x - b[33].x) * kx) - x0;
    const y = Math.round(t[10].y + (p.y - b[10].y) * ky) - y0;
    if (x < 0 || y < 0 || x >= w || y >= h) return NaN;
    const k = 4 * (y * w + x);
    // A transparent pixel (a cut-out's outside) is no brow.
    if (data[k + 3] < 128) return NaN;
    return 0.299 * data[k] + 0.587 * data[k + 1] + 0.114 * data[k + 2];
  };
  return Object.assign(read, { texel: 1 / kx });
}

/** The picture's luminance at a canvas point, and one texel's size (px). */
export type TextureLuma = ((p: Point) => number) & { readonly texel: number };
