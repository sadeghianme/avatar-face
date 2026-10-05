import { describe, expect, it } from "vitest";

import {
  boxSharpness, EDGE_CONTRAST, edgeWidths, faceSharpness, lumaField, MIN_EDGES, profileReach, riseWidth, SHARPNESS_SHARE,
  sharpnessBoxes, type LumaField,
} from "../face-sharpness";
import { decodePng, rgbaOf } from "./png-fixture";

/**
 * The picture's sharpness: the width of its crispest strong edges. Checked
 * on synthetic edges of known width, with and without grain, and on the
 * five real character crops for order.
 */

/** The normal CDF: a step blurred by a Gaussian of `sigma` is this ramp. */
function cdf(z: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-(z * z) / 2);
  return 0.5 * (1 + (z < 0 ? -erf : erf));
}

/** Deterministic grain. */
function noise(seed: number): () => number {
  let s = seed;
  return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646 - 0.5; };
}

/**
 * A 160 x 120 field with one straight edge, 60 to 200 luma, at `angle`
 * radians from vertical through the middle: a hard step (sigma 0) or a
 * Gaussian-blurred one; optionally with `grain` levels of uniform noise.
 */
function edgeField(sigma: number, angle = 0, grain = 0, seed = 3): LumaField {
  const width = 160, height = 120, luma = new Float32Array(width * height);
  const nx = Math.cos(angle), ny = Math.sin(angle);
  const rnd = noise(seed);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Distance of the pixel's centre from the edge, along its normal.
      const d = (x + 0.5 - 80.3) * nx + (y + 0.5 - 60.2) * ny;
      const ramp = sigma > 0 ? cdf(d / sigma) : d >= 0 ? 1 : 0;
      luma[y * width + x] = 60 + 140 * ramp + grain * 2 * rnd();
    }
  }
  return { width, height, luma };
}

function flatField(level: number, grain = 0): LumaField {
  const width = 120, height = 100, luma = new Float32Array(width * height);
  const rnd = noise(11);
  for (let i = 0; i < luma.length; i++) luma[i] = level + grain * 2 * rnd();
  return { width, height, luma };
}

describe("the width of a synthetic edge", () => {
  it("reads a hard step as about a pixel, and a blurred one as about 2.5 sigma, in order, with and without grain", () => {
    for (const angle of [0, 0.5, Math.PI / 2 + 0.2]) {
      for (const grain of [0, 6]) {
        const widths = [0, 1, 2, 3].map((sigma) => boxSharpness(edgeWidths(edgeField(sigma, angle, grain))));
        for (const w of widths) expect(w).not.toBeNull();
        const [hard, s1, s2, s3] = widths as number[];
        expect(hard).toBeLessThan(1.3);
        expect(hard).toBeGreaterThan(0.5);
        // The 10-90% rise of a Gaussian edge is 2.56 sigma.
        for (const [sigma, w] of [[1, s1], [2, s2], [3, s3]] as const) {
          expect(w).toBeGreaterThan(2.5 * sigma * 0.75);
          expect(w).toBeLessThan(2.5 * sigma * 1.25);
        }
        expect(hard).toBeLessThan(s1);
        expect(s1).toBeLessThan(s2);
        expect(s2).toBeLessThan(s3);
      }
    }
  });

  it("is not fooled by grain: a flat box, grainy or not, has no edge", () => {
    expect(edgeWidths(flatField(120))).toEqual([]);
    expect(boxSharpness(edgeWidths(flatField(120)))).toBeNull();
    // Grain of 20 levels peak to peak: steps, but none with the contrast of an edge.
    expect(boxSharpness(edgeWidths(flatField(120, 10)))).toBeNull();
    expect(faceSharpness([flatField(100), flatField(100, 10)])).toBeNull();
    expect(EDGE_CONTRAST).toBeGreaterThan(40);
  });

  it("takes the sharpest box, and only a box with enough edges", () => {
    const sharp = edgeField(0.6), soft = edgeField(2.5);
    const s = faceSharpness([soft, sharp]);
    expect(s).toBe(boxSharpness(edgeWidths(sharp)));
    expect(s).toBeLessThan(boxSharpness(edgeWidths(soft))!);
    expect(boxSharpness(Array(MIN_EDGES - 1).fill(1))).toBeNull();
    expect(boxSharpness(Array(MIN_EDGES).fill(1.5))).toBe(1.5);
    // The percentile is low but not the minimum.
    const widths = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(boxSharpness(widths)).toBe(Math.floor(100 * SHARPNESS_SHARE) + 1);
    expect(SHARPNESS_SHARE).toBeGreaterThanOrEqual(0.1);
    expect(SHARPNESS_SHARE).toBeLessThanOrEqual(0.25);
  });

  it("measures the rise of a profile through its middle, over its monotone run", () => {
    // A linear ramp of 100 levels over 4 px: 10-90 is 3.2 px.
    expect(riseWidth([50, 50, 50, 75, 100, 125, 150, 150, 150], 4)).toBeCloseTo(3.2, 6);
    // A step: 0.8 px, between the two samples.
    expect(riseWidth([50, 50, 50, 50, 150, 150, 150], 3)).toBeCloseTo(0.8, 6);
    // Under the contrast floor: nothing.
    expect(riseWidth([50, 60, 70, 80, 90], 2)).toBeNull();
    // The run stops where the profile turns back: a ridge counts its near side.
    expect(riseWidth([50, 50, 100, 150, 100, 50, 50], 2)).toBeCloseTo(1.6, 6);
  });

  it("reads further across a bigger picture's edges", () => {
    expect(profileReach(300)).toBe(8);
    expect(profileReach(800)).toBe(20);
    expect(profileReach(4000)).toBe(24);
  });

  it("boxes the mouth and the eyes from the landmarks, clamped to the texture", () => {
    const points: { x: number; y: number }[] = Array.from({ length: 478 }, () => ({ x: 500, y: 500 }));
    points[61] = { x: 400, y: 600 }; points[291] = { x: 600, y: 600 };
    points[33] = { x: 380, y: 400 }; points[133] = { x: 460, y: 400 };
    points[362] = { x: 540, y: 400 }; points[263] = { x: 620, y: 400 };
    const boxes = sharpnessBoxes(points, 1000, 1000);
    expect(boxes).toHaveLength(3);
    expect(boxes[0]).toEqual({ x: 280, y: 440, w: 440, h: 320 });
    expect(boxes[1].w).toBe(144); expect(boxes[1].h).toBe(96);
    // Clamped at the picture's edge; an eye off the picture is dropped.
    const clamped = sharpnessBoxes(points, 500, 1000);
    expect(clamped[0]).toEqual({ x: 280, y: 440, w: 220, h: 320 });
    expect(sharpnessBoxes(points, 1000, 450)).toHaveLength(2);
    // A degenerate mouth: nothing.
    points[291] = { x: 401, y: 600 };
    expect(sharpnessBoxes(points, 1000, 1000)).toHaveLength(2);
    expect(sharpnessBoxes([], 1000, 1000)).toEqual([]);
  });

  it("makes a luma field from RGBA, holes where the texture is transparent", () => {
    const data = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255, 100, 100, 100, 0]);
    const f = lumaField(data, 3, 1);
    expect(f.luma[0]).toBeCloseTo(255, 3);
    expect(f.luma[1]).toBe(0);
    expect(Number.isNaN(f.luma[2])).toBe(true);
    // A hole in a field makes no edge where it is, and no crash.
    const field = edgeField(1);
    for (let y = 40; y < 80; y++) for (let x = 70; x < 90; x++) field.luma[y * field.width + x] = NaN;
    expect(boxSharpness(edgeWidths(field))).not.toBeNull();
  });
});

describe("the sharpness of the real character crops", () => {
  const sharpnessOf = (file: string) => {
    const png = decodePng(file);
    return boxSharpness(edgeWidths(lumaField(rgbaOf(png), png.w, png.h)));
  };
  it("finds edges in every crop, the drawn cartoons at least as crisp as the soft animation", () => {
    const s = Object.fromEntries(["human-cartoon", "animal-cartoon", "human-animation", "animal-animation", "animal-realistic"].map((n) => [n, sharpnessOf(`${n}-mouth.png`)]));
    for (const v of Object.values(s)) { expect(v).not.toBeNull(); expect(v).toBeGreaterThan(0.5); expect(v).toBeLessThan(6); }
    // Cel art has a drawn line, which is as crisp as the picture gets.
    expect(s["human-cartoon"]).toBeLessThanOrEqual(s["human-animation"]! + 0.3);
    expect(s["animal-cartoon"]).toBeLessThanOrEqual(s["animal-animation"]! + 0.3);
  });
});
