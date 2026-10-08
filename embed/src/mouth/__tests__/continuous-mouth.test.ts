import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { bilabialSeal, continuousMouthMix, dampMouth, MouthMotion } from "../continuous-mouth-model";
import { REFERENCE_POSES } from "../reference-mouth-model";
import { PERFORMANCE_POSES, validatePerformanceManifest } from "../photographic-performance-model";
import { validateOralRig } from "../oral-photo";
import { ContinuousMouth, CORNER_EASE, MOUND_REACH, PROTRUSION } from "../continuous-mouth";
import type { MotionManifest } from "../photographic-performance-model";
import { ZERO_WEIGHTS, type BlendWeights, type Rig } from "../../types";

/**
 * The mouth held on `weights` until its pose spring has settled: 400 frames
 * on a virtual 60 fps clock (6.7 s; the spring settles in about 4/35 s).
 * Never the wall clock: the spring steps by the time between deform() calls,
 * and 400 real calls take about 20 ms on a fast machine and over 100 ms on a
 * CI runner, so the mouth stopped anywhere from a third of the way to the
 * pose to all of it, and what a test measured with it.
 */
function settle(manifest: MotionManifest, neutral: readonly { x: number; y: number }[], weights: BlendWeights) {
  let now = 1_000;
  const clock = vi.spyOn(performance, "now").mockImplementation(() => (now += 1000 / 60));
  try {
    const mouth = new ContinuousMouth(manifest);
    const points = neutral.map((p) => ({ ...p }));
    for (let i = 0; i < 400; i++) mouth.deform(points, neutral, {} as Rig, weights);
    return points;
  } finally {
    clock.mockRestore();
  }
}

const interpolate = (a: BlendWeights, b: BlendWeights, t: number) =>
  Object.fromEntries(
    Object.keys(a).map((key) => [key, a[key as keyof BlendWeights] * (1 - t) + b[key as keyof BlendWeights] * t])
  ) as unknown as BlendWeights;

describe("continuous mouth movement", () => {
  it("reaches every authored geometry anchor", () => {
    for (const [i, pose] of PERFORMANCE_POSES.entries()) {
      expect(continuousMouthMix(REFERENCE_POSES[pose].weights)).toEqual(
        PERFORMANCE_POSES.map((_, j) => (i === j ? 1 : 0))
      );
    }
  });
  it("has no nearest-edge discontinuities across every pose pair", () => {
    for (const a of Object.values(REFERENCE_POSES))
      for (const b of Object.values(REFERENCE_POSES)) {
        let previous = continuousMouthMix(a.weights);
        for (let i = 1; i <= 500; i++) {
          const mix = continuousMouthMix(interpolate(a.weights, b.weights, i / 500));
          expect(mix.every((n) => Number.isFinite(n) && n >= 0)).toBe(true);
          expect(mix.reduce((sum, n) => sum + n, 0)).toBeCloseTo(1, 10);
          expect(Math.max(...mix.map((n, j) => Math.abs(n - previous[j])))).toBeLessThan(0.03);
          previous = mix;
        }
      }
  });
  it("seals bilabials without deleting F/V", () => {
    expect(continuousMouthMix({ ...ZERO_WEIGHTS, jawOpen: 0.05, mouthClose: 0.9, mouthPucker: 0.25 })[0]).toBe(1);
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
  it("stiffens toward a closure smoothly, with no jolt at a threshold", () => {
    // mouthClose rising through the old switch point (0.65) over half a
    // second: the rest pose's share climbs monotonically, in small steps.
    const motion = new MouthMotion();
    for (let i = 0; i < 60; i++) motion.step(REFERENCE_POSES.aa.weights, 1 / 60);
    let previous = motion.values[0];
    let largest = 0;
    for (let i = 1; i <= 30; i++) {
      const close = 0.3 + (0.7 * i) / 30;
      const mix = motion.step({ ...ZERO_WEIGHTS, jawOpen: 0.72 * (1 - close), mouthClose: close }, 1 / 60);
      expect(mix[0]).toBeGreaterThanOrEqual(previous - 1e-9);
      largest = Math.max(largest, mix[0] - previous);
      previous = mix[0];
    }
    expect(previous).toBeGreaterThan(0.95);
    expect(largest).toBeLessThan(0.12);
    expect(bilabialSeal(REFERENCE_POSES.closed.weights)).toBe(1);
    expect(bilabialSeal(REFERENCE_POSES.fv.weights)).toBe(0);
    expect(bilabialSeal({ ...ZERO_WEIGHTS, mouthClose: 0.6 })).toBeCloseTo(0.5, 10);
  });
  it("retains velocity when interrupted instead of snapping to a new pose", () => {
    const [v, speed] = dampMouth(0, 0, 1, 0.02, 65);
    const [next, nextSpeed] = dampMouth(v, speed, 0, 0.000001, 65);
    expect(Math.abs(v - next)).toBeLessThan(0.0001);
    expect(Math.abs(speed - nextSpeed)).toBeLessThan(0.02);
  });
  it("closes quickly and stays finite during repeated interrupted movements", () => {
    const motion = new MouthMotion();
    for (let i = 0; i < 60; i++) motion.step(REFERENCE_POSES.aa.weights, 1 / 60);
    // A /p/ /b/ /m/ is shut within 100 ms of being asked for (CLOSURE_OMEGA
    // 80: 99.7% there in six frames; it was four at 125, and the jolt of
    // switching to it mid-flight was the largest step of a sentence).
    for (let i = 0; i < 6; i++) motion.step(REFERENCE_POSES.closed.weights, 1 / 60);
    expect(motion.values[0]).toBeGreaterThan(0.99);
    for (let i = 0; i < 1000; i++) {
      const mix = motion.step(REFERENCE_POSES[PERFORMANCE_POSES[i % 7]].weights, 1 / 120);
      expect(mix.every((n) => Number.isFinite(n) && n >= 0 && n <= 1)).toBe(true);
    }
  });
  it("retargets only the mouth area and keeps a single skin source", () => {
    const manifest = validatePerformanceManifest(
      JSON.parse(readFileSync(new URL("../../../assets/mouth-motion.json", import.meta.url), "utf8"))
    );
    const mouth = new ContinuousMouth(manifest);
    const neutral = manifest.poses[0].points.map(([x, y]) => ({ x: x * 1000, y: y * 1000 }));
    const points = neutral.map((p) => ({ ...p }));
    mouth.deform(points, neutral, {} as Rig, REFERENCE_POSES.aa.weights);
    expect(points[1]).toEqual(neutral[1]);
    expect(points[33]).toEqual(neutral[33]);
    expect(points[14].y).toBeGreaterThan(neutral[14].y);
    expect(points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
  });
  it("eases the corners' inward pull on rounded vowels, and only there", () => {
    // Found on a real closed-mouth portrait: the full pull stretched the dark
    // crease at each commissure into streaks across the cheek.
    const manifest = validatePerformanceManifest(
      JSON.parse(readFileSync(new URL("../../../assets/mouth-motion.json", import.meta.url), "utf8"))
    );
    const neutral = manifest.poses[0].points.map(([x, y]) => ({ x: x * 1000, y: y * 1000 }));
    const oo = settle(manifest, neutral, REFERENCE_POSES.oo.weights);
    const authoredWidth = (manifest.poses[3].points[291][0] - manifest.poses[3].points[61][0]) * 1000;
    const neutralWidth = neutral[291].x - neutral[61].x;
    const width = oo[291].x - oo[61].x;
    // Still a pucker: clearly narrower than rest...
    expect(width).toBeLessThan(neutralWidth * 0.95);
    // ...but the corners stop short of the authored extreme.
    expect(width).toBeGreaterThan(authoredWidth);
    expect(CORNER_EASE).toBeGreaterThan(0);
    expect(CORNER_EASE).toBeLessThan(0.6);

    // A spread vowel widens the mouth; nothing about it is eased.
    const ee = settle(manifest, neutral, REFERENCE_POSES.ee.weights);
    expect(ee[291].x - ee[61].x).toBeGreaterThan(neutralWidth * 0.98);
    // And the centre of the lips is untouched by a lateral ease.
    expect(Math.abs(oo[13].x - neutral[13].x)).toBeLessThan(neutralWidth * 0.06);
  });
  it("brings the lips forward on rounded vowels: a small mound, centred, gone by the cheeks", () => {
    const manifest = validatePerformanceManifest(
      JSON.parse(readFileSync(new URL("../../../assets/mouth-motion.json", import.meta.url), "utf8"))
    );
    const neutral = manifest.poses[0].points.map(([x, y]) => ({ x: x * 1000, y: y * 1000 }));
    const width = neutral[291].x - neutral[61].x;
    const oo = settle(manifest, neutral, REFERENCE_POSES.oo.weights);
    const ee = settle(manifest, neutral, REFERENCE_POSES.ee.weights);
    const cheek = 123; // well outside the lip region
    // Gone by the cheeks: on the held OO face the cheek is outside the
    // mound's reach, by more than the mound itself could have pushed it
    // there (a point inside ends at most (1 + PROTRUSION)^2 out), so the
    // mound moved it not at all.
    // (Measured as deform() does: about the rest mouth's corners.)
    const reach = (p: { x: number; y: number }) => {
      const [left, right] = [neutral[61], neutral[291]];
      const w = Math.hypot(right.x - left.x, right.y - left.y);
      const [cx, cy] = [(left.x + right.x) / 2, (left.y + right.y) / 2];
      return ((p.x - cx) / (w * MOUND_REACH[0])) ** 2 + ((p.y - cy) / (w * MOUND_REACH[1])) ** 2;
    };
    expect(reach(oo[cheek])).toBeGreaterThan((1 + PROTRUSION) ** 2);
    // What does move it is the pose itself, through the lower-face rig (the
    // cheeks follow the jaw a little), and only a little: held, OO moves it
    // 1.03% of the mouth's width and EE 0.83%. (Under 1% passed only while
    // this test ran on the wall clock and the spring never settled.)
    expect(Math.hypot(oo[cheek].x - neutral[cheek].x, oo[cheek].y - neutral[cheek].y)).toBeLessThan(width * 0.012);
    expect(Math.hypot(ee[cheek].x - neutral[cheek].x, ee[cheek].y - neutral[cheek].y)).toBeLessThan(width * 0.012);
    expect(PROTRUSION).toBeGreaterThan(0);
    expect(PROTRUSION).toBeLessThanOrEqual(0.08); // 0.1 swelled like a sting
  });
  it("rejects malformed mouth-detail rigs", () => {
    for (const value of [null, {}, { points: [] }, { points: Array(478).fill([NaN, 0]) }]) {
      expect(() => validateOralRig(value)).toThrow("Invalid mouth");
    }
  });
});
