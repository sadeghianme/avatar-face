import { describe, expect, it } from "vitest";

import { POSE_SCALE, poseToRotation } from "../photoface-hd";

/**
 * The lab's motion now comes from the tested HeadMotion/BodyMotion drivers;
 * what is the lab's own is only the mapping to radians. Pinned so a tuning
 * pass cannot quietly turn "subtle" into "bobblehead" — the sines this
 * replaced looked fine in any single frame too.
 */
describe("poseToRotation", () => {
  it("stays within the stated peaks at full deflection", () => {
    const out = poseToRotation(
      { yaw: 1, pitch: 1, roll: 1 },
      { sway: 1, breath: 1 },
      0.45
    );
    expect(Math.abs(out.y)).toBeLessThanOrEqual(POSE_SCALE.yawRad + 1e-9);
    expect(Math.abs(out.x)).toBeLessThanOrEqual(POSE_SCALE.pitchRad + 0.018 * 0.45 + 1e-9);
    expect(Math.abs(out.z)).toBeLessThanOrEqual(POSE_SCALE.rollRad + POSE_SCALE.swayRad + 1e-9);
    expect(out.lift).toBeLessThanOrEqual(POSE_SCALE.breathRise + 1e-9);
  });

  it("is zero at rest — no standing offset baked in", () => {
    const out = poseToRotation({ yaw: 0, pitch: 0, roll: 0 }, { sway: 0, breath: 0 }, 0);
    expect(out.x).toBe(0);
    expect(out.y).toBe(0);
    expect(out.z).toBe(0);
    expect(out.lift).toBe(0);
  });

  it("is linear, so the drivers' character passes through untouched", () => {
    // The spring-settled stillness lives in HeadMotion. A nonlinear map here
    // would reshape it — half the pose must give exactly half the rotation.
    const full = poseToRotation({ yaw: 0.8, pitch: 0.6, roll: 0.4 }, { sway: 0.5, breath: 0 }, 0);
    const half = poseToRotation({ yaw: 0.4, pitch: 0.3, roll: 0.2 }, { sway: 0.25, breath: 0 }, 0);
    expect(half.y).toBeCloseTo(full.y / 2, 12);
    expect(half.x).toBeCloseTo(full.x / 2, 12);
    expect(half.z).toBeCloseTo(full.z / 2, 12);
  });
});
