import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { Rig } from "../../types";
import { hairRuns, landmarkBand, measureBrowBands, type LumaAt } from "../expression-brow-band";
import { browCaps, type StripLandmarks } from "../expression-brow-caps";
import { faceFrame, lidLine, toFace } from "../expression-weights";
import type { Point } from "../geometry";
import { BROW_LOWER, BROW_UPPER } from "../landmarks";

/**
 * The brows' two measurements, each alone (expression-brow-band.ts,
 * expression-brow-caps.ts): where a brow's hair is in the picture, read on
 * synthetic profiles and pictures, and how far a brow may move before it
 * presses or stretches the mesh round it.
 */
const STEP = 0.004;
const rig = JSON.parse(
  readFileSync(new URL("../../__tests__/fixtures/human-rig.json", import.meta.url), "utf8")
) as Rig;
const base = rig.points.map(([x, y]) => ({ x, y }));
const frame = faceFrame(base)!;
const local = base.slice(0, 478).map((p) => toFace(frame, p));
const tris = rig.triangles.filter((t) => t.every((i) => i < 478));
const lidTop = (side: 0 | 1, x: number) => lidLine(local, side, true)(x);

/** A column profile: skin at 200, dark (`level`) over the given sample spans. */
const profile = (n: number, spans: readonly (readonly [number, number, number])[]) =>
  Array.from({ length: n }, (_, k) => {
    for (const [a, b, level] of spans) if (k >= a && k <= b) return level;
    return 200;
  });

describe("a brow's dark runs in one column", () => {
  it("finds one run where the hair is, its edges between the samples", () => {
    const runs = hairRuns(profile(60, [[20, 29, 60]]), 1);
    expect(runs).toHaveLength(1);
    expect(runs[0].top).toBeCloseTo(1 + 19.5 * STEP, 6);
    expect(runs[0].bottom).toBeCloseTo(1 + 29.5 * STEP, 6);
    expect(runs[0].depth).toBeCloseTo(140, 6);
  });

  it("splits a brow from a darker crease below it that it touches, the heavier first", () => {
    const runs = hairRuns(
      profile(60, [
        [10, 24, 50],
        [25, 27, 115],
        [28, 31, 70],
      ]),
      0
    );
    expect(runs.length).toBe(2);
    expect(runs[0].bottom).toBeLessThan(runs[1].top + STEP);
    expect(runs[0].mass).toBeGreaterThan(runs[1].mass);
  });

  it("keeps only the hair's core of a dark run over a shaded socket", () => {
    // A painted brow (40) over a socket shaded to just past halfway (115).
    const runs = hairRuns(
      profile(60, [
        [10, 17, 40],
        [18, 30, 115],
      ]),
      0
    );
    expect(runs[0].top).toBeCloseTo(9.5 * STEP, 6);
    expect(runs[0].bottom).toBeCloseTo(17.5 * STEP, 6);
  });

  it("finds nothing in a flat column, a faint one, or one too short to judge", () => {
    expect(hairRuns(profile(60, []), 0)).toEqual([]);
    expect(hairRuns(profile(60, [[20, 29, 194]]), 0)).toEqual([]);
    expect(hairRuns([200, 50, 200], 0)).toEqual([]);
    expect(hairRuns(profile(60, [[20, 29, NaN]]), 0)).toEqual([]);
  });
});

describe("a brow's band, read from the picture", () => {
  /** A picture whose brows are bands of `half` IODs round the landmarks'
   *  brow line moved down by `drop`. */
  const picture =
    (drop: number, half: number): LumaAt =>
    (p) => {
      for (const side of [0, 1] as const) {
        const band = landmarkBand(local, side);
        const xs = band.centre.map((c) => c.x);
        const order = xs.map((_, k) => k).sort((a, b) => xs[a] - xs[b]);
        if (p.x < xs[order[0]] - 0.08 || p.x > xs[order[order.length - 1]] + 0.08) continue;
        const near = order.reduce((m, k) => (Math.abs(xs[k] - p.x) < Math.abs(xs[m] - p.x) ? k : m), order[0]);
        if (Math.abs(p.y - (band.centre[near].y + drop)) <= half) return 50;
      }
      return 200;
    };

  it("follows the hair where it is, not where the landmarks put it", () => {
    const drop = 0.03;
    const [left, right] = measureBrowBands(local, picture(drop, 0.025), lidTop);
    for (const [side, band] of [
      [0, left],
      [1, right],
    ] as const) {
      expect(band).not.toBeNull();
      const marks = landmarkBand(local, side);
      // The middle of the brow: its centre is the hair's, below the landmarks'.
      const mid = band!.centre[Math.floor(band!.centre.length / 2)];
      const markY = marks.centre[2].y;
      expect(mid.y - markY).toBeGreaterThan(drop / 2);
      for (const h of band!.half) expect(h).toBeLessThan(0.05);
    }
  });

  it("gives up on a flat picture, an unreadable one, and one with no contrast", () => {
    expect(measureBrowBands(local, () => 128, lidTop)).toEqual([null, null]);
    expect(measureBrowBands(local, () => NaN, lidTop)).toEqual([null, null]);
  });

  it("lays a landmark band between the brow's upper and lower rows", () => {
    for (const side of [0, 1] as const) {
      const band = landmarkBand(local, side);
      expect(band.centre).toHaveLength(BROW_UPPER[side].length);
      band.centre.forEach((c, k) => {
        const [u, l] = [local[BROW_UPPER[side][k]], local[BROW_LOWER[side][k]]];
        expect(c.y).toBeGreaterThanOrEqual(Math.min(u.y, l.y) - 1e-9);
        expect(c.y).toBeLessThanOrEqual(Math.max(u.y, l.y) + 1e-9);
      });
    }
  });
});

describe("how far a brow may move on a face", () => {
  /** One brow's landmarks as a strip, weight 1, unit 0.2. */
  const stripOf = (side: 0 | 1, weight = 1): StripLandmarks => ({
    index: BROW_UPPER[side],
    share: BROW_UPPER[side].map((_, k) => k / (BROW_UPPER[side].length - 1)),
    weight: BROW_UPPER[side].map(() => weight),
    unit: BROW_UPPER[side].map(() => 0.2),
    side,
  });
  const area = (p: readonly Point[], [a, b, c]: readonly number[]) =>
    (p[b].x - p[a].x) * (p[c].y - p[a].y) - (p[c].x - p[a].x) * (p[b].y - p[a].y);

  it("caps a rise so that no triangle round the brow loses more than its share", () => {
    const strips = [stripOf(0), stripOf(1)];
    const caps = browCaps(local, tris, strips);
    for (const [s, c] of strips.map((s, k) => [s, caps[k]] as const)) {
      for (const v of [...c.up, ...c.down, ...c.inward]) expect(v).toBeGreaterThan(0);
      // Lift every landmark by its cap (IODs): no triangle folds.
      const moved = local.map((p) => ({ ...p }));
      s.index.forEach((i, k) => (moved[i].y -= c.up[k] * s.weight[k]));
      for (const t of tris)
        if (t.some((i) => s.index.includes(i))) expect(area(moved, t) / area(local, t)).toBeGreaterThan(0.25);
    }
  });

  it("changes along a brow no faster than its slope, and allows more with slack", () => {
    const strips = [stripOf(0), stripOf(1)];
    const [one] = browCaps(local, tris, strips);
    const [loose] = browCaps(local, tris, strips, 2);
    for (let k = 1; k < one.up.length; k++) {
      const apart = strips[0].share[k] - strips[0].share[k - 1];
      expect(Math.abs(one.up[k] - one.up[k - 1])).toBeLessThanOrEqual(0.05 * apart + 1e-9);
    }
    one.up.forEach((v, k) => expect(loose.up[k]).toBeGreaterThanOrEqual(v));
    expect(loose.up.some((v, k) => v > one.up[k])).toBe(true);
  });

  it("leaves a brow that does not move uncapped", () => {
    const [still] = browCaps(local, tris, [stripOf(0, 0)]);
    for (const v of still.up) expect(v).toBe(Infinity);
  });
});
