import { describe, expect, it } from "vitest";
import { REFERENCE_POSES } from "../../mouth/reference-mouth-model";
import { PERFORMANCE_POSES, performanceInfluence, performanceMix, validatePerformanceManifest } from "../../mouth/photographic-performance-model";
import { ZERO_WEIGHTS } from "../../types";

describe("authored photographic performance", () => {
  it("reproduces each authored pose exactly without other mouth textures", () => {
    for (const [index, id] of PERFORMANCE_POSES.entries()) {
      const mix = performanceMix(REFERENCE_POSES[id].weights);
      expect(mix[index]).toBeCloseTo(1, 6);
      expect(mix.filter(n => n > .001)).toHaveLength(1);
    }
  });
  it("seals P/B/M despite residual vowel anticipation", () => {
    expect(performanceMix({ ...ZERO_WEIGHTS, jawOpen: .05, mouthClose: .9, mouthPucker: .25 })).toEqual(PERFORMANCE_POSES.map((_, i) => i === 0 ? 1 : 0));
  });
  it("keeps interpolation nonnegative, normalized and sparse throughout transitions", () => {
    for (const a of PERFORMANCE_POSES) for (const b of PERFORMANCE_POSES) for (let i = 0; i <= 20; i++) {
      const from = REFERENCE_POSES[a].weights, to = REFERENCE_POSES[b].weights;
      const w = Object.fromEntries(Object.keys(from).map(k => [k, from[k as keyof typeof from] * (1 - i / 20) + to[k as keyof typeof to] * i / 20])) as typeof from;
      const mix = performanceMix(w);
      expect(mix.every(n => n >= 0 && Number.isFinite(n))).toBe(true);
      expect(mix.reduce((sum, n) => sum + n, 0)).toBeCloseTo(1, 7);
      expect(mix.filter(n => n > .0001).length).toBeLessThanOrEqual(2);
    }
  });
  it("locks the original face outside the local performance boundary", () => {
    expect(performanceInfluence(.5, .6, [.5, .6], .2)).toBe(1);
    expect(performanceInfluence(.5, .3, [.5, .6], .2)).toBe(0);
    expect(performanceInfluence(.1, .6, [.5, .6], .2)).toBe(0);
  });
  it("rejects incompatible or missing character assets", () => {
    expect(() => validatePerformanceManifest(null)).toThrow();
    expect(() => validatePerformanceManifest({ version: 1, character: "another-person" })).toThrow();
  });
});
