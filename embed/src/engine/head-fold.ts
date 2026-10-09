/**
 * The turn in depth's fold clamp (head-turn.ts). A 2D mesh cannot show one
 * part of the face passing in front of another: a triangle the turn would
 * crush or fold (the nose's side against the cheek it passes, the cheek's
 * side toward the silhouette) has its corners' moves eased toward their
 * neighbours' (a few passes, only there), and a turn that still folds one
 * is scaled back, whole, to the largest share that folds none (bisection,
 * HeadTurn.apply). At the personality's limits the second never has to
 * happen.
 *
 * It runs every frame of a turn, several times when it eases, so it keeps
 * its working arrays from frame to frame and makes nothing new.
 */
import type { Point } from "./geometry";

/** A triangle whose area falls below this share of its rest area (or
 *  flips) is folding: the turn is scaled back until none does. */
const MIN_AREA_RATIO = 0.2;
/** At most this many passes of easing a crushed triangle's corners. */
export const EASE_PASSES = 6;

/** Twice the signed area of a triangle. */
export function area(a: Point, b: Point, c: Point): number {
  return (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y);
}

/**
 * The longest of `count` shifts (x, y pairs in `d`), as Math.hypot measures
 * each: the turn's stats (TurnStats.maxShift, headMaxShift). Math.hypot
 * makes an array for every call in V8, and a frame has hundreds of shifts,
 * so only those that could be the longest are measured: one whose square is
 * within a hair (1e-6) of the longest square so far. Every other is shorter
 * by far more than either measure's rounding, and none is negative, so this
 * is what measuring them all gives, to the bit. The shifts come in an array,
 * one call a frame: a number handed to a call V8 does not inline is boxed.
 */
export function longest(d: Float64Array, count: number): number {
  let max = 0,
    best = 0;
  for (let i = 0; i < count; i++) {
    const dx = d[2 * i],
      dy = d[2 * i + 1];
    const sq = dx * dx + dy * dy;
    // A square too small to be told apart (subnormal), or not a number, is
    // measured as it is; no shift at all changes nothing.
    if (sq === 0 || (best > 1e-200 && sq < best * (1 - 1e-6))) continue;
    max = Math.max(max, Math.hypot(dx, dy));
    if (sq > best) best = sq;
  }
  return max;
}

/** The rig's triangles, checked for folds after a turn, and their crushed
 *  corners eased. */
export class FoldCheck {
  private readonly restArea: Float64Array;
  /** The triangles (indices into tris) the last check found crushed, and
   *  how many. */
  private readonly crushed: Int32Array;
  private crushedCount = 0;
  /** A pass of easing: per landmark, the sum of its crushed triangles'
   *  mean moves (x, y) and how many there were; and the landmarks it
   *  reached. */
  private readonly sums: Float64Array;
  private readonly reached: Int32Array;

  /** The rig's own triangles, over `n` landmarks resting at `base`;
   *  `minArea`: triangles smaller than this (twice their area, px²) are
   *  slivers with no shape to keep (the Delaunay hull's, the eye's
   *  corners). */
  constructor(
    private readonly tris: readonly (readonly [number, number, number])[],
    base: readonly Point[],
    n: number,
    private readonly minArea: number
  ) {
    this.restArea = Float64Array.from(tris, ([a, b, c]) => area(base[a], base[b], base[c]));
    this.crushed = new Int32Array(tris.length);
    this.sums = new Float64Array(3 * n);
    this.reached = new Int32Array(n);
  }

  /** Triangles the turn folded or crushed (below MIN_AREA_RATIO of their
   *  area at `before`, the landmarks' x, y pairs before it), of those with
   *  a shape to keep; records the smallest ratio in `report`, and which
   *  they are. */
  folds(before: Float64Array, pts: readonly Point[], report: { minAreaRatio: number }): number {
    const { tris, restArea, minArea, crushed } = this;
    let count = 0,
      minRatio = Infinity;
    for (let k = 0; k < tris.length; k++) {
      const a = tris[k][0],
        b = tris[k][1],
        c = tris[k][2];
      const was =
        (before[2 * b] - before[2 * a]) * (before[2 * c + 1] - before[2 * a + 1]) -
        (before[2 * c] - before[2 * a]) * (before[2 * b + 1] - before[2 * a + 1]);
      if (Math.abs(was) < minArea || Math.abs(restArea[k]) < minArea) continue;
      const ratio = area(pts[a], pts[b], pts[c]) / was;
      if (ratio < minRatio) minRatio = ratio;
      if (ratio < MIN_AREA_RATIO) crushed[count++] = k;
    }
    this.crushedCount = count;
    report.minAreaRatio = minRatio === Infinity ? 1 : minRatio;
    return count;
  }

  /** Each free corner (`isFree`) of the triangles the last check found
   *  crushed goes halfway to its triangle's mean move: a pass halves the
   *  triangle's own deformation, and what it gives up its neighbours take.
   *  `move`: per landmark, its x, y move. */
  ease(move: Float64Array, isFree: Uint8Array): void {
    const { tris, crushed, sums, reached } = this;
    let r = 0;
    for (let q = 0; q < this.crushedCount; q++) {
      const tri = tris[crushed[q]];
      let mx = 0,
        my = 0;
      for (const i of tri) {
        mx += move[2 * i] / 3;
        my += move[2 * i + 1] / 3;
      }
      for (const i of tri) {
        if (!isFree[i]) continue;
        if (!sums[3 * i + 2]) reached[r++] = i;
        sums[3 * i] += mx;
        sums[3 * i + 1] += my;
        sums[3 * i + 2]++;
      }
    }
    // Every move above is read before any is written, as a pass must.
    for (let q = 0; q < r; q++) {
      const i = reached[q];
      move[2 * i] = 0.5 * move[2 * i] + (0.5 * sums[3 * i]) / sums[3 * i + 2];
      move[2 * i + 1] = 0.5 * move[2 * i + 1] + (0.5 * sums[3 * i + 1]) / sums[3 * i + 2];
      sums[3 * i] = sums[3 * i + 1] = sums[3 * i + 2] = 0;
    }
  }
}
