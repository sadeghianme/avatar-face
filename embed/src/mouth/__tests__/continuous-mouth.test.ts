import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { continuousMouthMix, dampMouth, MouthMotion } from "../continuous-mouth-model";
import { REFERENCE_POSES } from "../reference-mouth-model";
import { PERFORMANCE_POSES, validatePerformanceManifest } from "../photographic-performance-model";
import { validateOralRig } from "../photographic-oral-surface";
import { ContinuousMouth } from "../continuous-mouth";
import { ZERO_WEIGHTS, type BlendWeights, type Rig } from "../../types";

const interpolate = (a: BlendWeights, b: BlendWeights, t: number) => Object.fromEntries(
  Object.keys(a).map(key => [key, a[key as keyof BlendWeights] * (1 - t) + b[key as keyof BlendWeights] * t]),
) as unknown as BlendWeights;

describe("continuous mouth movement", () => {
  it("reaches every authored geometry anchor", () => {
    for (const [i, pose] of PERFORMANCE_POSES.entries()) {
      expect(continuousMouthMix(REFERENCE_POSES[pose].weights)).toEqual(PERFORMANCE_POSES.map((_, j) => i === j ? 1 : 0));
    }
  });
  it("has no nearest-edge discontinuities across every pose pair", () => {
    for (const a of Object.values(REFERENCE_POSES)) for (const b of Object.values(REFERENCE_POSES)) {
      let previous = continuousMouthMix(a.weights);
      for (let i = 1; i <= 500; i++) {
        const mix = continuousMouthMix(interpolate(a.weights, b.weights, i / 500));
        expect(mix.every(n => Number.isFinite(n) && n >= 0)).toBe(true);
        expect(mix.reduce((sum, n) => sum + n, 0)).toBeCloseTo(1, 10);
        expect(Math.max(...mix.map((n, j) => Math.abs(n - previous[j])))).toBeLessThan(.03);
        previous = mix;
      }
    }
  });
  it("seals bilabials without deleting F/V", () => {
    expect(continuousMouthMix({ ...ZERO_WEIGHTS, jawOpen: .05, mouthClose: .9, mouthPucker: .25 })[0]).toBe(1);
    expect(continuousMouthMix(REFERENCE_POSES.fv.weights)[5]).toBe(1);
  });
  it("integrates the same motion at 30, 60 and 120 fps", () => {
    const sample = (fps: number) => {
      const motion = new MouthMotion();
      for (let i = 0; i < fps / 10; i++) motion.step(REFERENCE_POSES.aa.weights, 1 / fps);
      return motion.values;
    };
    for (const fps of [30, 60, 120]) sample(fps).forEach((v, i) => expect(v).toBeCloseTo(sample(120)[i], 8));
  });
  it("retains velocity when interrupted instead of snapping to a new pose", () => {
    const [v, speed] = dampMouth(0, 0, 1, .02, 65);
    const [next, nextSpeed] = dampMouth(v, speed, 0, .000001, 65);
    expect(Math.abs(v - next)).toBeLessThan(.0001);
    expect(Math.abs(speed - nextSpeed)).toBeLessThan(.02);
  });
  it("closes quickly and stays finite during repeated interrupted movements", () => {
    const motion = new MouthMotion();
    for (let i = 0; i < 60; i++) motion.step(REFERENCE_POSES.aa.weights, 1 / 60);
    for (let i = 0; i < 4; i++) motion.step(REFERENCE_POSES.closed.weights, 1 / 60);
    expect(motion.values[0]).toBeGreaterThan(.99);
    for (let i = 0; i < 1000; i++) {
      const mix = motion.step(REFERENCE_POSES[PERFORMANCE_POSES[i % 7]].weights, 1 / 120);
      expect(mix.every(n => Number.isFinite(n) && n >= 0 && n <= 1)).toBe(true);
    }
  });
  it("retargets only the mouth area and keeps a single skin source", () => {
    const manifest = validatePerformanceManifest(JSON.parse(readFileSync(new URL("../../../../frontend/public/lab/reference/performance.json", import.meta.url), "utf8")));
    const mouth = new ContinuousMouth(manifest);
    const neutral = manifest.poses[0].points.map(([x, y]) => ({ x: x * 1000, y: y * 1000 }));
    const points = neutral.map(p => ({ ...p }));
    mouth.deform(points, neutral, {} as Rig, REFERENCE_POSES.aa.weights);
    expect(points[1]).toEqual(neutral[1]);
    expect(points[33]).toEqual(neutral[33]);
    expect(points[14].y).toBeGreaterThan(neutral[14].y);
    expect(points.every(p => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
  });
  it("rejects malformed mouth-detail rigs", () => {
    for (const value of [null, {}, { points: [] }, { points: Array(478).fill([NaN, 0]) }]) {
      expect(() => validateOralRig(value)).toThrow("Invalid mouth");
    }
  });
});
