import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  dentalCrownCoverage,
  dentalPlacement,
  enamelMask,
  extractDentalLayers,
  lowerDentalExposure,
  type DentalPixels,
} from "../dental-texture-model";
import { validateOralRig } from "../oral-photo";

function fixture() {
  const pixels: DentalPixels = { width: 100, height: 80, data: new Uint8ClampedArray(100 * 80 * 4) };
  const fill = (x0: number, y0: number, w: number, h: number, colour: number[]) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) pixels.data.set(colour, (y * 100 + x) * 4);
  };
  fill(0, 0, 100, 80, [40, 12, 14, 255]);
  fill(15, 12, 70, 18, [220, 211, 185, 255]);
  fill(20, 50, 60, 15, [198, 188, 168, 255]);
  const upper = [
    { x: 0, y: 10 },
    { x: 99, y: 10 },
  ];
  const lower = [
    { x: 0, y: 70 },
    { x: 99, y: 70 },
  ];
  return { pixels, fill, upper, lower };
}

describe("photo-derived dental arches", () => {
  it("retains warm enamel but excludes lips and dark cavity", () => {
    expect(enamelMask(220, 211, 185)).toBeGreaterThan(0.95);
    expect(enamelMask(144, 137, 123)).toBeGreaterThan(0.9);
    expect(enamelMask(165, 92, 98)).toBe(0);
    expect(enamelMask(45, 15, 17)).toBe(0);
  });
  it("extracts disjoint upper/lower rows without copied background", () => {
    const { pixels, upper, lower } = fixture();
    const [a, b] = extractDentalLayers(pixels, upper, lower);
    expect(a.box).toEqual({ x: 15, y: 12, width: 70, height: 18 });
    expect(b.box).toEqual({ x: 20, y: 50, width: 60, height: 15 });
    expect(a.count).toBe(1260);
    expect(b.count).toBe(900);
    for (let i = 3; i < pixels.data.length; i += 4) expect(a.pixels.data[i] && b.pixels.data[i]).toBe(0);
    expect(Array.from(pixels.data.slice(0, 4))).toEqual([40, 12, 14, 255]);
  });
  it("rejects small floating highlights instead of turning them into tooth slivers", () => {
    const { pixels, fill, upper, lower } = fixture();
    fill(2, 12, 3, 3, [255, 255, 255, 255]);
    const [a] = extractDentalLayers(pixels, upper, lower);
    expect(a.pixels.data[(12 * 100 + 2) * 4 + 3]).toBe(0);
    expect(a.count).toBe(1260);
  });
  it("preserves dark shading inside teeth as opaque source colour, not black holes", () => {
    const { pixels, fill, upper, lower } = fixture();
    fill(15, 19, 70, 4, [86, 78, 67, 255]);
    fill(48, 12, 2, 18, [80, 72, 62, 255]);
    const [a] = extractDentalLayers(pixels, upper, lower);
    for (const [x, y] of [
      [30, 20],
      [48, 15],
      [48, 20],
    ]) {
      const k = (y * 100 + x) * 4;
      expect(Array.from(a.pixels.data.slice(k, k + 4))).toEqual(Array.from(pixels.data.slice(k, k + 4)));
      expect(a.pixels.data[k + 3]).toBe(255);
    }
    expect(a.count).toBe(1260);
  });
  it("never synthesizes root columns above the photographed surface", () => {
    const { pixels, upper, lower } = fixture();
    const [a] = extractDentalLayers(pixels, upper, lower);
    for (let x = 0; x < 100; x++)
      for (let y = 0; y < 12; y++) {
        expect(a.pixels.data[(y * 100 + x) * 4 + 3]).toBe(0);
      }
    expect(a.box.y).toBe(12);
  });
  it("preserves the small gum-contact notch between adjacent crown tops", () => {
    const { pixels, fill, upper, lower } = fixture();
    fill(48, 12, 2, 4, [130, 71, 76, 255]);
    const [a] = extractDentalLayers(pixels, upper, lower);
    expect(Array.from(a.pixels.data.slice((13 * 100 + 48) * 4, (13 * 100 + 48) * 4 + 4))).toEqual([130, 71, 76, 255]);
  });
  it("respects source alpha and handles an empty lower arch", () => {
    const { pixels, fill, upper, lower } = fixture();
    fill(20, 50, 60, 15, [255, 255, 255, 0]);
    const [, b] = extractDentalLayers(pixels, upper, lower);
    expect(b.count).toBe(0);
    expect(b.box.width).toBe(0);
    expect(b.box.height).toBe(0);
  });
  it("clips off-image contours and refuses malformed data", () => {
    const { pixels } = fixture();
    const rows = extractDentalLayers(
      pixels,
      [
        { x: -20, y: -10 },
        { x: 120, y: -10 },
      ],
      [
        { x: -20, y: 90 },
        { x: 120, y: 90 },
      ]
    );
    expect(rows[0].count).toBeGreaterThan(0);
    expect(() => extractDentalLayers(pixels, [], [])).toThrow("Invalid dental");
    expect(() => extractDentalLayers({ ...pixels, width: NaN }, [], [])).toThrow("Invalid dental");
  });
  it("keeps the upper arch stationary and moves the lower row without scaling", () => {
    const upper = dentalPlacement(false, 380, 70, 1, 0.016, 0);
    for (const jaw of [0, 0.1, 0.5, 1]) {
      expect(dentalPlacement(false, 380, 70, 1, 0.016, jaw)).toEqual(upper);
      const lower = dentalPlacement(true, 370, 60, 1, 0.016, jaw, 32);
      expect(lower.width).toBe(370 / 512);
      expect(lower.height).toBe(60 / 512);
      expect(lower.y + 32 / 512).toBeCloseTo(0.32 * jaw - 0.055);
    }
  });
  it("hides a clipped lower-tooth sliver and exposes it smoothly in an open mouth", () => {
    expect(lowerDentalExposure(0.1, 0.071)).toBe(0);
    expect(lowerDentalExposure(0.25, 0.071)).toBe(1);
    let previous = 0;
    for (let descent = 0.1; descent <= 0.25; descent += 0.001) {
      const exposure = lowerDentalExposure(descent, 0.071);
      expect(exposure).toBeGreaterThanOrEqual(previous);
      expect(exposure - previous).toBeLessThan(0.04);
      previous = exposure;
    }
  });
  it("does not enlarge a cropped tooth row and preserves native aspect ratio", () => {
    const a = dentalPlacement(false, 200, 40, 1, 0, 0.5);
    const b = dentalPlacement(false, 400, 40, 1, 0, 0.5);
    expect(a.width).toBe(b.width / 2);
    expect(a.height).toBe(b.height);
    const fitted = dentalPlacement(false, 200, 40, 1.1, 0.02, 0.5);
    expect(fitted.width / fitted.height).toBeCloseTo(5);
    expect(fitted.y + fitted.height).toBeCloseTo(0.075);
  });
  it("ships a detected rig for the dedicated fictional dental source", () => {
    const rig = validateOralRig(
      JSON.parse(
        readFileSync(
          new URL("../../../../frontend/public/lab/reference/oral-detail-v3.rig.json", import.meta.url),
          "utf8"
        )
      )
    );
    expect(rig.points).toHaveLength(478);
    expect(rig.points[14][1] - rig.points[13][1]).toBeGreaterThan(10);
  });
  it("distinguishes full crowns from a source that only exposes tooth tips", () => {
    const { pixels, fill, upper, lower } = fixture();
    expect(dentalCrownCoverage(extractDentalLayers(pixels, upper, lower)[0], 50, 100)).toBe(0.18);
    fill(15, 12, 70, 12, [40, 12, 14, 255]);
    expect(dentalCrownCoverage(extractDentalLayers(pixels, upper, lower)[0], 50, 100)).toBe(0.06);
  });
});
