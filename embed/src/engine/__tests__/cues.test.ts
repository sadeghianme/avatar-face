import { describe, expect, it } from "vitest";

import { ZERO_WEIGHTS, type BlendWeights, type Cue, type Rig } from "../../types";
import { blendCueWeights, utteranceMs, visemeAt } from "../cues";

/**
 * The cue track, read (cues.ts): the co-articulated blend at an instant,
 * the viseme sounding then, and how long a track runs. prepareCues and
 * emphasisBeats have their own files (src/__tests__/cues.test.ts,
 * beats.test.ts).
 */

const VISEMES: Rig["visemes"] = {
  sil: {},
  aa: { jawOpen: 0.7, mouthStretch: 0.1 },
  E: { jawOpen: 0.3, mouthStretch: 0.5 },
  oh: { jawOpen: 0.45, mouthPucker: 0.6 },
  PP: { mouthClose: 1 },
  FF: { mouthClose: 0.6, mouthStretch: 0.25 },
};

const cue = (t: number, viseme: string, a = 1): Cue => ({ t, viseme, a });
const at = (cues: Cue[], t: number) => blendCueWeights(cues, VISEMES, t);

describe("blendCueWeights", () => {
  it("is at rest before the first cue", () => {
    expect(at([cue(100, "aa"), cue(400, "sil")], 99)).toEqual(ZERO_WEIGHTS);
  });

  it("reaches a long vowel's own shape in the middle of its span: a flat top, not a peak", () => {
    // 600 ms of /a/: the neighbouring silence's bell is negligible at the
    // vowel's centre, so the shape is the table's, exactly.
    const track = [cue(0, "aa"), cue(600, "sil"), cue(1000, "sil")];
    const middle = at(track, 300);
    expect(middle.jawOpen).toBeCloseTo(0.7, 9);
    expect(middle.mouthStretch).toBeCloseTo(0.1, 9);
    // And holds it, within 5%, across the middle third of the span (the
    // bell's flat top; the silence's bell is already pulling at 400 ms).
    for (const t of [200, 250, 350, 400]) expect(at(track, t).jawOpen).toBeGreaterThan(0.7 * 0.95);
  });

  it("hands one shape to the next without a step", () => {
    const track = [cue(0, "sil"), cue(100, "aa"), cue(300, "E"), cue(450, "oh"), cue(700, "sil"), cue(900, "sil")];
    const keys = Object.keys(ZERO_WEIGHTS) as (keyof BlendWeights)[];
    let previous = at(track, 0);
    let largest = 0;
    for (let t = 1; t <= 900; t++) {
      const now = at(track, t);
      for (const key of keys) largest = Math.max(largest, Math.abs(now[key] - previous[key]));
      previous = now;
    }
    // A cue boundary is not a jump: no weight moves 2% of its range in 1 ms.
    expect(largest).toBeLessThan(0.02);
  });

  it("scales an unstressed syllable's shape, not its timing", () => {
    const stressed = at([cue(0, "aa", 1), cue(600, "sil"), cue(1000, "sil")], 300);
    const reduced = at([cue(0, "aa", 0.5), cue(600, "sil"), cue(1000, "sil")], 300);
    expect(reduced.jawOpen).toBeCloseTo(stressed.jawOpen * 0.5, 9);
  });

  it("closes the lips on a /p/ squeezed between two vowels, whatever its stress", () => {
    // 60 ms of /p/ inside a word: an average alone would leave the lips
    // apart; the constraint pass pulls the shape back onto the closure.
    const track = (a: number) => [cue(0, "aa"), cue(250, "PP", a), cue(310, "aa"), cue(560, "sil"), cue(900, "sil")];
    const centre = 280;
    const closed = at(track(1), centre);
    expect(closed.mouthClose).toBeGreaterThan(0.8);
    expect(closed.jawOpen).toBeLessThan(0.2);
    // An unstressed /p/ closes as fully: the gate ignores the amplitude.
    expect(at(track(0.4), centre).mouthClose).toBeGreaterThan(0.8);
  });

  it("passes through a short silence between two sounds, and closes on a pause", () => {
    const gap = (ms: number) => [
      cue(0, "aa"),
      cue(200, "sil"),
      cue(200 + ms, "aa"),
      cue(600 + ms, "sil"),
      cue(900 + ms, "sil"),
    ];
    const short = at(gap(40), 220).jawOpen;
    const pause = at(gap(400), 400).jawOpen;
    expect(short).toBeGreaterThan(0.3);
    expect(pause).toBeLessThan(0.05);
  });

  it("treats a viseme the table does not know as no shape", () => {
    const known = at([cue(0, "aa"), cue(600, "sil"), cue(1000, "sil")], 300);
    const unknown = at([cue(0, "zz"), cue(600, "sil"), cue(1000, "sil")], 300);
    expect(unknown).toEqual(ZERO_WEIGHTS);
    expect(known.jawOpen).toBeGreaterThan(0);
  });

  it("holds the last cue's shape long after the track, where no bell reaches", () => {
    expect(at([cue(0, "E")], 10_000)).toEqual({ ...ZERO_WEIGHTS, ...VISEMES.E });
  });
});

describe("visemeAt", () => {
  const track = [cue(0, "sil"), cue(100, "aa"), cue(250, "PP"), cue(300, "sil")];

  it("is the last cue at or before the time", () => {
    expect(visemeAt(track, 99)).toBe("sil");
    expect(visemeAt(track, 100)).toBe("aa");
    expect(visemeAt(track, 249.9)).toBe("aa");
    expect(visemeAt(track, 250)).toBe("PP");
    expect(visemeAt(track, 5000)).toBe("sil");
  });

  it("is silence before the track and for an empty one", () => {
    expect(visemeAt([cue(100, "aa")], 50)).toBe("sil");
    expect(visemeAt([], 50)).toBe("sil");
  });
});

describe("utteranceMs", () => {
  it("is the latest cue's time, in whatever order the cues come", () => {
    expect(utteranceMs([cue(0, "aa"), cue(900, "sil"), cue(400, "E")])).toBe(900);
    expect(utteranceMs([])).toBe(0);
  });
});
