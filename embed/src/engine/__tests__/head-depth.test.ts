import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { Rig } from "../../types";
import { CANONICAL_FACE_CM100 } from "../canonical-face";
import { layOutFace, refineMesh, type Point } from "../geometry";
import { PIVOT_CM, SKULL_CENTRE_CM, fitCanonical, smoothDepth } from "../head-depth";
import { EYE_CORNERS, IRISES, LOWER_LIDS, UPPER_LIDS } from "../landmarks";

/**
 * The depth the turn gives every landmark (head-depth.ts): MediaPipe's
 * canonical face fitted to the photo's landmarks, then smoothed over the
 * mesh. On a face drawn through a known camera the fit gives that camera's
 * depth back; on the human fixture, a nose ahead of the cheeks and a pivot
 * behind the face.
 */
const rig = JSON.parse(
  readFileSync(new URL("../../__tests__/fixtures/human-rig.json", import.meta.url), "utf8")
) as Rig;
const [W, H] = rig.image_size;
const image = { naturalWidth: W, naturalHeight: H, width: W, height: H } as HTMLImageElement;

describe("the canonical face fitted to a face drawn through a known camera", () => {
  // The model turned 0.2 rad about the vertical, scaled, the picture's y
  // down, shifted onto a stage.
  const yaw = 0.2,
    s = 6.5,
    tx = 480,
    ty = 400;
  const c = Math.cos(yaw),
    sn = Math.sin(yaw);
  const model = (i: number) => ({
    X: CANONICAL_FACE_CM100[3 * i] / 100,
    Y: CANONICAL_FACE_CM100[3 * i + 1] / 100,
    Z: CANONICAL_FACE_CM100[3 * i + 2] / 100,
  });
  const base: Point[] = [];
  for (let i = 0; i < 468; i++) {
    const { X, Y, Z } = model(i);
    base.push({ x: s * (c * X + sn * Z) + tx, y: -s * Y + ty });
  }
  // The irises are not in the model: anywhere, they are given their eye's.
  for (let i = 468; i < 478; i++) base.push({ x: tx, y: ty });
  const fit = fitCanonical(base);

  it("gives back the camera's scale as the eye distance", () => {
    const a = model(33),
      b = model(263);
    const canonIod = Math.hypot(a.X - b.X, a.Y - b.Y, a.Z - b.Z);
    expect(fit.iod / s).toBeCloseTo(8.89, 6);
    expect(canonIod).toBeCloseTo(8.89, 1);
  });

  it("gives every landmark the turned model's depth, toward the camera", () => {
    for (let i = 0; i < 468; i++) {
      const { X, Z } = model(i);
      expect(fit.depth[i]).toBeCloseTo(s * (-sn * X + c * Z), 6);
    }
    // The nose tip is ahead of the ears.
    expect(fit.depth[1]).toBeGreaterThan(fit.depth[234]);
  });

  it("puts the irises at their eye's depth, a little proud of the lids", () => {
    for (let e = 0; e < 2; e++) {
      const [c0, c1] = EYE_CORNERS[e];
      const ring = [c0, c1, ...UPPER_LIDS[e], ...LOWER_LIDS[e]];
      const lids = ring.reduce((sum, i) => sum + fit.depth[i], 0) / ring.length;
      const [centre, rim] = IRISES[e];
      for (const i of [centre, ...rim]) expect(fit.depth[i]).toBeCloseTo(lids + 0.25 * s, 6);
    }
  });

  it("places a model point on the canvas with its depth", () => {
    for (const p of [PIVOT_CM, SKULL_CENTRE_CM, { x: 3, y: -2, z: 1 }]) {
      const at = fit.at(p);
      expect(at.x).toBeCloseTo(s * (c * p.x + sn * p.z) + tx, 6);
      expect(at.y).toBeCloseTo(-s * p.y + ty, 6);
      expect(at.z).toBeCloseTo(s * (-sn * p.x + c * p.z), 6);
    }
  });
});

describe("the depth on the human fixture", () => {
  const mesh = layOutFace(rig, image, { width: 960, height: 960 }, 1, undefined);
  refineMesh(mesh, rig, image);
  const base = mesh.basePoints;
  const n = base.length;
  const fit = fitCanonical(base);
  const depth = smoothDepth(
    fit.depth,
    rig.triangles.filter(([a, b, c]) => a < n && b < n && c < n)
  );
  const pivot = fit.at(PIVOT_CM);

  it("has the nose ahead of the cheeks and the pivot behind the face", () => {
    expect(depth[1]).toBeGreaterThan(depth[234] + 0.5 * fit.iod);
    expect(depth[1]).toBeGreaterThan(depth[454] + 0.5 * fit.iod);
    // The pivot: behind the ears (their depth is the canonical -2.4 cm), on
    // the face's middle line.
    expect(pivot.z).toBeLessThan(Math.min(depth[234], depth[454]));
    expect(Math.abs(pivot.x - (base[234].x + base[454].x) / 2)).toBeLessThan(0.1 * fit.iod);
    expect(PIVOT_CM.z).toBeLessThan(-2.4);
  });
});

describe("smoothDepth", () => {
  it("halves each landmark toward its neighbours' mean, a pass at a time", () => {
    const tris: [number, number, number][] = [[0, 1, 2]];
    const one = smoothDepth(Float64Array.from([3, 0, 0, 7]), tris, 1);
    // 0: half of 3 and half of its neighbours' (0, 0) mean; 1: half of 0
    // and half of (3, 0)'s.
    expect([...one]).toEqual([1.5, 0.75, 0.75, 7]);
    const two = smoothDepth(Float64Array.from([3, 0, 0, 7]), tris, 2);
    expect(two[0]).toBeCloseTo(0.5 * 1.5 + 0.5 * 0.75, 12);
  });

  it("leaves a level depth level, and the input as it was", () => {
    const flat = Float64Array.from([2, 2, 2, 2]);
    const out = smoothDepth(
      flat,
      [
        [0, 1, 2],
        [1, 3, 2],
      ],
      6
    );
    expect([...out]).toEqual([2, 2, 2, 2]);
    expect(out).not.toBe(flat);
  });
});
