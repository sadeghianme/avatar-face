import { describe, expect, it } from "vitest";

import { projectTurn, type HeadPose3D } from "../head-camera";

/**
 * The head's turn as the camera sees it (head-camera.ts): back out of the
 * photo's perspective, rotate about the pivot (yaw, then pitch, then roll),
 * project again; written into the point it is given.
 */
const PIVOT = { x: 480, y: 520, z: -310 };
const D = 9 * 160;

/** The same rotation and perspective, written out. */
function by(x: number, y: number, z: number, { yaw, pitch, roll }: HeadPose3D) {
  const P = PIVOT;
  const k0 = (D - (z - P.z)) / D;
  const v = [(x - P.x) * k0, (y - P.y) * k0, z - P.z];
  const [X1, Z1] = [v[0] * Math.cos(yaw) + v[2] * Math.sin(yaw), -v[0] * Math.sin(yaw) + v[2] * Math.cos(yaw)];
  const [Y2, Z2] = [v[1] * Math.cos(pitch) + Z1 * Math.sin(pitch), -v[1] * Math.sin(pitch) + Z1 * Math.cos(pitch)];
  const [X3, Y3] = [X1 * Math.cos(roll) - Y2 * Math.sin(roll), X1 * Math.sin(roll) + Y2 * Math.cos(roll)];
  const k = D / (D - Z2);
  return { x: P.x + X3 * k, y: P.y + Y3 * k };
}

describe("projectTurn", () => {
  it("rotates about the pivot and sees the result through the camera", () => {
    for (const [x, y, z, pose] of [
      [500, 560, -20, { yaw: 0.1, pitch: 0, roll: 0 }],
      [470, 380, -60, { yaw: 0, pitch: -0.08, roll: 0 }],
      [485, 700, -90, { yaw: 0.05, pitch: 0.07, roll: 0.04 }],
      [400, 470, -110, { yaw: -0.12, pitch: 0.03, roll: -0.05 }],
    ] as [number, number, number, HeadPose3D][]) {
      const got = projectTurn({ x: 0, y: 0 }, x, y, z, pose, PIVOT, D);
      const want = by(x, y, z, pose);
      expect(got.x).toBeCloseTo(want.x, 9);
      expect(got.y).toBeCloseTo(want.y, 9);
    }
  });

  it("moves a point ahead of the pivot toward +x by yaw, the further ahead the further; roll alone turns the picture about it", () => {
    const P = PIVOT;
    const at = (x: number, y: number, z: number, pose: HeadPose3D) => projectTurn({ x: 0, y: 0 }, x, y, z, pose, P, D);
    const nose = at(P.x, P.y, P.z + 160, { yaw: 0.1, pitch: 0, roll: 0 });
    const brow = at(P.x, P.y, P.z + 80, { yaw: 0.1, pitch: 0, roll: 0 });
    expect(nose.x - P.x).toBeGreaterThan(brow.x - P.x);
    expect(brow.x - P.x).toBeGreaterThan(0);
    const r = at(P.x + 100, P.y, P.z, { yaw: 0, pitch: 0, roll: 0.1 });
    expect(r.x - P.x).toBeCloseTo(100 * Math.cos(0.1), 9);
    expect(r.y - P.y).toBeCloseTo(100 * Math.sin(0.1), 9);
  });

  it("leaves a point where it is without a turn, and writes into the point it is given", () => {
    const out = { x: -1, y: -1 };
    const got = projectTurn(out, 431.25, 612.5, -42, { yaw: 0, pitch: 0, roll: 0 }, PIVOT, D);
    expect(got).toBe(out);
    expect(out.x).toBeCloseTo(431.25, 9);
    expect(out.y).toBeCloseTo(612.5, 9);
  });
});
