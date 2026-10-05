import { afterEach, describe, expect, it, vi } from "vitest";
import { dentalLighting, ENAMEL_EDGE_STOPS, ORAL_CORNER_STOPS } from "../dental-lighting-model";
import { DentalOralSurface } from "../dental-oral-surface";
import { DEFAULT_REFERENCE_PROFILE } from "../reference-mouth-model";
import { ZERO_WEIGHTS } from "../../types";
import type { MouthSurfaceFrame } from "../../mouth-extension";
import { fakeCanvas } from "../../__tests__/browser-fakes";

describe("photographic dental lighting", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("retains warm detail in the recess instead of near-black shadow", () => {
    const p = dentalLighting();
    expect(p.recess).toEqual([36, 16, 19]);
    for (let c = 0; c < 3; c++) {
      expect(p.recess[c]).toBeGreaterThan(12);
      expect(p.cavity[c]).toBeGreaterThan(p.recess[c]);
      expect(p.tissue[c]).toBeGreaterThan(p.cavity[c]);
    }
  });
  it("uses only a restrained enamel correction without overexposing the photo", () => {
    for (const warmth of [0, .25, .5, .75, 1]) {
      const p = dentalLighting(undefined, warmth);
      expect(p.enamelBrightness).toBeGreaterThanOrEqual(.94);
      expect(p.enamelBrightness).toBeLessThanOrEqual(1);
      expect(p.enamelSepia).toBeLessThanOrEqual(.1);
    }
  });
  it("keeps a symmetric, soft cavity falloff and clear center", () => {
    for (const [index, [position, alpha]] of ORAL_CORNER_STOPS.entries()) {
      const mirror = ORAL_CORNER_STOPS[ORAL_CORNER_STOPS.length - index - 1];
      expect(position + mirror[0]).toBeCloseTo(1);
      expect(alpha).toBe(mirror[1]);
      expect(alpha).toBeLessThanOrEqual(.42);
      if (position >= .27 && position <= .73) expect(alpha).toBeLessThanOrEqual(.06);
    }
  });
  it("bounds sampled colours without turning dark complexions into black cavities", () => {
    for (const colour of [[0, 0, 0], [255, 255, 255], [NaN, Infinity, -1], []]) {
      const p = dentalLighting(colour, NaN);
      for (const rgb of [p.recess, p.cavity, p.tissue, p.floor]) for (const channel of rgb) {
        expect(Number.isFinite(channel)).toBe(true);
        expect(channel).toBeGreaterThanOrEqual(10);
        expect(channel).toBeLessThanOrEqual(255);
      }
    }
  });
  it("retains at least 74 percent of source light even at the extreme enamel edge", () => {
    for (const [position, alpha] of ENAMEL_EDGE_STOPS) {
      expect(alpha).toBeLessThanOrEqual(.26);
      if (position >= .24 && position <= .76) expect(alpha).toBeLessThanOrEqual(.06);
      if (position >= .38 && position <= .62) expect(alpha).toBe(0);
    }
  });
  it("composites broad cavity shadows before the enamel, never across the crowns", () => {
    vi.stubGlobal("Path2D", class { moveTo() {} lineTo() {} closePath() {} });
    const operations: string[] = [];
    const gradient = { addColorStop() {} };
    const ctx = {
      globalAlpha: 1, save() {}, restore() {}, translate() {}, rotate() {}, scale() {},
      createRadialGradient: () => gradient,
      createLinearGradient: () => { operations.push("corner shadow"); return gradient; },
      fillRect: () => operations.push("cavity fill"),
      drawImage: () => operations.push("enamel"),
      clip() {}, rect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke: () => operations.push("lip contact"),
    } as unknown as CanvasRenderingContext2D;
    // Draw-only fixture; extraction and source coverage have separate tests.
    // The first frame fits the enamel to the face on a canvas of its own.
    vi.stubGlobal("document", { createElement: () => fakeCanvas() });
    const surface = Object.create(DentalOralSurface.prototype) as DentalOralSurface;
    Object.assign(surface, { lowerIncisal: 0, origin: "own", enamel: { cast: [1, 1, 1], bright: 220, edge: 4 },
      arches: [0, 1].map(() => ({ canvas: {}, layer: { count: 1000, box: { x: 100, y: 120, width: 400, height: 80 } } })) });
    surface.setProfile(DEFAULT_REFERENCE_PROFILE);
    const frame = {
      points: Array.from({ length: 21 }, () => ({ x: .5, y: .25 })),
      rig: { inner_lip_ring: Array.from({ length: 21 }, (_, i) => i) },
      weights: { ...ZERO_WEIGHTS }, lipColour: [150, 90, 84],
    } as unknown as MouthSurfaceFrame;
    surface.draw(ctx, frame, { x: 0, y: 0 }, { x: 1, y: 0 });
    expect(operations.filter(op => op === "enamel")).toHaveLength(2);
    expect(operations.indexOf("corner shadow")).toBeLessThan(operations.indexOf("enamel"));
    expect(operations.slice(operations.indexOf("enamel"))).toEqual(["enamel", "enamel", "lip contact"]);
  });
});
