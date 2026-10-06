import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ZERO_WEIGHTS, type BlendWeights } from "../../types";
import type { Point } from "../geometry";
import {
  evalQuadratic,
  fitQuadratic,
  measureAperture,
  measuredParting,
  mouthAxis,
  openingDrive,
  smoothClosedPath,
} from "../mouth-aperture";

/**
 * An inner-lip ring as the rig orders it: a corner at 0, the lower lip
 * 1..9 left to right, the other corner at 10, the upper lip 11..19 right to
 * left (19 opposite 1). `lower(x)` and `upper(x)` give each lip's y.
 */
function ring(width: number, lower: (u: number) => number, upper: (u: number) => number, x0 = 100, y0 = 200): Point[] {
  const pts: Point[] = [{ x: x0, y: y0 }];
  for (let k = 1; k < 10; k++) pts.push({ x: x0 + (width * k) / 10, y: y0 + lower(k / 10) });
  pts.push({ x: x0 + width, y: y0 });
  for (let k = 9; k >= 1; k--) pts.push({ x: x0 + (width * k) / 10, y: y0 - upper(k / 10) });
  return pts;
}
const weights = (w: Partial<BlendWeights>): BlendWeights => ({ ...ZERO_WEIGHTS, ...w });
const bow = (h: number) => (u: number) => h * Math.sin(Math.PI * u);

class RecordingPath {
  calls: string[] = [];
  moveTo() { this.calls.push("moveTo"); }
  bezierCurveTo() { this.calls.push("bezierCurveTo"); }
  closePath() { this.calls.push("closePath"); }
}

describe("the quadratic fit", () => {
  it("recovers a quadratic exactly and falls back to a constant when the samples cannot fix one", () => {
    const ts = [0, 0.2, 0.5, 0.7, 1];
    const c = fitQuadratic(ts.map((t) => 1 + 2 * t + 3 * t * t), ts);
    expect(c[0]).toBeCloseTo(1, 9);
    expect(c[1]).toBeCloseTo(2, 9);
    expect(c[2]).toBeCloseTo(3, 9);
    expect(evalQuadratic(c, 0.4)).toBeCloseTo(1 + 0.8 + 0.48, 9);
    expect(fitQuadratic([5, 6, 7], [0.5, 0.5, 0.5])).toEqual([5, 0, 0]);
  });
});

describe("the mouth's axis", () => {
  it("runs corner to corner, its normal pointing down the screen", () => {
    const axis = mouthAxis(ring(60, bow(3), bow(3)))!;
    expect([axis.ia, axis.ib]).toEqual([0, 10]);
    expect(axis.len).toBeCloseTo(60, 9);
    expect(axis.len2).toBeCloseTo(3600, 9);
    expect(Math.abs(axis.nx)).toBe(0);
    expect(axis.ny).toBe(1);
  });

  it("keeps the normal pointing down on a tilted mouth, and finds none under 4 px", () => {
    const tilted = ring(60, bow(3), bow(3)).map(({ x, y }) => ({ x: x * 0.96 - y * 0.28, y: x * 0.28 + y * 0.96 }));
    const axis = mouthAxis(tilted)!;
    expect(axis.ny).toBeGreaterThan(0);
    expect(Math.hypot(axis.nx, axis.ny)).toBeCloseTo(1, 12);
    expect(axis.nx * axis.ax + axis.ny * axis.ay).toBeCloseTo(0, 9); // perpendicular
    expect(mouthAxis(ring(3, bow(0.5), bow(0.5)))).toBeNull();
  });
});

describe("what the weights ask of the opening", () => {
  it("opens with the jaw, in proportion to the mouth and the owner's setting", () => {
    expect(openingDrive(ZERO_WEIGHTS, 60, 1)).toEqual({ rounding: 0, teethDrive: 0, synthHeight: 0 });
    expect(openingDrive(weights({ jawOpen: 1 }), 60, 1).synthHeight).toBeCloseTo(0.23 * 60, 9);
    expect(openingDrive(weights({ jawOpen: 1 }), 60, 1.5).synthHeight).toBeCloseTo(0.23 * 60 * 1.5, 9);
    expect(openingDrive(weights({ mouthClose: 1 }), 60, 1).synthHeight).toBe(0); // a closure never goes negative
  });

  it("shows teeth on retraction and the labiodental tuck, never on a pucker or a bilabial", () => {
    expect(openingDrive(weights({ mouthStretch: 0.5 }), 60, 1).teethDrive).toBeGreaterThan(0.5);
    const f = openingDrive(weights({ jawOpen: 0.1, mouthClose: 0.55, mouthStretch: 0.25 }), 60, 1);
    expect(f.teethDrive).toBeGreaterThan(0.5); // /f/: the lower lip against the incisors
    expect(f.synthHeight).toBeGreaterThan(0); // an arch to hang the teeth from
    expect(openingDrive(weights({ mouthStretch: 0.5, mouthPucker: 1 }), 60, 1).teethDrive).toBe(0);
    expect(openingDrive(weights({ mouthClose: 0.9, mouthPucker: 0.25 }), 60, 1).teethDrive).toBe(0); // /p/
    // Silence's residual stretch grows no teeth.
    expect(openingDrive(weights({ mouthStretch: 0.1 }), 60, 1).teethDrive).toBe(0);
  });
});

describe("the measured parting", () => {
  it("is nothing for lips that rest apart, and half the drop where the lower lip has dropped", () => {
    const rest = ring(60, bow(2), bow(2));
    const axis = mouthAxis(rest)!;
    const still = measuredParting(rest, rest, axis);
    for (const t of [0.2, 0.5, 0.8]) expect(still(t)).toBeCloseTo(0, 9);
    const dropped = ring(60, (u) => 2 * Math.sin(Math.PI * u) + 6 * Math.sin(Math.PI * u), bow(2));
    const parting = measuredParting(dropped, rest, mouthAxis(dropped)!);
    expect(parting(0.5)).toBeGreaterThan(2.5);
    expect(parting(0.5)).toBeLessThan(3.5);
    expect(parting(0.5)).toBeGreaterThan(parting(0.15)); // closing toward the corners
  });
});

describe("the aperture", () => {
  beforeEach(() => vi.stubGlobal("Path2D", RecordingPath));
  afterEach(() => vi.unstubAllGlobals());

  const rest = ring(60, bow(1), bow(1));

  it("is none for closed lips", () => {
    expect(measureAperture(rest, rest, ZERO_WEIGHTS, 1)).toEqual({ outline: null, aperture: null });
  });

  it("opens on the jaw: a closed outline between the corners, the lower edge dropping most", () => {
    const { outline, aperture } = measureAperture(rest, rest, weights({ jawOpen: 0.85 }), 1);
    expect(aperture).not.toBeNull();
    const a = aperture!;
    expect(a.gapRatio).toBeCloseTo(0.23 * 0.85, 9);
    expect(a.cavityAlpha).toBe(1);
    expect(a.teethAlpha).toBe(1);
    expect([a.ia, a.ib]).toEqual([0, 10]);
    expect(outline).toHaveLength(a.lower.length + a.upper.length - 2);
    for (const p of outline!) {
      expect(p.x).toBeGreaterThan(100);
      expect(p.x).toBeLessThan(160);
    }
    const middle = Math.floor(a.lower.length / 2);
    const below = a.lower[middle].y - 200;
    const above = 200 - a.upper[middle].y;
    expect(below / (below + above)).toBeCloseTo(0.8, 1); // the jaw drops; the upper lip barely lifts
    // A symmetric mouth opens symmetrically.
    expect(a.cx).toBeCloseTo(130, 6);
    expect(a.lower[0].y).toBeCloseTo(a.lower[a.lower.length - 1].y, 6);
    expect((a.path as unknown as RecordingPath).calls.filter((c) => c === "bezierCurveTo")).toHaveLength(outline!.length);
  });

  it("keeps the outline but shows nothing for a parting too slight for the cavity or the teeth", () => {
    const { outline, aperture } = measureAperture(rest, rest, weights({ jawOpen: 0.1 }), 1);
    expect(outline).not.toBeNull();
    expect(aperture).toBeNull();
  });

  it("covers the parting the mesh really shows, even beyond what the weights ask", () => {
    const dropped = ring(60, (u) => 1 * Math.sin(Math.PI * u) + 12 * Math.sin(Math.PI * u), bow(1));
    const asked = measureAperture(rest, rest, weights({ jawOpen: 0.2 }), 1).aperture!;
    const shown = measureAperture(dropped, rest, weights({ jawOpen: 0.2 }), 1).aperture!;
    expect(shown.gapRatio).toBeGreaterThan(asked.gapRatio);
    expect(shown.bh).toBeGreaterThan(asked.bh);
  });

  it("smooths a closed outline through every point, and none through fewer than three", () => {
    const square = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
    expect((smoothClosedPath(square) as unknown as RecordingPath).calls).toEqual(
      ["moveTo", "bezierCurveTo", "bezierCurveTo", "bezierCurveTo", "bezierCurveTo", "closePath"]);
    expect((smoothClosedPath(square.slice(0, 2)) as unknown as RecordingPath).calls).toEqual([]);
  });
});
