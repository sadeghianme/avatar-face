import { describe, expect, it } from "vitest";

import type { Point } from "../geometry";
import { FoldCheck, area, longest } from "../head-fold";

/**
 * The turn's fold clamp (head-fold.ts) on a square fanned about its centre:
 * a corner pushed through an edge is a fold, a sliver has no shape to keep,
 * and easing moves a crushed triangle's free corners halfway to its mean
 * move, those of several crushed triangles to the mean of their means.
 * And the turn's longest shift, measured as Math.hypot measures each.
 */
const base: Point[] = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 10 },
  { x: 0, y: 10 },
  { x: 5, y: 5 },
  // A sliver: no shape to keep.
  { x: 20, y: 0 },
  { x: 21, y: 0 },
  { x: 20.5, y: 0.01 },
];
const tris: [number, number, number][] = [
  [0, 1, 4],
  [1, 2, 4],
  [2, 3, 4],
  [3, 0, 4],
  [5, 6, 7],
];
const flat = (pts: readonly Point[]) => Float64Array.from(pts.flatMap((p) => [p.x, p.y]));
const at = (moves: Record<number, Point>) =>
  base.map((p, i) => ({ x: p.x + (moves[i]?.x ?? 0), y: p.y + (moves[i]?.y ?? 0) }));

describe("FoldCheck.folds", () => {
  it("finds nothing at rest, and reports every ratio whole", () => {
    const check = new FoldCheck(tris, base, base.length, 1);
    const report = { minAreaRatio: 0 };
    expect(check.folds(flat(base), base, report)).toBe(0);
    expect(report.minAreaRatio).toBe(1);
  });

  it("counts a triangle pushed through its edge, and the smallest ratio", () => {
    const check = new FoldCheck(tris, base, base.length, 1);
    const report = { minAreaRatio: 0 };
    // The centre pushed below the bottom edge: the bottom triangle flips.
    const pts = at({ 4: { x: 0, y: -6 } });
    expect(check.folds(flat(base), pts, report)).toBe(1);
    expect(report.minAreaRatio).toBeCloseTo(area(pts[0], pts[1], pts[4]) / area(base[0], base[1], base[4]), 12);
    expect(report.minAreaRatio).toBeLessThan(0);
  });

  it("counts a triangle crushed below a fifth of its area, not one just above", () => {
    const check = new FoldCheck(tris, base, base.length, 1);
    const report = { minAreaRatio: 0 };
    // Twice the bottom triangle's area is 10 * the centre's height.
    expect(check.folds(flat(base), at({ 4: { x: 0, y: -4.05 } }), report)).toBe(1);
    expect(check.folds(flat(base), at({ 4: { x: 0, y: -3.95 } }), report)).toBe(0);
  });

  it("leaves a sliver alone, flipped or not", () => {
    const check = new FoldCheck(tris, base, base.length, 1);
    const report = { minAreaRatio: 0 };
    expect(check.folds(flat(base), at({ 7: { x: 0, y: -0.02 } }), report)).toBe(0);
    expect(report.minAreaRatio).toBe(1);
  });

  it("measures each triangle against where it was before the turn, not at rest", () => {
    const check = new FoldCheck(tris, base, base.length, 1);
    const report = { minAreaRatio: 0 };
    const before = at({ 4: { x: 0, y: -2 } });
    // Half the bottom triangle's area before, the same after: no fold.
    expect(check.folds(flat(before), before, report)).toBe(0);
    expect(report.minAreaRatio).toBe(1);
  });
});

describe("FoldCheck.ease", () => {
  const isFree = Uint8Array.from([0, 0, 0, 0, 1, 0, 0, 0]);

  it("moves a crushed triangle's free corner halfway to the triangle's mean move, and nothing else", () => {
    const check = new FoldCheck(tris, base, base.length, 1);
    const pts = at({ 4: { x: 0, y: -6 } });
    expect(check.folds(flat(base), pts, { minAreaRatio: 0 })).toBe(1);
    const move = new Float64Array(base.length * 2);
    move[9] = -6;
    move[0] = 1; // a held corner's move stays its own
    check.ease(move, isFree);
    // Mean of (1, 0), (0, 0), (0, -6): (1/3, -2); half of each.
    expect(move[8]).toBeCloseTo(0.5 * 0 + 0.5 * (1 / 3), 12);
    expect(move[9]).toBeCloseTo(0.5 * -6 + 0.5 * -2, 12);
    expect(move[0]).toBe(1);
    expect(move[1]).toBe(0);
  });

  it("averages the means of every crushed triangle a corner is in, and starts afresh each pass", () => {
    const check = new FoldCheck(tris, base, base.length, 1);
    // The centre pushed far through the bottom-left corner: the bottom and
    // the left triangles fold.
    const pts = at({ 4: { x: -8, y: -8 } });
    expect(check.folds(flat(base), pts, { minAreaRatio: 0 })).toBe(2);
    const once = () => {
      const move = new Float64Array(base.length * 2);
      move[8] = -8;
      move[9] = -8;
      check.ease(move, isFree);
      return [move[8], move[9]];
    };
    // Both triangles' mean: (-8/3, -8/3); the centre goes halfway to it.
    const [x, y] = once();
    expect(x).toBeCloseTo(0.5 * -8 + 0.5 * (-8 / 3), 12);
    expect(y).toBeCloseTo(0.5 * -8 + 0.5 * (-8 / 3), 12);
    // The same check eased again: the same, nothing carried over.
    expect(once()).toEqual([x, y]);
  });
});

describe("longest", () => {
  /** Math.hypot over every shift, the way the stats were measured. */
  const everyOne = (d: Float64Array, n: number) => {
    let max = 0;
    for (let i = 0; i < n; i++) max = Math.max(max, Math.hypot(d[2 * i], d[2 * i + 1]));
    return max;
  };

  it("is what measuring every shift gives, to the bit, near-ties and nothing at all included", () => {
    let seed = 3;
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let run = 0; run < 200; run++) {
      const n = 1 + Math.floor(random() * 500);
      const d = new Float64Array(2 * n);
      const scale = 10 ** (random() * 8 - 4);
      for (let i = 0; i < 2 * n; i++) d[i] = (random() - 0.5) * scale;
      // Shifts a rounding apart from one another, and shifts of nothing.
      const k = Math.floor(random() * n);
      d[2 * k] = d[0] * (1 + 1e-15);
      d[2 * k + 1] = d[1];
      d[2 * Math.floor(random() * n)] = 0;
      expect(longest(d, n)).toBe(everyOne(d, n));
    }
  });

  it("is 0 for no shift, and not a number for a shift that is not one", () => {
    expect(longest(new Float64Array(6), 3)).toBe(0);
    expect(longest(Float64Array.from([1, 2, NaN, 0, 3, 4]), 3)).toBeNaN();
  });
});
