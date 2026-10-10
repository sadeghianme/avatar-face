/**
 * Where on a face each expression region reaches (expression-rig.ts): the
 * face's frame, and each landmark's weight in a region, read once from the
 * rest mesh. Pure functions of the rest landmarks, in the face's frame
 * (IODs, x along the eye line to the picture's right, y down the face).
 *
 * Every weight fades to nothing at the face's outline (FACE_OVAL), so the
 * mesh's edge, the neck band, the head's field and a cut-out's silhouette
 * never move: there is no boundary for a seam to show at. A side's weight
 * fades out across the midline. The upper and lower inner lip of each
 * column share one weight, so an opening the speech makes is carried.
 */
import type { Point } from "./geometry";
import { FACE_OVAL, INNER_LOWER, INNER_UPPER, LOWER_ROWS, UPPER_ROWS } from "./jaw-rig";
import { EYE_CORNERS, IRISES, LANDMARK_COUNT, LOWER_LIDS, UPPER_LIDS } from "./landmarks";
import { REGION_SPECS, type Region, type RegionMask } from "./expression-table";

/** The band inside the face's outline over which a weight fades in, IODs. */
export const OUTLINE_FADE = 0.2;
/** Over this band across the midline a side's weight fades out, IODs: a
 *  raised brow does not raise the other one. */
export const MIDLINE_BAND = 0.1;
/** The band over which a mask lets a region in, IODs. The cheek's under
 *  the lower lid is narrow on purpose: a wide one (0.15) held the skin just
 *  under the eye while the cheek rose into it, crushing a triangle there on
 *  mehdi_avatar's smile at rest. */
const MASK_BAND = { corners: 0.03, lids: 0.08 } as const;
/** The lids' regions fade out toward the eye's corners over this share of
 *  the eye's width: the corners stay. */
const LID_CORNER_FADE = 0.3;
/** The mouth's field, in half mouth widths: nothing at the lips' middle,
 *  rising to the corner, carrying the cheek beyond it this far, and fading
 *  above and below the lips over this band. */
const MOUTH = { middle: 0.15, beyond: 1.1, lips: 0.25, band: 0.9 } as const;
/** A lower lid within this share of the iris's radius beyond its rim is
 *  let go of (over that band); and the skin under a held lid is held
 *  this far below it, IODs (then let go over as far again). */
const IRIS_CLEAR = 0.35;
const LID_HOLD = 0.06;
/** The first iris landmark; the irises' centres. */
const IRIS_FIRST = 468;
const IRIS_CENTRES: ReadonlySet<number> = new Set(IRISES.map(([c]) => c));

export const smoothstep = (t: number): number => {
  const s = Math.max(0, Math.min(1, t));
  return s * s * (3 - 2 * s);
};

/** The face's frame: the eyes' midpoint, the eye line (u, to the picture's
 *  right; down is (-uy, ux)), and the IOD. */
export interface FaceFrame {
  readonly ox: number;
  readonly oy: number;
  readonly ux: number;
  readonly uy: number;
  readonly iod: number;
}

/** The frame of the face resting at `base`, or null for one too small. */
export function faceFrame(base: readonly Point[]): FaceFrame | null {
  const centre = ([a, b]: [number, number]) => ({ x: (base[a].x + base[b].x) / 2, y: (base[a].y + base[b].y) / 2 });
  let l = centre(EYE_CORNERS[0]),
    r = centre(EYE_CORNERS[1]);
  if (l.x > r.x) [l, r] = [r, l];
  const iod = Math.hypot(r.x - l.x, r.y - l.y);
  if (!(iod > 4)) return null;
  return { ox: (l.x + r.x) / 2, oy: (l.y + r.y) / 2, ux: (r.x - l.x) / iod, uy: (r.y - l.y) / iod, iod };
}

/** `p` in the face's frame, IODs. */
export function toFace(f: FaceFrame, p: Point): Point {
  const dx = p.x - f.ox,
    dy = p.y - f.oy;
  return { x: (dx * f.ux + dy * f.uy) / f.iod, y: (-dx * f.uy + dy * f.ux) / f.iod };
}

/** A point of the face's frame (IODs) on the canvas, px. */
export function fromFace(f: FaceFrame, p: Point): Point {
  return { x: f.ox + (p.x * f.ux - p.y * f.uy) * f.iod, y: f.oy + (p.x * f.uy + p.y * f.ux) * f.iod };
}

/** A displacement in the face's frame (IODs: x to the picture's right, y
 *  down) as canvas px, into `out`. */
export function toCanvas(f: FaceFrame, x: number, y: number, out: { x: number; y: number }): void {
  out.x = (x * f.ux - y * f.uy) * f.iod;
  out.y = (x * f.uy + y * f.ux) * f.iod;
}

/** Each landmark's distance to the face's outline (FACE_OVAL, closed), IODs. */
export function outlineDistance(local: readonly Point[]): Float64Array {
  return Float64Array.from(local, (p) => outlinePointDistance(local, p));
}

/** `p`'s distance to the outline of the face resting at `local`, IODs. */
export function outlinePointDistance(local: readonly Point[], p: Point): number {
  let best = Infinity;
  for (let k = 0; k < FACE_OVAL.length; k++)
    best = Math.min(best, segmentDistance(p, local[FACE_OVAL[k]], local[FACE_OVAL[(k + 1) % FACE_OVAL.length]]));
  return best;
}

/** How far straight up the face (face frame, -y) from `p` the outline of
 *  the face resting at `local` is, IODs; the nearest distance to it when
 *  no part of it is above `p`. */
export function outlineAbove(local: readonly Point[], p: Point): number {
  let best = Infinity;
  for (let k = 0; k < FACE_OVAL.length; k++) {
    const a = local[FACE_OVAL[k]],
      b = local[FACE_OVAL[(k + 1) % FACE_OVAL.length]];
    if ((a.x - p.x) * (b.x - p.x) > 0 || a.x === b.x) continue;
    const y = a.y + ((b.y - a.y) * (p.x - a.x)) / (b.x - a.x);
    if (y < p.y) best = Math.min(best, p.y - y);
  }
  return Number.isFinite(best) ? best : outlinePointDistance(local, p);
}

function segmentDistance(p: Point, a: Point, b: Point): number {
  const vx = b.x - a.x,
    vy = b.y - a.y;
  const len = vx * vx + vy * vy;
  const t = len > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / len)) : 0;
  return Math.hypot(p.x - a.x - vx * t, p.y - a.y - vy * t);
}

/** How much of `side`'s weight a point at face-frame x keeps across the
 *  midline. */
export function midlineKeep(x: number, side: 0 | 1): number {
  return smoothstep(((side ? 1 : -1) * x) / MIDLINE_BAND + 0.5);
}

/**
 * Every landmark's weight in `region` on `side` (face frame): the region's
 * own field (a smooth bump of the distance to its nearest anchor, (1-d²)²,
 * or the mouth's field), times its mask, the outline's fade and the
 * midline's; the inner lips paired. An iris's centre never moves; its rim
 * moves only with a lid it is hidden under, as the lid does (a raised
 * lower lid drew a visible rim up into a point: the cartoon's smile).
 */
export function regionWeights(
  local: readonly Point[],
  region: Region,
  side: 0 | 1,
  outline: Float64Array
): Float64Array {
  const spec = REGION_SPECS[region];
  if (spec.mask === "lips") return lipsField(local, side, outline);
  const field = spec.mask === "mouth" ? mouthField(local, side) : bumpField(local, spec.anchors[side], spec.reach);
  const mask = maskOf(spec.mask, local, side);
  const w = new Float64Array(local.length);
  for (let i = 0; i < Math.min(local.length, LANDMARK_COUNT); i++) {
    if (i >= IRIS_FIRST && (region !== "upperLid" || IRIS_CENTRES.has(i) || !underUpperLid(local, i, side))) continue;
    const f = field(local[i]);
    if (!f) continue;
    w[i] = f * mask(local[i]) * smoothstep(outline[i] / OUTLINE_FADE) * midlineKeep(local[i].x, side);
  }
  if (region === "lowerLid" || region === "cheek") followLowerLid(local, w, side);
  return pairInnerLips(w);
}

function bumpField(local: readonly Point[], anchors: readonly number[], reach: number): (p: Point) => number {
  const at = anchors.map((i) => local[i]);
  return (p) => {
    let best = 0;
    for (const a of at) {
      const d2 = ((p.x - a.x) ** 2 + (p.y - a.y) ** 2) / (reach * reach);
      if (d2 < 1) best = Math.max(best, (1 - d2) ** 2);
    }
    return best;
  };
}

/** The mouth's field on `side`: in the mouth's frame (half widths), 0 at
 *  the lips' middle, rising smoothly to 1 at the corner, so the lip line
 *  bends evenly with no pinch; beyond the corner the cheek mass carried and
 *  fading; above and below the lips fading. */
function mouthField(local: readonly Point[], side: 0 | 1): (p: Point) => number {
  const a = local[61],
    b = local[291];
  const cx = (a.x + b.x) / 2,
    cy = (a.y + b.y) / 2;
  const half = Math.max(1e-6, Math.hypot(b.x - a.x, b.y - a.y) / 2);
  const ux = (b.x - a.x) / (2 * half),
    uy = (b.y - a.y) / (2 * half);
  return (p) => {
    const along = ((p.x - cx) * ux + (p.y - cy) * uy) / half;
    const across = Math.abs((p.y - cy) * ux - (p.x - cx) * uy) / half;
    const sx = side ? along : -along;
    const lateral =
      sx <= 1 ? smoothstep((sx - MOUTH.middle) / (1 - MOUTH.middle)) : 1 - smoothstep((sx - 1) / MOUTH.beyond);
    return lateral * (1 - smoothstep((across - MOUTH.lips) / MOUTH.band));
  };
}

/**
 * The lips' red on `side`, pressed: each row of the upper lip from the
 * inner lip (0) to its outer edge (1) weighted by how far out it is (down
 * presses it toward the mouth's line), the lower lip's the same negated
 * (it rises), fading toward the corners over the outer fifth of the
 * mouth; the inner lips never move, so the opening the speech makes is
 * kept; the midline's fade splits the lips between the sides.
 */
function lipsField(local: readonly Point[], side: 0 | 1, outline: Float64Array): Float64Array {
  const w = new Float64Array(local.length);
  const a = local[61],
    b = local[291];
  const cx = (a.x + b.x) / 2;
  const half = Math.max(1e-6, Math.abs(b.x - a.x) / 2);
  for (const [rows, sign] of [
    [UPPER_ROWS, 1],
    [LOWER_ROWS, -1],
  ] as const) {
    rows.forEach((row, r) => {
      const depth = r / (rows.length - 1);
      for (const i of row) {
        const p = local[i];
        const corner = 1 - smoothstep((Math.abs(p.x - cx) / half - 0.8) / 0.2);
        w[i] = sign * depth * corner * midlineKeep(p.x, side) * smoothstep(outline[i] / OUTLINE_FADE);
      }
    });
  }
  return w;
}

/** An iris rim landmark hidden under `side`'s lower lid moves as the lid
 *  landmark nearest it does (in `w`): the skin under the lid rising past
 *  a still rim folded the triangles between (a smile on a face whose
 *  lower lid covers the iris's foot). */
function followLowerLid(local: readonly Point[], w: Float64Array, side: 0 | 1): void {
  const line = lidLine(local, side, false);
  for (const i of IRISES[side][1]) {
    if (!(local[i].y > line(local[i].x))) continue;
    let best = LOWER_LIDS[side][0];
    for (const l of LOWER_LIDS[side])
      if (
        Math.hypot(local[l].x - local[i].x, local[l].y - local[i].y) <
        Math.hypot(local[best].x - local[i].x, local[best].y - local[i].y)
      )
        best = l;
    w[i] = w[best];
  }
}

/**
 * How free the skin at a point under `side`'s lower lid is to rise: as
 * free as the lid's landmark nearest it. A lower lid that sits over the
 * iris (a drawn character's large one, or a face whose lid covers the
 * iris's foot) is held where it does: raising it into the iris pinched the
 * pupil's foot into a point, and raising the skin under a held lid folded
 * the lid's triangles against the hidden rim. Points further below than
 * LID_HOLD (IODs) are free.
 */
function lidHeld(local: readonly Point[], side: 0 | 1): (p: Point) => number {
  const [centre, rim] = IRISES[side];
  const c = local[centre];
  const r = rim.reduce((sum, i) => sum + Math.hypot(local[i].x - c.x, local[i].y - c.y), 0) / rim.length;
  const lid = LOWER_LIDS[side].map((i) => local[i]);
  const free = lid.map((p) => smoothstep((Math.hypot(p.x - c.x, p.y - c.y) - r) / (IRIS_CLEAR * r)));
  return (p) => {
    let k = 0;
    for (let j = 1; j < lid.length; j++)
      if (Math.hypot(lid[j].x - p.x, lid[j].y - p.y) < Math.hypot(lid[k].x - p.x, lid[k].y - p.y)) k = j;
    const below = p.y - lid[k].y;
    return free[k] + (1 - free[k]) * smoothstep((below - LID_HOLD) / LID_HOLD);
  };
}

/** Whether iris rim landmark `i` lies hidden under `side`'s upper lid,
 *  above the lid's line at its x. */
function underUpperLid(local: readonly Point[], i: number, side: 0 | 1): boolean {
  return local[i].y < lidLine(local, side, true)(local[i].x);
}

/** `side`'s upper (or lower) lid as a function of face-frame x, corner to
 *  corner, held level beyond the corners. */
export function lidLine(local: readonly Point[], side: 0 | 1, upper: boolean): (x: number) => number {
  const ids = [...EYE_CORNERS[side], ...(upper ? UPPER_LIDS : LOWER_LIDS)[side]];
  const line = ids.map((i) => local[i]).sort((p, q) => p.x - q.x);
  return (x) => {
    if (x <= line[0].x) return line[0].y;
    for (let k = 1; k < line.length; k++) {
      if (x <= line[k].x) {
        const t = (x - line[k - 1].x) / Math.max(1e-9, line[k].x - line[k - 1].x);
        return line[k - 1].y + (line[k].y - line[k - 1].y) * t;
      }
    }
    return line[line.length - 1].y;
  };
}

/**
 * `w` with each inner-lip column's two landmarks (the upper and the lower
 * inner lip at one place along the mouth) given one weight, their mean: the
 * two move together, so the opening the speech makes there is carried
 * exactly, on a mouth slightly open at rest too.
 */
export function pairInnerLips(w: Float64Array): Float64Array {
  for (let k = 0; k < INNER_UPPER.length; k++) {
    const u = INNER_UPPER[k],
      l = INNER_LOWER[k];
    w[u] = w[l] = (w[u] + w[l]) / 2;
  }
  return w;
}

/** The mask `kind` on `side`, as a function of a point (face frame). */
function maskOf(kind: RegionMask, local: readonly Point[], side: 0 | 1): (p: Point) => number {
  const [c0, c1] = EYE_CORNERS[side];
  const cornerY = (local[c0].y + local[c1].y) / 2;
  const eyeWidth = Math.hypot(local[c1].x - local[c0].x, local[c1].y - local[c0].y);
  const awayFromCorners = (p: Point): number => {
    const d = Math.min(
      Math.hypot(p.x - local[c0].x, p.y - local[c0].y),
      Math.hypot(p.x - local[c1].x, p.y - local[c1].y)
    );
    return smoothstep(d / (LID_CORNER_FADE * eyeWidth));
  };
  switch (kind) {
    case "aboveCorners":
      return (p) => smoothstep((cornerY - p.y) / MASK_BAND.corners) * awayFromCorners(p);
    case "belowCorners":
      return (p) => smoothstep((p.y - cornerY) / MASK_BAND.corners) * awayFromCorners(p) * lidHeld(local, side)(p);
    case "belowLids": {
      const lidBottom = Math.max(...LOWER_LIDS[side].map((i) => local[i].y));
      return (p) => smoothstep((p.y - lidBottom) / MASK_BAND.lids) * lidHeld(local, side)(p);
    }
    case "mouth": {
      // Nothing above the nose's base (subnasale, landmark 2).
      const noseY = local[2].y;
      return (p) => smoothstep((p.y - noseY) / 0.08);
    }
    case "lips":
      return () => 1;
  }
}
