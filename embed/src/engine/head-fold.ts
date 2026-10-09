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

/** The rig's triangles, checked for folds after a turn, and their crushed
 *  corners eased. */
export class FoldCheck {
  /** The rig's own triangles, three landmark indices each. */
  private readonly tris: Int32Array;
  private readonly restArea: Float64Array;
  /** The triangles (indices into tris) the last check found crushed, and
   *  how many. */
  private readonly crushed: Int32Array;
  private crushedCount = 0;
  /** A pass of easing: per landmark, the sum of its crushed triangles'
   *  mean moves and how many there were; and the landmarks it reached. */
  private readonly sumX: Float64Array;
  private readonly sumY: Float64Array;
  private readonly hits: Float64Array;
  private readonly reached: Int32Array;

  /** `n` landmarks; `minArea`: triangles smaller than this (twice their
   *  area, px²) are slivers with no shape to keep (the Delaunay hull's, the
   *  eye's corners). */
  constructor(
    tris: readonly (readonly [number, number, number])[],
    base: readonly Point[],
    n: number,
    private readonly minArea: number
  ) {
    this.tris = new Int32Array(tris.length * 3);
    this.restArea = new Float64Array(tris.length);
    tris.forEach(([a, b, c], k) => {
      this.tris.set([a, b, c], 3 * k);
      this.restArea[k] = area(base[a], base[b], base[c]);
    });
    this.crushed = new Int32Array(tris.length);
    this.sumX = new Float64Array(n);
    this.sumY = new Float64Array(n);
    this.hits = new Float64Array(n);
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
    for (let k = 0; k < restArea.length; k++) {
      const a = tris[3 * k],
        b = tris[3 * k + 1],
        c = tris[3 * k + 2];
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
    const { tris, crushed, sumX, sumY, hits, reached } = this;
    let r = 0;
    for (let q = 0; q < this.crushedCount; q++) {
      const k = crushed[q];
      let mx = 0,
        my = 0;
      for (let v = 3 * k; v < 3 * k + 3; v++) {
        mx += move[2 * tris[v]] / 3;
        my += move[2 * tris[v] + 1] / 3;
      }
      for (let v = 3 * k; v < 3 * k + 3; v++) {
        const i = tris[v];
        if (!isFree[i]) continue;
        if (!hits[i]) reached[r++] = i;
        sumX[i] += mx;
        sumY[i] += my;
        hits[i]++;
      }
    }
    // Every move above is read before any is written, as a pass must.
    for (let q = 0; q < r; q++) {
      const i = reached[q];
      move[2 * i] = 0.5 * move[2 * i] + (0.5 * sumX[i]) / hits[i];
      move[2 * i + 1] = 0.5 * move[2 * i + 1] + (0.5 * sumY[i]) / hits[i];
      sumX[i] = sumY[i] = hits[i] = 0;
    }
  }
}
