import { describe, expect, it } from "vitest";

import { HeadMotion } from "../headmotion";

/**
 * The behaviour these pin was rebuilt three times before it looked right,
 * and every regression was invisible in a screenshot: a still frame cannot
 * show that a head never stops moving, or that it lurches.
 */

/** Deterministic pseudo-random, so a failure is reproducible. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** Run the driver at a fixed frame rate and record the pose each frame. */
function simulate(seconds: number, speaking: boolean, fps = 60) {
  const motion = new HeadMotion(seeded(42));
  const dt = 1000 / fps;
  const frames: { yaw: number; pitch: number; roll: number }[] = [];
  let now = 0;
  for (let i = 0; i < seconds * fps; i++) {
    now += dt;
    motion.update(dt, now, speaking);
    frames.push({ yaw: motion.yaw, pitch: motion.pitch, roll: motion.roll });
  }
  return frames;
}

describe("HeadMotion", () => {
  it("stays within the pose range it promises", () => {
    // The engine multiplies these by pixel maxima. A value outside -1..1
    // would move the head further than the layer was cut for, exposing the
    // seam the feathering exists to hide.
    for (const speaking of [false, true]) {
      for (const frame of simulate(120, speaking)) {
        expect(Math.abs(frame.yaw)).toBeLessThanOrEqual(1.2);
        expect(Math.abs(frame.pitch)).toBeLessThanOrEqual(1.2);
        expect(Math.abs(frame.roll)).toBeLessThanOrEqual(1.2);
      }
    }
  });

  it("holds still most of the time", () => {
    // Stillness IS the effect. A head that drifts continuously reads as a
    // floating cutout, which is what the first two attempts looked like.
    const frames = simulate(120, false);
    let still = 0;
    for (let i = 1; i < frames.length; i++) {
      const step = Math.abs(frames[i].yaw - frames[i - 1].yaw)
        + Math.abs(frames[i].pitch - frames[i - 1].pitch);
      if (step < 0.001) still++;
    }
    expect(still / frames.length).toBeGreaterThan(0.5);
  });

  it("never lurches between frames", () => {
    // A single large step is the visible failure mode: the head teleports.
    // Measured worst case over two minutes of speaking at 60fps is 0.082
    // yaw / 0.055 pitch — roughly one pixel per frame on a 400px face. The
    // bound is set above that and far below a teleport, which would be
    // most of the range in one frame.
    const frames = simulate(120, true);
    for (let i = 1; i < frames.length; i++) {
      expect(Math.abs(frames[i].yaw - frames[i - 1].yaw)).toBeLessThan(0.15);
      expect(Math.abs(frames[i].pitch - frames[i - 1].pitch)).toBeLessThan(0.15);
    }
  });

  it("survives a stalled tab without flinging the head", () => {
    // A backgrounded tab delivers one huge dt. Without the MAX_STEP clamp the
    // spring integrates it in a single frame and the head snaps.
    const motion = new HeadMotion(seeded(7));
    for (let i = 0; i < 200; i++) motion.update(16.7, i * 16.7, true);
    const before = motion.yaw;
    motion.update(30_000, 200 * 16.7 + 30_000, true); // 30 seconds in one frame
    expect(Number.isFinite(motion.yaw)).toBe(true);
    expect(Math.abs(motion.yaw - before)).toBeLessThan(0.5);
  });

  it("actually moves — it is not a no-op", () => {
    // The counterpart to the stillness test. A driver that returns zero
    // forever would pass every constraint above; the feather-gradient bug
    // shipped exactly that kind of silent nothing.
    const frames = simulate(120, false);
    const spread = Math.max(...frames.map((f) => f.yaw)) - Math.min(...frames.map((f) => f.yaw));
    expect(spread).toBeGreaterThan(0.2);
  });

  it("does not repeat on a loop the eye can learn", () => {
    // Sums of sines are periodic, and a viewer notices within a minute. Two
    // long windows from the same run should not line up.
    const frames = simulate(240, false).map((f) => f.yaw);
    const half = Math.floor(frames.length / 2);
    let matched = 0;
    for (let i = 0; i < half; i++) {
      if (Math.abs(frames[i] - frames[i + half]) < 0.01) matched++;
    }
    expect(matched / half).toBeLessThan(0.5);
  });

  it("rolls with the yaw rather than independently", () => {
    // Roll that ignores yaw reads as a puppet tilting its head sideways
    // while looking straight ahead.
    const frames = simulate(240, false);
    const big = frames.filter((f) => Math.abs(f.yaw) > 0.3);
    expect(big.length).toBeGreaterThan(10);
    const agreeing = big.filter((f) => Math.sign(f.roll) === Math.sign(f.yaw));
    expect(agreeing.length / big.length).toBeGreaterThan(0.5);
  });
});
