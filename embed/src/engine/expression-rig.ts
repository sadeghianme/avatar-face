/**
 * The expressions laid on one face (docs/emotions.md): the brows as rigid
 * strips (expression-brows.ts), the lids, the cheeks and the mouth's
 * corners as regions (expression-weights.ts), all read once from the rest
 * mesh; and the frame's pass that moves the landmarks by the mix of
 * expressions on (deform.ts).
 *
 * A landmark's displacement is read at its REST position and added to
 * wherever the frame's mouth, lids and jaw put it, and the upper and lower
 * inner lip of each column take one weight, so an opening the speech makes
 * is carried, not changed: speech keeps the lips. The pass runs before the
 * head's turn in depth, which then turns the face it made.
 */
import type { FaceMesh, Point } from "./geometry";
import { FoldCheck } from "./head-fold";
import { INNER_LOWER, INNER_UPPER, LIP_CORNERS, LOWER_ROWS, UPPER_ROWS } from "./jaw-rig";
import { LANDMARK_COUNT } from "./landmarks";
import { BrowRig } from "./expression-brows";
import {
  EXPRESSIONS,
  REGION_CAP,
  REGIONS,
  SHAPE_NAMES,
  browPoseOf,
  regionOf,
  type BrowPose,
  type ExpressionGains,
  type Region,
  type RegionKey,
  type ShapeName,
  type Vec,
} from "./expression-table";
import { measureBrowBands, textureLuma, type BrowBand } from "./expression-brow-band";
import { readLook, type LookReading } from "./expression-look";
import { SkinCuePainter } from "./expression-shading";
import {
  faceFrame,
  fromFace,
  lidLine,
  outlineDistance,
  regionWeights,
  toCanvas,
  smoothstep,
  toFace,
  type FaceFrame,
} from "./expression-weights";

/** The least share of its rest area a region may leave a rig triangle
 *  (relieve): with the head's turn squeezing the far cheek to about half
 *  again, it stays above the fifth the fold check allows. */
const RELIEF = 0.5;
/** The inner lips' pairs read for the mouth's opening, and how far open
 *  (IODs past rest) leaves no room for a lip press. */
const LIP_PAIRS = [
  [13, 14],
  [81, 178],
  [311, 402],
] as const;
const PRESS_OPEN = 0.03;
const RELIEF_STEPS = 24;
/** The lips, never eased: they move as one piece with the speech's
 *  opening (easing a lip landmark beside the corner flipped a triangle
 *  there while talking). */
const LIPS: ReadonlySet<number> = new Set([
  ...INNER_UPPER,
  ...INNER_LOWER,
  ...UPPER_ROWS.flat(),
  ...LOWER_ROWS.flat(),
  ...LIP_CORNERS,
  61,
  291,
]);
const area = (p: readonly Point[], [a, b, c]: readonly number[]) =>
  (p[b].x - p[a].x) * (p[c].y - p[a].y) - (p[c].x - p[a].x) * (p[b].y - p[a].y);

/** How much of each shape is on, 0..1 each (the mixer's weights). */
export type ShapeMix = Readonly<Record<ShapeName, number>>;

/** No shape on. */
export const NONE: ShapeMix = Object.fromEntries(SHAPE_NAMES.map((s) => [s, 0])) as Record<ShapeName, number>;

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

/** A brow pose being summed this frame. */
interface MutablePose {
  inner: [number, number];
  mid: [number, number];
  outer: [number, number];
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

export class ExpressionRig {
  /** Each shape's ceiling on this face: lowered from 1 where the shape at
   *  1 would fold or crush one of the rig's triangles (calibrate). */
  readonly ceiling: Record<ShapeName, number>;
  /** The brows as rigid strips. */
  readonly brows: BrowRig;
  /** Each brow's hair as the picture showed it (null: the landmarks'). */
  readonly bands: readonly [BrowBand | null, BrowBand | null];
  /** The lips' widest parting at rest, IODs (pressRoom). */
  private readonly restGap: number;
  /** How many landmarks' region weights were eased (relieve). */
  eased = 0;
  /** Whether the picture is a photograph's (expression-look.ts). */
  readonly look: LookReading;
  /** How much of the skin cues this face takes: the line's, and none for
   *  a face that is not a photograph. */
  readonly cueGain: number;
  /** The skin cues' sprites for this face (expression-shading.ts), each
   *  laid on the rest face with its shape at full. */
  readonly painter: SkinCuePainter;
  private readonly channels: Channel[];
  private readonly frame: FaceFrame;
  /** This frame's displacement per channel, canvas px (x, y pairs). */
  private readonly shift: Float64Array;
  private readonly moved = { x: 0, y: 0 };
  /** Each side's brow pose from each shape, and this frame's sum. */
  private readonly browTerms: [{ shape: ShapeName; pose: BrowPose }[], { shape: ShapeName; pose: BrowPose }[]];
  private readonly browSum: [MutablePose, MutablePose];

  private constructor(
    base: readonly Point[],
    frame: FaceFrame,
    private readonly gains: ExpressionGains,
    triangles: readonly (readonly [number, number, number])[],
    luma: ((p: Point) => number) | null,
    texel: number
  ) {
    this.frame = frame;
    let rest = 0;
    for (const [u, l] of LIP_PAIRS) rest = Math.max(rest, Math.hypot(base[l].x - base[u].x, base[l].y - base[u].y));
    this.restGap = rest / frame.iod;
    const local = base.slice(0, LANDMARK_COUNT).map((p) => toFace(frame, p));
    const outline = outlineDistance(local);
    this.channels = [];
    for (const region of REGIONS) {
      for (const side of [0, 1] as const) {
        const weights = regionWeights(local, region, side, outline);
        const index: number[] = [];
        const weight: number[] = [];
        weights.forEach((w, i) => {
          if (Math.abs(w) > 1e-4) {
            index.push(i);
            weight.push(w);
          }
        });
        const terms = termsOf(region, side);
        this.channels.push({ region, side, index: Int32Array.from(index), weight: Float64Array.from(weight), terms });
      }
    }
    const tris = triangles.filter((t) => t.every((i) => i < LANDMARK_COUNT));
    const bands = luma
      ? measureBrowBands(
          local,
          (p) => luma(fromFace(frame, p)),
          (side, x) => lidLine(local, side, true)(x)
        )
      : ([null, null] as const);
    this.bands = bands;
    this.look = readLook(local, luma ? (p) => luma(fromFace(frame, p)) : null, texel / frame.iod);
    this.cueGain = this.look.photographic ? gains.cues : 0;
    this.painter = new SkinCuePainter((shape) => {
      const pts = base.slice(0, LANDMARK_COUNT).map((p) => ({ x: p.x, y: p.y }));
      this.apply(pts, { ...NONE, [shape]: Math.min(1, this.ceiling[shape]) }, 1);
      return pts;
    });
    this.brows = new BrowRig(local, outline, frame, tris, bands, gains.slack);
    const browsOf = (side: "left" | "right") =>
      SHAPE_NAMES.flatMap((shape) => {
        const pose = browPoseOf(EXPRESSIONS[shape].brows, side);
        return pose ? [{ shape, pose }] : [];
      });
    this.browTerms = [browsOf("left"), browsOf("right")];
    const zero = (): MutablePose => ({ inner: [0, 0], mid: [0, 0], outer: [0, 0] });
    this.browSum = [zero(), zero()];
    this.shift = new Float64Array(this.channels.length * 2);
    this.ceiling = Object.fromEntries(SHAPE_NAMES.map((s) => [s, 1])) as Record<ShapeName, number>;
  }

  /**
   * The rig for the face resting at `base` (canvas px), its rig triangles
   * `triangles` checked for folds, its line's `gains`, the picture's
   * luminance at a canvas point `luma` (for the brows' hair; null: the
   * landmarks stand for it; with a `texel`, one texel's size in canvas px,
   * the skin's grain is read too); null for a face too small or with too
   * few landmarks.
   */
  static build(
    base: readonly Point[],
    triangles: readonly (readonly [number, number, number])[],
    gains: ExpressionGains,
    luma: (((p: Point) => number) & { readonly texel?: number }) | null = null
  ): ExpressionRig | null {
    if (base.length < LANDMARK_COUNT) return null;
    const frame = faceFrame(base);
    if (!frame) return null;
    const rig = new ExpressionRig(base, frame, gains, triangles, luma, luma?.texel ?? 0);
    rig.relieve(base, triangles);
    rig.calibrate(base, triangles);
    return rig;
  }

  /** Shade the skin cues of `mix` over the frame's landmarks `pts` at
   *  `scale` (the tuning's expression), if this face takes them. */
  paintCues(ctx: CanvasRenderingContext2D, pts: readonly Point[], mix: ShapeMix, scale: number): void {
    const gain = this.cueGain * scale;
    if (gain > 0) this.painter.paint(ctx, pts, mix, gain);
  }

  /** How far landmark `i` is moved by `region` on `side` at 1, 0..1. */
  weightOf(region: Region, side: 0 | 1, i: number): number {
    const ch = this.channels.find((c) => c.region === region && c.side === side)!;
    const k = ch.index.indexOf(i);
    return k < 0 ? 0 : ch.weight[k];
  }

  /**
   * Move the landmarks in `pts` by the expressions in `mix` at `scale` (the
   * tuning's expression): the brows' strips, then each region's
   * displacement read off the table, capped, scaled by the line's gain, at
   * each landmark's rest weight. Returns false, having moved nothing, when
   * nothing is on.
   */
  apply(pts: Point[], mix: ShapeMix, scale: number): boolean {
    if (!(scale > 0)) return false;
    const browsOn = this.sumBrows(mix);
    const regionsOn = this.displace(mix, scale, this.pressRoom(pts));
    if (!browsOn && !regionsOn) return false;
    if (browsOn) this.brows.apply(pts, this.browSum, this.gains.brows * scale);
    if (regionsOn) this.moveRegions(pts);
    return true;
  }

  /** How much of a lip press the mouth has room for this frame: all of it
   *  while the lips meet as at rest, none once they are parted by
   *  PRESS_OPEN (IODs) more than at rest. Pressed lips are a closed
   *  mouth's: a lower lip's red drawn up into a mouth the speech opened
   *  crossed its inner lip and folded the triangles between. */
  private pressRoom(pts: readonly Point[]): number {
    let gap = 0;
    for (const [u, l] of LIP_PAIRS) gap = Math.max(gap, Math.hypot(pts[l].x - pts[u].x, pts[l].y - pts[u].y));
    return 1 - smoothstep((gap / this.frame.iod - this.restGap) / PRESS_OPEN);
  }

  /** Each region channel's displacement this frame (`shift`) laid on its
   *  landmarks. */
  private moveRegions(pts: Point[]): void {
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
  }

  /**
   * Ease the regions where they would crush the skin: for each shape at
   * 1, every rig triangle the regions alone press below RELIEF of its rest
   * area has its most moved landmark's weights eased (in every channel, a
   * tenth at a time), until none is. A smile's cheek rising into the skin
   * held under the lower lid pressed a thin triangle there to 0.4 of its
   * area at rest, and the head's turn, which squeezes the far cheek again,
   * took it below a fifth (mehdi_avatar, 5 frames). The inner lips are
   * left alone (they carry the speech's opening).
   */
  private relieve(base: readonly Point[], triangles: readonly (readonly [number, number, number])[]): void {
    const n = LANDMARK_COUNT;
    const tris = triangles.filter(([a, b, c]) => a < n && b < n && c < n);
    const iod2 = this.frame.iod * this.frame.iod;
    const rest = tris.map((t) => area(base, t));
    const pts = base.slice(0, n).map((p) => ({ x: p.x, y: p.y }));
    const scale = new Float64Array(n).fill(1);
    for (const shape of SHAPE_NAMES) {
      if (!Object.keys(EXPRESSIONS[shape].regions).length) continue;
      for (let it = 0; it < RELIEF_STEPS; it++) {
        for (let i = 0; i < n; i++) pts[i] = { x: base[i].x, y: base[i].y };
        if (!this.displace({ ...NONE, [shape]: 1 }, 1)) break;
        this.moveRegions(pts);
        const eased = new Set<number>();
        tris.forEach((t, k) => {
          if (Math.abs(rest[k]) < 0.0005 * iod2 || area(pts, t) / rest[k] >= RELIEF) return;
          let most = -1,
            far = 0;
          for (const i of t) {
            if (LIPS.has(i)) continue;
            const d = Math.hypot(pts[i].x - base[i].x, pts[i].y - base[i].y);
            if (d > far) [most, far] = [i, d];
          }
          if (most >= 0) eased.add(most);
        });
        if (!eased.size) break;
        for (const i of eased) {
          scale[i] *= 0.9;
          for (const ch of this.channels) {
            const k = ch.index.indexOf(i);
            if (k >= 0) ch.weight[k] *= 0.9;
          }
        }
      }
    }
    this.eased = Array.from(scale).filter((v) => v < 1).length;
  }

  /** Each side's brow pose this frame into `browSum`; false for none. */
  private sumBrows(mix: ShapeMix): boolean {
    let any = false;
    for (const side of [0, 1] as const) {
      const sum = this.browSum[side];
      sum.inner[0] = sum.inner[1] = sum.mid[0] = sum.mid[1] = sum.outer[0] = sum.outer[1] = 0;
      for (const { shape, pose } of this.browTerms[side]) {
        const on = Math.min(mix[shape], this.ceiling[shape]);
        if (!(on > 0)) continue;
        any = true;
        for (const part of ["inner", "mid", "outer"] as const) {
          sum[part][0] += pose[part][0] * on;
          sum[part][1] += pose[part][1] * on;
        }
      }
    }
    return any;
  }

  /** This frame's displacement per channel into `shift`; false for none. */
  private displace(mix: ShapeMix, scale: number, press = 1): boolean {
    const { channels, shift, frame, ceiling, moved } = this;
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
      const k = (length > cap ? cap / length : 1) * this.gains[region] * scale * (region === "lipPress" ? press : 1);
      // Outward is toward the picture's left on its left side.
      toCanvas(frame, (side ? out : -out) * k, down * k, moved);
      shift[2 * c] = moved.x;
      shift[2 * c + 1] = moved.y;
      if (moved.x || moved.y) any = true;
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

  /** The rig built for the mesh laid last (null before one was needed). */
  get built(): ExpressionRig | null {
    return this.rig;
  }

  /** The rig for `mesh` laid over `texture` when an expression is `on`;
   *  null when none is. */
  get(mesh: FaceMesh, texture: HTMLImageElement | null, on: boolean): ExpressionRig | null {
    if (!on) return null;
    if (this.for !== mesh) {
      this.for = mesh;
      const luma = texture ? textureLuma(texture, mesh) : null;
      this.rig = ExpressionRig.build(mesh.basePoints, this.triangles, this.gains, luma);
    }
    return this.rig;
  }
}
