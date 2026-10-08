import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { Cue } from "../../types";
import { HeadPersonality, POSE_LIMIT_DEG, readSpeech, softLimit } from "../head-personality";

/**
 * The 3D head's personality (head-personality.ts): seeded, so a render is
 * reproducible; inside its conservative envelope however long it runs and
 * whatever the speech does; and timed by the speech: a new posture at each
 * phrase start (the eyes 150 ms ahead), a settle at its end, a nod on each
 * stressed syllable and the brows on the strongest.
 */
const DEG = Math.PI / 180;
const L = POSE_LIMIT_DEG;
const STEP = 16;

const fixture = JSON.parse(
  readFileSync(new URL("../../__tests__/fixtures/native-cues-hello.json", import.meta.url), "utf8")
) as { cues: Cue[] } | Cue[];
const hello = Array.isArray(fixture) ? fixture : fixture.cues;

/** Two phrases, 0-800 and 1300-2100 ms of cue time, a 500 ms silence
 *  between; the first phrase's loudest vowel at 400 ms, the second's at
 *  1700 ms (quieter). */
const twoPhrases: Cue[] = [
  { t: 0, viseme: "PP", a: 0.3 },
  { t: 120, viseme: "aa", a: 0.5 },
  { t: 260, viseme: "SS", a: 0.3 },
  { t: 400, viseme: "aa", a: 1 },
  { t: 560, viseme: "nn", a: 0.3 },
  { t: 680, viseme: "E", a: 0.45 },
  { t: 800, viseme: "sil", a: 0 },
  { t: 1300, viseme: "DD", a: 0.3 },
  { t: 1420, viseme: "O", a: 0.5 },
  { t: 1560, viseme: "kk", a: 0.3 },
  { t: 1700, viseme: "aa", a: 0.8 },
  { t: 1850, viseme: "nn", a: 0.3 },
  { t: 2100, viseme: "sil", a: 0 },
];

/** `p` stepped from 0 to `ms`, speaking with cue time = now - `speechAt`
 *  from `speechAt` for `speechMs`; each frame's pose, gaze and brows. */
function run(p: HeadPersonality, ms: number, speechAt = Infinity, speechMs = 0, energy = 0.5) {
  const out: { t: number; yaw: number; pitch: number; roll: number; gx: number; gy: number; brow: number }[] = [];
  let spoke = false;
  for (let t = STEP; t <= ms; t += STEP) {
    const speaking = t >= speechAt && t < speechAt + speechMs;
    if (speaking && !spoke) spoke = true;
    if (!speaking && spoke && t >= speechAt + speechMs) {
      p.endSpeech(t);
      spoke = false;
      speechAt = Infinity;
    }
    p.update(STEP, t, speaking, energy, () => t - speechAt);
    out.push({ t, ...p.pose, gx: p.gaze.x, gy: p.gaze.y, brow: p.brow });
  }
  return out;
}

describe("the 3D head's personality", () => {
  it("is the same run for run with one seed, and another with another", () => {
    const once = (seed: number) => {
      const p = new HeadPersonality(seed);
      p.start(0);
      p.setSpeech(hello);
      return run(p, 6000, 500, 3000);
    };
    expect(once(3)).toEqual(once(3));
    expect(once(3)).not.toEqual(once(4));
  });

  it("stays inside 7, 5 and 3 degrees, idle and speaking at full energy, for ten minutes", () => {
    // Every frame of a long run.
    const long = new HeadPersonality(5);
    long.start(0);
    long.setSpeech(hello);
    const frames = run(long, 600_000, 2000, 400_000, 1);
    for (const f of frames) {
      expect(Math.abs(f.yaw)).toBeLessThanOrEqual(L.yaw * DEG + 1e-12);
      expect(Math.abs(f.pitch)).toBeLessThanOrEqual(L.pitch * DEG + 1e-12);
      expect(Math.abs(f.roll)).toBeLessThanOrEqual(L.roll * DEG + 1e-12);
      expect(Math.abs(f.gx)).toBeLessThanOrEqual(0.6);
    }
    // And it uses its room: a few degrees of turn, not a twitch.
    const yawPeak = Math.max(...frames.map((f) => Math.abs(f.yaw)));
    expect(yawPeak).toBeGreaterThan(3 * DEG);
  });

  it("eases into its limits instead of flattening against them", () => {
    for (const limit of [L.yaw * DEG, L.pitch * DEG, L.roll * DEG]) {
      expect(softLimit(0.5 * limit, limit)).toBe(0.5 * limit);
      expect(softLimit(-0.7 * limit, limit)).toBeCloseTo(-0.7 * limit, 12);
      let last = 0;
      for (let k = 1; k <= 400; k++) {
        const v = softLimit((k / 100) * limit, limit);
        expect(v).toBeGreaterThan(last);
        expect(v).toBeLessThan(limit);
        last = v;
      }
      // The slope is continuous at the knee.
      const e = 1e-6 * limit;
      const slope = (softLimit(0.7 * limit + e, limit) - softLimit(0.7 * limit, limit)) / e;
      expect(slope).toBeCloseTo(1, 4);
    }
  });

  it("reads the phrases and the stressed syllables off a cue track", () => {
    const s = readSpeech(twoPhrases);
    expect(s.phrases).toEqual([
      { start: 0, end: 800 },
      { start: 1300, end: 2100 },
    ]);
    // A stress a little before its vowel, the louder of each phrase.
    expect(s.accents.map((a) => a.t)).toEqual([340, 1640]);
    expect(s.accents[0].strength).toBe(1);
    expect(s.accents[1].strength).toBeCloseTo(0.8, 9);
    // The strongest of a phrase lifts the brows, if strong at all.
    expect(s.accents.map((a) => a.brow)).toEqual([true, false]);
  });

  it("moves at each phrase start, the eyes first, nods on a stress, settles at the end", () => {
    const p = new HeadPersonality(2);
    p.start(0);
    p.setSpeech(twoPhrases);
    const speechAt = 1000;
    const moves: number[] = [];
    const frames: ReturnType<typeof run> = [];
    // Step by hand to catch each move's moment.
    for (let t = STEP; t <= 4600; t += STEP) {
      const speaking = t >= speechAt && t < speechAt + 2200;
      p.update(STEP, t, speaking, 0.5, () => t - speechAt);
      if (p.movedAt === t) moves.push(t - speechAt);
      frames.push({ t, ...p.pose, gx: p.gaze.x, gy: p.gaze.y, brow: p.brow });
    }
    // The head goes 150 ms after it is asked (the eyes go at once): for the
    // first phrase, asked on the first frame of speech; for the settle at
    // its end (800 ms), asked then; for the second phrase, asked 150 ms
    // before its first sound (1300 ms), so the head moves on it; its settle
    // after 2100 ms.
    expect(moves).toHaveLength(4);
    expect(Math.abs(moves[0] - 166)).toBeLessThanOrEqual(20);
    expect(Math.abs(moves[1] - (800 + 166))).toBeLessThanOrEqual(20);
    expect(Math.abs(moves[2] - 1300)).toBeLessThanOrEqual(20);
    expect(Math.abs(moves[3] - (2100 + 166))).toBeLessThanOrEqual(20);
    // A nod: the pitch dips (chin down) within half a second of each
    // stress, most ~150 ms after it.
    const pitchAt = (cue: number) => frames.find((f) => f.t - speechAt >= cue)!.pitch;
    for (const stress of [340, 1640]) {
      const before = pitchAt(stress - 20);
      const peak = Math.max(
        ...frames.filter((f) => f.t - speechAt > stress && f.t - speechAt < stress + 520).map((f) => f.pitch)
      );
      expect(peak - before).toBeGreaterThan(0.3 * DEG);
    }
    // The brows rise on the first phrase's stress only.
    const browWhen = (from: number, to: number) =>
      Math.max(...frames.filter((f) => f.t - speechAt >= from && f.t - speechAt < to).map((f) => f.brow));
    expect(browWhen(340, 1040)).toBeGreaterThan(0.9);
    expect(browWhen(1640, 2340)).toBe(0);
  });

  it("settles after the last word: back toward the middle, the chin a little down", () => {
    const p = new HeadPersonality(9);
    p.start(0);
    p.setSpeech(twoPhrases);
    run(p, 3200, 0, 2200);
    // Two seconds after: most of the phrase's turn is gone.
    const settled = run(p, 1500);
    const last = settled[settled.length - 1];
    expect(Math.abs(last.yaw)).toBeLessThan(3 * DEG);
  });
});
