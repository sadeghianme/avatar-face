/**
 * The expressions laid on one face (docs/emotions.md): each region's weight
 * on each landmark, read once from the rest mesh, and the frame's pass that
 * moves the landmarks by the mix of expressions on (deform.ts).
 *
 * The displacement of a landmark is read at its REST position and added to
 * wherever the frame's mouth, lids and jaw put it, and the upper and lower
 * inner lip of each column take one weight, so an opening the speech makes
 * is carried, not changed: speech keeps the lips. The pass runs before the
 * head's turn in depth, which then turns the face it made.
 *
 * Every region fades to nothing at the face's outline (FACE_OVAL), so the
 * mesh's edge, the neck band, the head's field and a cut-out's silhouette
 * never move: there is no boundary for a seam to show at.
 */
import type { FaceMesh, Point } from "./geometry";
import { FoldCheck } from "./head-fold";
import { FACE_OVAL, INNER_LOWER, INNER_UPPER } from "./jaw-rig";
import { EYE_CORNERS, IRISES, LANDMARK_COUNT, LOWER_LIDS, UPPER_LIDS } from "./landmarks";
import {
  EXPRESSIONS,
  REGION_CAP,
  REGION_SPECS,
  REGIONS,
  SHAPE_NAMES,
  regionOf,
  type ExpressionGains,
  type Region,
  type RegionKey,
  type RegionMask,
  type ShapeName,
  type Vec,
} from "./expression-table";

/** The irises' centres, never moved (paint-eyes.ts paints the iris about
 *  them), and their rims, moved by the lids' regions only: a rim point
 *  hidden under a lid goes with it, or the lid moved over it would fold
 *  the triangles between them (Sakineh's upper lid on a surprise). */
const IRIS_CENTRES: ReadonlySet<number> = new Set(IRISES.map(([c]) => c));
const IRIS_FIRST = 468;
const LID_REGIONS: ReadonlySet<Region> = new Set(["upperLid", "lowerLid"]);
/** The band inside the face's outline over which a region fades in, IODs. */
const OUTLINE_FADE = 0.2;
/** The band over which a mask lets a region in, IODs. The cheek's under
 *  the lower lid is narrow on purpose: a wide one (0.15) held the skin just
 *  under the eye while the cheek rose into it, crushing a triangle there on
 *  mehdi_avatar's smile at rest. */
const MASK_BAND = { corners: 0.03, lids: 0.08, nose: 0.08 } as const;
/** Over this band across the face's midline a side's region fades out,
 *  IODs: a raised brow does not raise the other one. */
const MIDLINE_BAND = 0.1;
/** The lids' regions fade out toward the eye's corners over this share of
 *  the eye's width: the corners stay, and a lid moved up to them crushed
 *  the corner's thin triangles (with a spread vowel's own lid lift). */
const LID_CORNER_FADE = 0.3;
/** The nose's base (subnasale). */
const NOSE_BASE = 2;

/** How much of each shape is on, 0..1 each (the mixer's weights). */
export type ShapeMix = Readonly<Record<ShapeName, number>>;

/** One region on one side: the landmarks it moves and how much, and what
 *  each shape asks of it at 1 (IODs, [outward, down]). */
interface Channel {
  readonly region: Region;
  /** 0 the picture's left, 1 its right. */
  readonly side: 0 | 1;
  readonly index: Int32Array;
  readonly weight: Float64Array;
  readonly terms: readonly { readonly shape: ShapeName; readonly out: number; readonly down: number }[];
}

/** What each shape asks of `region` on `side`, from the table. */
function termsOf(region: Region, side: 0 | 1): Channel["terms"] {
  const terms: { shape: ShapeName; out: number; down: number }[] = [];
  for (const shape of SHAPE_NAMES) {
    for (const [key, v] of Object.entries(EXPRESSIONS[shape].regions) as [RegionKey, Vec][]) {
      const named = regionOf(key);
      if (named.region === region && named.sides.includes(side ? "right" : "left"))
        terms.push({ shape, out: v[0], down: v[1] });
    }
  }
  return terms;
}

const smoothstep = (t: number): number => {
  const s = Math.max(0, Math.min(1, t));
  return s * s * (3 - 2 * s);
};

/** The face's frame: the eyes' midpoint, the eye line (u, to the picture's
 *  right) and the down axis (n), in IODs. */
interface FaceFrame {
  ox: number;
  oy: number;
  ux: number;
  uy: number;
  iod: number;
}

function faceFrame(base: readonly Point[]): FaceFrame | null {
  const centre = ([a, b]: [number, number]) => ({ x: (base[a].x + base[b].x) / 2, y: (base[a].y + base[b].y) / 2 });
  let l = centre(EYE_CORNERS[0]),
    r = centre(EYE_CORNERS[1]);
  if (l.x > r.x) [l, r] = [r, l];
  const iod = Math.hypot(r.x - l.x, r.y - l.y);
  if (!(iod > 4)) return null;
  return { ox: (l.x + r.x) / 2, oy: (l.y + r.y) / 2, ux: (r.x - l.x) / iod, uy: (r.y - l.y) / iod, iod };
}

export class ExpressionRig {
  /** Each shape's ceiling on this face: lowered from 1 where the shape at
   *  1 would fold or crush one of the rig's triangles (calibrate). */
  readonly ceiling: Record<ShapeName, number>;
  private readonly channels: Channel[];
  private readonly frame: FaceFrame;
  /** This frame's displacement per channel, canvas px (x, y pairs). */
  private readonly shift: Float64Array;

  private constructor(
    base: readonly Point[],
    frame: FaceFrame,
    private readonly gains: ExpressionGains
  ) {
    this.frame = frame;
    const local = base.slice(0, LANDMARK_COUNT).map((p) => toFace(frame, p));
    const outline = outlineDistance(local);
    this.channels = [];
    for (const region of REGIONS) {
      for (const side of [0, 1] as const) {
        const weights = pairInnerLips(regionWeights(local, region, side, outline));
        const index: number[] = [];
        const weight: number[] = [];
        weights.forEach((w, i) => {
          if (w > 1e-4) {
            index.push(i);
            weight.push(w);
          }
        });
        this.channels.push({
          region,
          side,
          index: Int32Array.from(index),
          weight: Float64Array.from(weight),
          terms: termsOf(region, side),
        });
      }
    }
    this.shift = new Float64Array(this.channels.length * 2);
    this.ceiling = Object.fromEntries(SHAPE_NAMES.map((s) => [s, 1])) as Record<ShapeName, number>;
  }

  /**
   * The rig for the face resting at `base` (canvas px), its rig triangles
   * `triangles` checked for folds, its line's `gains`; null for a face too
   * small or with too few landmarks.
   */
  static build(
    base: readonly Point[],
    triangles: readonly (readonly [number, number, number])[],
    gains: ExpressionGains
  ): ExpressionRig | null {
    if (base.length < LANDMARK_COUNT) return null;
    const frame = faceFrame(base);
    if (!frame) return null;
    const rig = new ExpressionRig(base, frame, gains);
    rig.calibrate(base, triangles);
    return rig;
  }

  /** How far landmark `i` is moved by `region` on `side` at 1, 0..1. */
  weightOf(region: Region, side: 0 | 1, i: number): number {
    const ch = this.channels.find((c) => c.region === region && c.side === side)!;
    const k = ch.index.indexOf(i);
    return k < 0 ? 0 : ch.weight[k];
  }

  /**
   * Move the landmarks in `pts` by the expressions in `mix` at `scale` (the
   * tuning's expression): each region's displacement read off the table,
   * capped, scaled by the line's gain, at each landmark's rest weight.
   * Returns false, having moved nothing, when nothing is on.
   */
  apply(pts: Point[], mix: ShapeMix, scale: number): boolean {
    if (!(scale > 0) || !this.displace(mix, scale)) return false;
    const { channels, shift } = this;
    for (let c = 0; c < channels.length; c++) {
      const dx = shift[2 * c],
        dy = shift[2 * c + 1];
      if (!dx && !dy) continue;
      const { index, weight } = channels[c];
      for (let k = 0; k < index.length; k++) {
        const p = pts[index[k]];
        p.x += dx * weight[k];
        p.y += dy * weight[k];
      }
    }
    return true;
  }

  /** This frame's displacement per channel into `shift`; false for none. */
  private displace(mix: ShapeMix, scale: number): boolean {
    const { channels, shift, frame, ceiling } = this;
    let any = false;
    for (let c = 0; c < channels.length; c++) {
      const { region, side, terms } = channels[c];
      let out = 0,
        down = 0;
      for (const t of terms) {
        const on = Math.min(mix[t.shape], ceiling[t.shape]);
        if (!(on > 0)) continue;
        out += t.out * on;
        down += t.down * on;
      }
      // The region's cap, however many shapes sum in it; then the line's gain.
      const length = Math.hypot(out, down);
      const cap = REGION_CAP[region];
      const k = (length > cap ? cap / length : 1) * this.gains[region] * scale * frame.iod;
      // Outward is toward the picture's left on its left side.
      const sx = side ? out : -out;
      shift[2 * c] = (sx * frame.ux - down * frame.uy) * k;
      shift[2 * c + 1] = (sx * frame.uy + down * frame.ux) * k;
      if (shift[2 * c] || shift[2 * c + 1]) any = true;
    }
    return any;
  }

  /** Lower each shape's ceiling until, at it, none of the rig's triangles
   *  folds or is crushed on the rest face (head-fold.ts FoldCheck). */
  private calibrate(base: readonly Point[], triangles: readonly (readonly [number, number, number])[]): void {
    const n = Math.min(base.length, LANDMARK_COUNT);
    const tris = triangles.filter(([a, b, c]) => a < n && b < n && c < n);
    const check = new FoldCheck(tris, base, n, 0.0005 * this.frame.iod * this.frame.iod);
    const before = new Float64Array(2 * n);
    for (let i = 0; i < n; i++) {
      before[2 * i] = base[i].x;
      before[2 * i + 1] = base[i].y;
    }
    const pts = base.slice(0, n).map((p) => ({ x: p.x, y: p.y }));
    const report = { minAreaRatio: 1 };
    const folds = (name: ShapeName, on: number): boolean => {
      for (let i = 0; i < n; i++) pts[i] = { x: base[i].x, y: base[i].y };
      this.apply(pts, { ...NONE, [name]: on }, 1);
      return check.folds(before, pts, report) > 0;
    };
    for (const name of SHAPE_NAMES) {
      if (!folds(name, 1)) continue;
      let lo = 0,
        hi = 1;
      for (let it = 0; it < 8; it++) {
        const mid = (lo + hi) / 2;
        if (folds(name, mid)) hi = mid;
        else lo = mid;
      }
      this.ceiling[name] = lo;
    }
  }
}

/** The expression rig of the mesh laid now, built on first need (an
 *  expression on) and again when the mesh is laid anew (a viewport, a
 *  texture): an engine that never expresses never builds one. */
export class ExpressionRigs {
  private for: unknown = null;
  private rig: ExpressionRig | null = null;

  constructor(
    private readonly triangles: readonly (readonly [number, number, number])[],
    private readonly gains: ExpressionGains
  ) {}

  /** The rig for `mesh` when an expression is `on`; null when none is. */
  get(mesh: FaceMesh, on: boolean): ExpressionRig | null {
    if (!on) return null;
    if (this.for !== mesh) {
      this.for = mesh;
      this.rig = ExpressionRig.build(mesh.basePoints, this.triangles, this.gains);
    }
    return this.rig;
  }
}

/** No shape on. */
export const NONE: ShapeMix = Object.fromEntries(SHAPE_NAMES.map((s) => [s, 0])) as Record<ShapeName, number>;

/** `p` in the face's frame, IODs. */
function toFace(f: FaceFrame, p: Point): Point {
  const dx = p.x - f.ox,
    dy = p.y - f.oy;
  return { x: (dx * f.ux + dy * f.uy) / f.iod, y: (-dx * f.uy + dy * f.ux) / f.iod };
}

/** Each landmark's distance to the face's outline (FACE_OVAL, closed), IODs. */
function outlineDistance(local: readonly Point[]): Float64Array {
  const d = new Float64Array(local.length);
  for (let i = 0; i < local.length; i++) {
    let best = Infinity;
    for (let k = 0; k < FACE_OVAL.length; k++) {
      const a = local[FACE_OVAL[k]],
        b = local[FACE_OVAL[(k + 1) % FACE_OVAL.length]];
      best = Math.min(best, segmentDistance(local[i], a, b));
    }
    d[i] = best;
  }
  return d;
}

function segmentDistance(p: Point, a: Point, b: Point): number {
  const vx = b.x - a.x,
    vy = b.y - a.y;
  const len = vx * vx + vy * vy;
  const t = len > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / len)) : 0;
  return Math.hypot(p.x - a.x - vx * t, p.y - a.y - vy * t);
}

/** Every movable landmark's weight in `region` on `side` (face frame,
 *  IODs): a smooth bump of its distance to the nearest anchor, (1 - d²)²,
 *  times the region's mask, the outline's fade and the midline's. */
function regionWeights(local: readonly Point[], region: Region, side: 0 | 1, outline: Float64Array): Float64Array {
  const spec = REGION_SPECS[region];
  const anchors = spec.anchors[side].map((i) => local[i]);
  const mask = maskOf(spec.mask, local, side);
  const w = new Float64Array(local.length);
  const sign = side ? 1 : -1;
  const lid = LID_REGIONS.has(region);
  for (let i = 0; i < local.length; i++) {
    if (i >= IRIS_FIRST && (!lid || IRIS_CENTRES.has(i))) continue;
    const p = local[i];
    let best = 0;
    for (const a of anchors) {
      const dx = p.x - a.x,
        dy = p.y - a.y;
      const sy = dy < 0 ? spec.up : spec.down;
      const d2 = (dx * dx + (dy / sy) * (dy / sy)) / (spec.reach * spec.reach);
      if (d2 < 1) best = Math.max(best, (1 - d2) ** 2);
    }
    if (!best) continue;
    const midline = smoothstep((sign * p.x) / MIDLINE_BAND + 0.5);
    w[i] = best * mask(p) * smoothstep(outline[i] / OUTLINE_FADE) * midline;
  }
  return w;
}

/**
 * `w` with each inner-lip column's two landmarks (the upper and the lower
 * inner lip at one place along the mouth) given one weight, their mean: the
 * two move together, so the opening the speech makes there is carried
 * exactly, on a mouth slightly open at rest too.
 */
function pairInnerLips(w: Float64Array): Float64Array {
  for (let k = 0; k < INNER_UPPER.length; k++) {
    const u = INNER_UPPER[k],
      l = INNER_LOWER[k];
    w[u] = w[l] = (w[u] + w[l]) / 2;
  }
  return w;
}

/** The mask `kind` on `side`'s eye, as a function of a point (face frame). */
function maskOf(kind: RegionMask, local: readonly Point[], side: 0 | 1): (p: Point) => number {
  const ys = (ids: readonly number[]) => ids.map((i) => local[i].y);
  const [c0, c1] = EYE_CORNERS[side];
  const cornerY = (local[c0].y + local[c1].y) / 2;
  const lidTop = Math.min(...ys(UPPER_LIDS[side]));
  const lidBottom = Math.max(...ys(LOWER_LIDS[side]));
  const eyeWidth = Math.hypot(local[c1].x - local[c0].x, local[c1].y - local[c0].y);
  const awayFromCorners = (p: Point): number => {
    const d = Math.min(
      Math.hypot(p.x - local[c0].x, p.y - local[c0].y),
      Math.hypot(p.x - local[c1].x, p.y - local[c1].y)
    );
    return smoothstep(d / (LID_CORNER_FADE * eyeWidth));
  };
  switch (kind) {
    case "aboveLids": {
      // Full at and above the brows' own line, thinning to nothing just
      // above the lid (as head-turn.ts browLift thins).
      const browY = REGION_SPECS.browInner.anchors[side].reduce((s, i) => s + local[i].y, 0) / 4;
      const barrier = lidTop - 0.03;
      return (p) => (p.y >= barrier ? 0 : p.y <= browY ? 1 : smoothstep((barrier - p.y) / (barrier - browY)));
    }
    case "aboveCorners":
      return (p) => smoothstep((cornerY - p.y) / MASK_BAND.corners) * awayFromCorners(p);
    case "belowCorners":
      return (p) => smoothstep((p.y - cornerY) / MASK_BAND.corners) * awayFromCorners(p);
    case "belowLids":
      return (p) => smoothstep((p.y - lidBottom) / MASK_BAND.lids);
    case "belowNose": {
      const noseY = local[NOSE_BASE].y;
      return (p) => smoothstep((p.y - noseY) / MASK_BAND.nose);
    }
  }
}
