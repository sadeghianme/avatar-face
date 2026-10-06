import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BLINK_MS } from "../blink";
import { BREATH_RISE, SWAY_TRAVEL } from "../bodymotion";
import type { Beat } from "../cues";
import type { HeadGeom, Point } from "../geometry";
import { Motion, type SpeechFrame } from "../motion";
import { restingFace, type FaceState } from "../state";

/**
 * The involuntary motion (motion.ts), on a seeded clock: the nod's sin²
 * envelope on the speech's accents, the ambient cadence without them, the
 * gaze's ballistic approach, the pause's catch-breath, blink and glance,
 * the blink phase reaching the face, and the body's lean about a pivot
 * below the frame.
 */

const FRAME = 16;
/** A head that only nods: no drift travel, so dy is the nod alone. */
const NOD_ONLY: HeadGeom = { x: 0, y: 0, w: 200, h: 260, pivotX: 100, pivotY: 400, yawPx: 0, pitchPx: 0, faceH: 100 };
const BEAT_NOD_MS = 420;
const AMBIENT_NOD_MS = 1050;

let seed = 1;
const random = () => {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
};

function setup(): { face: FaceState; motion: Motion } {
  const face = restingFace();
  const motion = new Motion(face);
  motion.start(0);
  return { face, motion };
}

/** Speech as the engine reports it, at cue time `cue`. */
const speaking = (cue: number, energy = 1): SpeechFrame => ({ speaking: true, wordActive: true, energy, cueTime: () => cue });
const idle: SpeechFrame = { speaking: false, wordActive: false, energy: 0, cueTime: () => 0 };

/** The nod alone, 0..1: the head's dy over everything that scales it. */
const nodOf = (motion: Motion, strength: number) =>
  motion.headOffset(NOD_ONLY, 1).dy / (motion.energy * NOD_ONLY.faceH * 0.013 * strength);

describe("the head's nods", () => {
  beforeEach(() => {
    seed = 1;
    vi.spyOn(Math, "random").mockImplementation(random);
  });
  afterEach(() => vi.restoreAllMocks());

  it("dips on an accent with a sin² envelope that starts and ends still, walked on the cue clock", () => {
    const { motion } = setup();
    const beat: Beat = { t: 400, strength: 1.2 };
    motion.beginSpeech(0, 2000, [beat]);
    let firedAt: number | null = null;
    for (let now = FRAME; now <= 1200; now += FRAME) {
      motion.update(FRAME, now, speaking(now));
      const dy = motion.headOffset(NOD_ONLY, 1).dy;
      if (now < beat.t) {
        expect(dy).toBe(0);
        continue;
      }
      firedAt ??= now;
      // The phase advances a frame's share of the nod each frame, from the
      // frame the cue clock crossed the beat.
      const p = Math.min(1, ((now - firedAt) / FRAME + 1) * (FRAME / BEAT_NOD_MS));
      expect(nodOf(motion, beat.strength)).toBeCloseTo(Math.sin(p * Math.PI) ** 2, 9);
    }
    expect(firedAt).toBe(400);
    // Still at both ends: the first frame of the dip is a sliver of its peak.
    expect(Math.sin((FRAME / BEAT_NOD_MS) * Math.PI) ** 2).toBeLessThan(0.02);
  });

  it("skips a beat the clock jumped over rather than firing a stale nod", () => {
    const { motion } = setup();
    motion.beginSpeech(0, 3000, [{ t: 100, strength: 1 }]);
    for (let now = FRAME; now <= 1000; now += FRAME) {
      // A seek put the cue clock at 1 s: the beat at 100 ms is long gone.
      motion.update(FRAME, now, speaking(1000 + now));
      expect(motion.headOffset(NOD_ONLY, 1).dy).toBe(0);
    }
  });

  it("re-places the walker on a seek: beats behind the new position are spent", () => {
    const { motion } = setup();
    motion.beginSpeech(0, 3000, [{ t: 300, strength: 1 }, { t: 1500, strength: 1 }]);
    motion.placeBeatWalker(1000);
    for (let now = FRAME; now <= 400; now += FRAME) {
      motion.update(FRAME, now, speaking(1000 + now));
      expect(motion.headOffset(NOD_ONLY, 1).dy).toBe(0);
    }
    for (let now = 400 + FRAME; now <= 700; now += FRAME) motion.update(FRAME, now, speaking(1000 + now));
    expect(motion.headOffset(NOD_ONLY, 1).dy).toBeGreaterThan(0);
  });

  it("nods on a loose cadence when the track has no accents, slower than a beat", () => {
    const { motion } = setup();
    motion.beginSpeech(0, 6000, []);
    const moving: number[] = [];
    for (let now = FRAME; now <= 4000; now += FRAME) {
      motion.update(FRAME, now, speaking(now));
      if (motion.headOffset(NOD_ONLY, 1).dy > 0) moving.push(now);
    }
    // The first ambient nod is due 2.5 s after start; it lasts its own span.
    expect(moving[0]).toBeGreaterThanOrEqual(2500);
    expect(moving[0]).toBeLessThan(2500 + FRAME);
    const span = moving.filter((t) => t < moving[0] + 2 * AMBIENT_NOD_MS);
    expect(span[span.length - 1] - span[0]).toBeGreaterThan(AMBIENT_NOD_MS - 2 * FRAME);
    expect(span[span.length - 1] - span[0]).toBeLessThan(AMBIENT_NOD_MS);
  });

  it("does not move a head it has no geometry for, nor at no strength", () => {
    const { motion } = setup();
    motion.beginSpeech(0, 2000, [{ t: 50, strength: 1 }]);
    for (let now = FRAME; now <= 200; now += FRAME) motion.update(FRAME, now, speaking(now));
    expect(motion.headOffset(null, 1)).toEqual({ dx: 0, dy: 0, roll: 0, fdx: 0, fdy: 0 });
    const still = motion.headOffset(NOD_ONLY, 0);
    expect([still.dx, still.dy, still.roll]).toEqual([0, 0, 0]);
    expect(motion.headOffset(NOD_ONLY, 1).dy).toBeGreaterThan(0);
  });
});

describe("the eyes", () => {
  afterEach(() => vi.restoreAllMocks());

  it("jump toward a fixation ballistically: a 35 ms time constant, whatever the frame rate", () => {
    seed = 1;
    vi.spyOn(Math, "random").mockImplementation(random);
    const { face, motion } = setup();
    motion.gazeTarget = { x: 0.2, y: -0.1 };
    // Well before the first saccade (600 ms at the earliest).
    motion.update(35, 35, idle);
    expect(face.gaze.x).toBeCloseTo(0.2 * (1 - Math.exp(-1)), 12);
    expect(face.gaze.y).toBeCloseTo(-0.1 * (1 - Math.exp(-1)), 12);
    const halves = setup();
    halves.motion.gazeTarget = { x: 0.2, y: -0.1 };
    halves.motion.update(17.5, 17.5, idle);
    halves.motion.update(17.5, 35, idle);
    expect(halves.face.gaze.x).toBeCloseTo(face.gaze.x, 12);
  });

  it("look at the listener when speech starts", () => {
    seed = 1;
    vi.spyOn(Math, "random").mockImplementation(random);
    const { motion } = setup();
    motion.gazeTarget = { x: 0.25, y: 0.1 };
    motion.beginSpeech(100, 1000, []);
    expect(motion.gazeTarget).toEqual({ x: 0, y: 0 });
  });

  it("blink when the scheduler says, for one blink's length, and the face shows it", () => {
    seed = 1;
    vi.spyOn(Math, "random").mockImplementation(random);
    const { face, motion } = setup();
    motion.update(FRAME, 100, idle);
    expect(face.blink).toBe(0);
    motion.blinks.onPause(100);
    const seen: number[] = [];
    for (let now = 100 + FRAME; now <= 100 + BLINK_MS + 2 * FRAME; now += FRAME) {
      motion.update(FRAME, now, idle);
      seen.push(face.blink);
    }
    expect(seen[0]).toBeGreaterThan(0);
    expect(Math.max(...seen)).toBeGreaterThan(0.8);
    expect(seen[seen.length - 1]).toBe(0);
    expect(seen.every((phase) => phase >= 0 && phase < 1)).toBe(true);
  });
});

describe("a pause in the speech", () => {
  afterEach(() => vi.restoreAllMocks());

  it("is a catch-breath, a blink and (sometimes) a glance away, once per pause; speech brings the eyes back", () => {
    // Every draw 0.3: under the 0.45 that makes a pause a glance away.
    vi.spyOn(Math, "random").mockReturnValue(0.3);
    const { motion } = setup();
    const breath = vi.spyOn(motion.body, "catchBreath");
    const blink = vi.spyOn(motion.blinks, "onPause");
    motion.notePause(1000, true);
    motion.notePause(1200, true); // 200 ms: the space between two words
    expect(breath).not.toHaveBeenCalled();
    motion.notePause(1260, true); // 260 ms: a pause
    expect(breath).toHaveBeenCalledTimes(1);
    expect(blink).toHaveBeenCalledWith(1260);
    expect(motion.gazeTarget.y).toBeGreaterThan(0.18);
    motion.notePause(2000, true); // still the same pause: spent
    expect(breath).toHaveBeenCalledTimes(1);
    motion.notePause(2016, false);
    expect(motion.gazeTarget).toEqual({ x: 0, y: 0 });
    // The next silence is a new run.
    motion.notePause(3000, true);
    motion.notePause(3300, true);
    expect(breath).toHaveBeenCalledTimes(2);
  });

  it("brings nothing back after a gap too short to be a pause", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.3);
    const { motion } = setup();
    motion.gazeTarget = { x: 0.1, y: 0 };
    motion.notePause(1000, true);
    motion.notePause(1100, false);
    expect(motion.gazeTarget).toEqual({ x: 0.1, y: 0 });
  });
});

describe("the body's lean", () => {
  beforeEach(() => {
    seed = 1;
    vi.spyOn(Math, "random").mockImplementation(random);
  });
  afterEach(() => vi.restoreAllMocks());

  // A face 200 px wide and 260 tall, centred at (300, 330) on a 1000 px canvas.
  const face: Point[] = [{ x: 200, y: 200 }, { x: 400, y: 200 }, { x: 300, y: 460 }];

  it("pivots below the frame, under the face, and travels the measured sway at head height", () => {
    const { motion } = setup();
    motion.measureBody(face, 1000);
    for (let now = FRAME; now <= 3000; now += FRAME) motion.update(FRAME, now, idle);
    const lean = motion.bodyLean(1)!;
    expect(lean.pivot).toEqual({ x: 300, y: 1750 });
    const swayAngle = (200 * 1.4 * SWAY_TRAVEL) / 2 / (1750 - 330);
    expect(lean.angle).toBeCloseTo(motion.body.sway * swayAngle, 12);
    expect(lean.rise).toBeCloseTo(motion.body.breath * 260 * BREATH_RISE, 12);
    expect(motion.body.sway).not.toBe(0);
    // At half strength, half the travel; at none, no lean at all.
    const half = motion.bodyLean(0.5)!;
    expect(half.angle).toBeCloseTo(lean.angle / 2, 12);
    expect(motion.bodyLean(0)).toBeNull();
  });
});
