import { describe, expect, it } from "vitest";

import {
  BodyMotion,
  breathCurve,
  phaseForExhaleValue,
  SPEECH_INHALE_MS,
  SPEECH_INHALE_PEAK,
} from "../bodymotion";

/** Run the driver forward at a fixed frame interval. */
function advance(body: BodyMotion, from: number, ms: number, frameMs: number): number {
  let now = from;
  const end = from + ms;
  while (now < end) {
    const step = Math.min(frameMs, end - now);
    now += step;
    body.update(step, now);
  }
  return now;
}

/** Seeded so sway noise is repeatable; breath does not use it. */
const seeded = () => {
  let x = 12345;
  return () => ((x = (x * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
};

describe("speech breathing", () => {
  it("inhales to a deeper-than-rest peak over the inhale window, starting from where the chest was", () => {
    const body = new BodyMotion(seeded());
    let now = advance(body, 0, 1300, 16); // partway through a resting breath
    const before = body.breath;
    body.beginSpeech(now, 3000);
    body.update(1, now + 1);
    // No jump: one millisecond in, the chest is where it was.
    expect(Math.abs(body.breath - before)).toBeLessThan(0.01);
    now = advance(body, now, SPEECH_INHALE_MS, 16);
    expect(body.breath).toBeCloseTo(SPEECH_INHALE_PEAK, 1);
    expect(body.breath).toBeGreaterThan(1); // deeper than any resting breath
  });

  it("spends the breath slowly over the phrase and never empties mid-sentence", () => {
    const body = new BodyMotion(seeded());
    body.beginSpeech(0, 6000);
    let now = advance(body, 0, SPEECH_INHALE_MS, 16);
    const peak = body.breath;
    now = advance(body, now, 2000, 16);
    const later = body.breath;
    expect(later).toBeLessThan(peak);
    now = advance(body, now, 8000, 16);
    // Long past the utterance: at the floor, not at zero.
    expect(body.breath).toBeGreaterThan(0.2);
    expect(body.breath).toBeLessThan(later);
  });

  it("is a function of elapsed time, not of frame rate", () => {
    const at30 = new BodyMotion(seeded());
    const at144 = new BodyMotion(seeded());
    at30.beginSpeech(0, 4000);
    at144.beginSpeech(0, 4000);
    advance(at30, 0, 1500, 33);
    advance(at144, 0, 1500, 7);
    expect(at30.breath).toBeCloseTo(at144.breath, 3);
  });

  it("hands back to the resting rhythm without a visible drop", () => {
    const body = new BodyMotion(seeded());
    body.beginSpeech(0, 3000);
    let now = advance(body, 0, 2500, 16);
    const during = body.breath;
    body.endSpeech();
    body.update(16, now + 16);
    // The next frame continues from the same value, continuing to exhale.
    expect(Math.abs(body.breath - during)).toBeLessThan(0.02);
    now = advance(body, now + 16, 800, 16);
    expect(body.breath).toBeLessThan(during);
  });

  it("phaseForExhaleValue inverts the exhale side of the resting curve", () => {
    for (const v of [0.05, 0.3, 0.6, 0.95]) {
      expect(breathCurve(phaseForExhaleValue(v))).toBeCloseTo(v, 6);
    }
    // Deeper than rest clamps to the top of the curve, not NaN.
    expect(breathCurve(phaseForExhaleValue(1.6))).toBeCloseTo(1, 6);
  });

  it("takes a catch-breath at a pause, but not right after starting nor twice in quick succession", () => {
    const body = new BodyMotion(seeded());
    body.beginSpeech(0, 8000);
    let now = advance(body, 0, 600, 16);
    const early = body.breath;
    body.catchBreath(now); // too soon after the opening inhale: ignored
    now = advance(body, now, 100, 16);
    expect(body.breath).toBeLessThan(early);

    now = advance(body, now, 2500, 16);
    const beforeCatch = body.breath;
    body.catchBreath(now);
    now = advance(body, now, 220, 16);
    expect(body.breath).toBeGreaterThan(beforeCatch); // the chest rose

    const afterFirst = body.breath;
    body.catchBreath(now); // 220ms later: ignored, one pause is one breath
    now = advance(body, now, 300, 16);
    expect(body.breath).toBeLessThan(afterFirst);
  });

  it("changes nothing while nobody is speaking", () => {
    const quiet = new BodyMotion(seeded());
    const reference = new BodyMotion(seeded());
    advance(quiet, 0, 5000, 16);
    advance(reference, 0, 5000, 16);
    expect(quiet.breath).toBeCloseTo(reference.breath, 9);
    expect(quiet.breath).toBeLessThanOrEqual(1);
  });
});
