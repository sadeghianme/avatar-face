import { describe, expect, it } from "vitest";

import { BodyMotion, BREATH_PERIOD_S, breathCurve } from "../bodymotion";

function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function simulate(seconds: number, fps = 60) {
  const body = new BodyMotion(seeded(11));
  const dt = 1000 / fps;
  const frames: { sway: number; breath: number }[] = [];
  for (let i = 0; i < seconds * fps; i++) {
    body.update(dt, (i + 1) * dt);
    frames.push({ sway: body.sway, breath: body.breath });
  }
  return frames;
}

describe("breathCurve", () => {
  it("returns to where it started, without a corner at the top", () => {
    // A slope discontinuity at the peak reads as a gasp rather than a breath.
    expect(breathCurve(0)).toBeCloseTo(breathCurve(1), 6);
    const samples = Array.from({ length: 400 }, (_, i) => breathCurve(i / 400));
    let maxJerk = 0;
    for (let i = 2; i < samples.length; i++) {
      const secondDiff = samples[i] - 2 * samples[i - 1] + samples[i - 2];
      maxJerk = Math.max(maxJerk, Math.abs(secondDiff));
    }
    expect(maxJerk).toBeLessThan(0.01);
  });

  it("stays in 0..1 and actually peaks", () => {
    const samples = Array.from({ length: 200 }, (_, i) => breathCurve(i / 200));
    expect(Math.min(...samples)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...samples)).toBeGreaterThan(0.95);
    expect(Math.max(...samples)).toBeLessThanOrEqual(1);
  });

  it("inhales faster than it exhales", () => {
    // Symmetric breathing looks like a machine. The peak must sit before
    // the midpoint of the cycle.
    let peakPhase = 0;
    let peak = -1;
    for (let i = 0; i < 1000; i++) {
      const value = breathCurve(i / 1000);
      if (value > peak) {
        peak = value;
        peakPhase = i / 1000;
      }
    }
    expect(peakPhase).toBeLessThan(0.5);
  });
});

describe("BodyMotion", () => {
  it("keeps sway inside its stated range", () => {
    // The renderer multiplies this by a pixel travel; out of range means the
    // photo's own edge walks into frame.
    for (const frame of simulate(180)) {
      expect(Math.abs(frame.sway)).toBeLessThanOrEqual(1);
      expect(frame.breath).toBeGreaterThanOrEqual(0);
      expect(frame.breath).toBeLessThanOrEqual(1);
    }
  });

  it("drifts without ever jumping", () => {
    const frames = simulate(180);
    for (let i = 1; i < frames.length; i++) {
      expect(Math.abs(frames[i].sway - frames[i - 1].sway)).toBeLessThan(0.05);
    }
  });

  it("moves, and wanders rather than sitting at one offset", () => {
    const sways = simulate(300).map((f) => f.sway);
    const spread = Math.max(...sways) - Math.min(...sways);
    expect(spread).toBeGreaterThan(0.1);
    // Mean near zero: a body that settles off-centre reads as leaning.
    const mean = sways.reduce((a, b) => a + b, 0) / sways.length;
    expect(Math.abs(mean)).toBeLessThan(0.6);
  });

  it("breathes at the same rate whatever the frame rate", () => {
    // Frame-rate dependence here would make the avatar breathe faster on a
    // 144Hz monitor, which is the sort of thing only one user ever reports.
    const at30 = simulate(BREATH_PERIOD_S * 2, 30).map((f) => f.breath);
    const at144 = simulate(BREATH_PERIOD_S * 2, 144).map((f) => f.breath);
    const peaks = (xs: number[]) => {
      let count = 0;
      for (let i = 1; i < xs.length - 1; i++) {
        if (xs[i] > xs[i - 1] && xs[i] >= xs[i + 1] && xs[i] > 0.9) count++;
      }
      return count;
    };
    expect(peaks(at30)).toBe(peaks(at144));
  });

  it("survives a stalled tab", () => {
    const body = new BodyMotion(seeded(3));
    for (let i = 0; i < 100; i++) body.update(16.7, i * 16.7);
    body.update(60_000, 100 * 16.7 + 60_000);
    expect(Number.isFinite(body.sway)).toBe(true);
    expect(Math.abs(body.sway)).toBeLessThanOrEqual(1);
  });
});
