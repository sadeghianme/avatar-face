import { describe, expect, it } from "vitest";
import { createDentalArch, createTongue, DEFAULT_REFERENCE_PROFILE, enamelExposure, normalizeProfile, PROFILE_LIMITS, projectOralPoint, REFERENCE_POSES, rotateJaw } from "../reference-mouth-model";
import { ReferenceMouth } from "../reference-mouth";
import { ZERO_WEIGHTS, type Rig } from "../../types";
import { centralMouthAnchors } from "../../mouth-extension";

describe("reference mouth geometry", () => {
  it("seats teeth on the central bow, not the higher corner chord", () => {
    const left = { x: 0, y: 0 }, right = { x: 100, y: 0 };
    expect(centralMouthAnchors([left, right, { x: 50, y: 10 }, { x: 50, y: 12 }], left, right))
      .toEqual([{ x: 0, y: 11 }, { x: 100, y: 11 }]);
    expect(left.y).toBe(0);
  });
  it("preserves the seam correction when the portrait is tilted", () => {
    const rotate = (p: { x: number; y: number }) => ({ x: (p.x - p.y) / Math.SQRT2, y: (p.x + p.y) / Math.SQRT2 });
    const left = rotate({ x: 0, y: 0 }), right = rotate({ x: 100, y: 0 });
    const anchors = centralMouthAnchors([left, right, rotate({ x: 50, y: 10 }), rotate({ x: 50, y: 12 })], left, right);
    expect(anchors[0].x).toBeCloseTo(rotate({ x: 0, y: 11 }).x);
    expect(anchors[1].y).toBeCloseTo(rotate({ x: 100, y: 11 }).y);
  });
  it("occludes enamel behind rounded lips without hiding F/V contact", () => {
    expect(enamelExposure(REFERENCE_POSES.oo.weights)).toBe(0);
    expect(enamelExposure(REFERENCE_POSES.fv.weights)).toBeGreaterThan(0.8);
    expect(enamelExposure(REFERENCE_POSES.ee.weights)).toBe(1);
  });
  it("normalizes missing, corrupt and out-of-range local drafts", () => {
    expect(normalizeProfile(null)).toEqual(DEFAULT_REFERENCE_PROFILE);
    expect(normalizeProfile({ warmth: NaN, teethScale: "2", teethY: Infinity })).toEqual(DEFAULT_REFERENCE_PROFILE);
    const result = normalizeProfile({ teethScale: 99, teethY: -99, warmth: -5, lipProjection: 8 });
    expect(result.teethScale).toBe(PROFILE_LIMITS.teethScale[1]);
    expect(result.teethY).toBe(PROFILE_LIMITS.teethY[0]);
    expect(result.warmth).toBe(0);
    expect(result.lipProjection).toBe(1);
  });

  it("keeps lower teeth rigid under jaw rotation", () => {
    for (const tooth of createDentalArch(true, DEFAULT_REFERENCE_PROFILE)) {
      const [a, b] = tooth.vertices;
      const distance = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
      for (const jaw of [0, 0.2, 0.7, 1]) {
        const ar = rotateJaw(a, jaw), br = rotateJaw(b, jaw);
        expect(Math.hypot(ar.x - br.x, ar.y - br.y, ar.z - br.z)).toBeCloseTo(distance, 10);
      }
    }
  });

  it("does not resize the upper arch based on the speech opening", () => {
    const upper = createDentalArch(false, DEFAULT_REFERENCE_PROFILE);
    expect(upper).toHaveLength(8);
    expect(upper).toEqual(createDentalArch(false, DEFAULT_REFERENCE_PROFILE));
    expect(upper.every(s => s.vertices.every(p => Number.isFinite(p.x + p.y + p.z)))).toBe(true);
  });

  it("projects depth, scale and rotation in the neutral mouth coordinate frame", () => {
    expect(projectOralPoint({ x: 0, y: 0, z: 0 }, { x: 10, y: 20 }, { x: 110, y: 20 })).toEqual({ x: 60, y: 20 });
    const flat = projectOralPoint({ x: 0.1, y: 0.2, z: 0 }, { x: 0, y: 0 }, { x: 100, y: 0 });
    expect(flat).toEqual({ x: 60, y: 20 });
    const projected = projectOralPoint({ x: 0.1, y: 0.2, z: 0.2 }, { x: 0, y: 0 }, { x: 100, y: 0 });
    expect(projected.x).toBeGreaterThan(flat.x);
    expect(projected.y).toBeGreaterThan(flat.y);
    expect(projectOralPoint({ x: 0.1, y: 0.2, z: 0 }, { x: 0, y: 0 }, { x: 0, y: 100 })).toEqual({ x: -20, y: 60 });
  });

  it("lifts the tongue for contact instead of simply scaling a painted ellipse", () => {
    const low = createTongue(0, 0.2), raised = createTongue(1, 0.2);
    const centerY = (points: typeof low.vertices) => points.reduce((sum, p) => sum + p.y, 0) / points.length;
    expect(centerY(raised.vertices)).toBeLessThan(centerY(low.vertices));
  });

  it("provides genuinely closed and distinct inspection poses", () => {
    expect(REFERENCE_POSES.closed.weights.jawOpen).toBe(0);
    expect(REFERENCE_POSES.closed.weights.mouthClose).toBe(1);
    expect(REFERENCE_POSES.oo.weights.mouthPucker).toBeGreaterThan(0.8);
    expect(REFERENCE_POSES.ee.weights.mouthStretch).toBeGreaterThan(0.7);
    expect(REFERENCE_POSES.aa.weights.jawOpen).toBeGreaterThan(0.7);
  });

  it("leaves neutral skin untouched and bounds projection to the lip region", () => {
    const neutral = [{ x: -50, y: 0 }, { x: 50, y: 0 }, { x: 0, y: -10 }, { x: 0, y: 10 }, { x: 500, y: 500 }];
    const rig = { outer_lip_ring: [0, 1, 2, 3], inner_lip_ring: [0, 1, 2, 3] } as Rig;
    const mouth = new ReferenceMouth(DEFAULT_REFERENCE_PROFILE);
    const points = neutral.map(p => ({ ...p }));
    mouth.deform(points, neutral, rig, ZERO_WEIGHTS);
    expect(points).toEqual(neutral);
    mouth.deform(points, neutral, rig, REFERENCE_POSES.oo.weights);
    expect(points[2].y).toBeLessThan(neutral[2].y);
    expect(points[4]).toEqual(neutral[4]);
    expect(neutral[2].y).toBe(-10);
  });
});
