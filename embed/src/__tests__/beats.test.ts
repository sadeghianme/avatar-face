import { describe, expect, it } from "vitest";

import { emphasisBeats } from "../engine";
import type { Cue } from "../types";

/**
 * Where the head marks the beat. The information comes from the cue
 * track's amplitudes, which after the server measures the rendered audio
 * are how loud each syllable actually was — so a beat lands where the
 * voice leaned, not where the spelling suggested it might.
 */
const v = (t: number, a: number, viseme = "aa"): Cue => ({ t, viseme, a });

describe("emphasisBeats", () => {
  it("marks the prominent syllable, not every loud one", () => {
    const beats = emphasisBeats([
      v(0, 0.4),
      v(400, 1.0), // the accent
      v(800, 0.4),
      v(1200, 0.35),
    ]);
    expect(beats).toHaveLength(1);
    expect(beats[0].t).toBe(400 - 80); // led slightly, see BEAT_LEAD_MS
  });

  it("requires a local peak, so an emphatic sentence is not a bobblehead", () => {
    // Every vowel at full amplitude: loud, but nothing stands out.
    const flat = Array.from({ length: 8 }, (_, i) => v(i * 300, 1.0));
    const beats = emphasisBeats(flat);
    // At most one per BEAT_MIN_GAP_MS, never one per syllable.
    for (let i = 1; i < beats.length; i++) {
      expect(beats[i].t - beats[i - 1].t).toBeGreaterThanOrEqual(900);
    }
    expect(beats.length).toBeLessThan(flat.length / 2);
  });

  it("keeps beats at least a phrase apart", () => {
    const beats = emphasisBeats([
      v(0, 0.3),
      v(200, 1.0),
      v(400, 0.3),
      v(600, 1.0), // too soon after the first accent
      v(800, 0.3),
      v(1600, 1.0), // far enough to earn its own
      v(1800, 0.3),
    ]);
    for (let i = 1; i < beats.length; i++) {
      expect(beats[i].t - beats[i - 1].t).toBeGreaterThanOrEqual(900);
    }
    expect(beats.length).toBeGreaterThanOrEqual(2);
  });

  it("is relative: a quiet sentence still has accents", () => {
    const loud = emphasisBeats([v(0, 0.4), v(400, 1.0), v(800, 0.4)]);
    const quiet = emphasisBeats([v(0, 0.16), v(400, 0.4), v(800, 0.16)]);
    expect(quiet.map((b) => b.t)).toEqual(loud.map((b) => b.t));
  });

  it("ignores consonants — the head marks syllables, not stops", () => {
    const beats = emphasisBeats([
      { t: 0, viseme: "PP", a: 1 },
      { t: 100, viseme: "SS", a: 1 },
      { t: 200, viseme: "FF", a: 1 },
    ]);
    expect(beats).toEqual([]);
  });

  it("never returns a negative time", () => {
    const beats = emphasisBeats([v(0, 1.0), v(500, 0.3), v(1000, 0.9)]);
    for (const beat of beats) expect(beat.t).toBeGreaterThanOrEqual(0);
  });

  it("gives a flat or empty track no beats to fire", () => {
    expect(emphasisBeats([])).toEqual([]);
    expect(emphasisBeats([v(0, 1)])).toEqual([]);
    expect(emphasisBeats([v(0, 0), v(300, 0)])).toEqual([]);
  });

  it("emits beats in order, with a bounded strength", () => {
    const beats = emphasisBeats([
      v(0, 0.3), v(300, 1.0), v(600, 0.3), v(1500, 0.8), v(1800, 0.3), v(3000, 0.95),
    ]);
    for (let i = 1; i < beats.length; i++) {
      expect(beats[i].t).toBeGreaterThan(beats[i - 1].t);
    }
    for (const beat of beats) {
      expect(beat.strength).toBeGreaterThan(0);
      expect(beat.strength).toBeLessThanOrEqual(1.3);
    }
  });
});
