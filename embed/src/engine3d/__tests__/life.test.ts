import { afterEach, describe, expect, it, vi } from "vitest";

import { FaceLife, blinkAmount, lookMorphs } from "../life";

/** A random that answers `values` in turn, then 0.5. */
const scripted = (...values: number[]) => () => values.shift() ?? 0.5;

const FRAME = 1000 / 60;

describe("the blink's sweep", () => {
  it("closes by 0.4 of its phase and opens again by 1", () => {
    expect(blinkAmount(0)).toBe(0);
    expect(blinkAmount(-1)).toBe(0);
    expect(blinkAmount(0.2)).toBeCloseTo(Math.SQRT1_2, 12);
    expect(blinkAmount(0.4)).toBeCloseTo(1, 12);
    expect(blinkAmount(0.7)).toBeCloseTo(Math.SQRT1_2, 12);
    expect(blinkAmount(1)).toBeCloseTo(0, 12);
    let last = 0;
    for (let p = 0.01; p < 0.4; p += 0.01) {
      expect(blinkAmount(p)).toBeGreaterThan(last);
      last = blinkAmount(p);
    }
  });
});

describe("the gaze as eyeLook morphs", () => {
  it("turns both eyes the same way, and the lids damp it", () => {
    const right = lookMorphs({ x: 0.2, y: -0.1 }, 0);
    expect(right.eyeLookInLeft).toBeCloseTo(0.2, 12);
    expect(right.eyeLookOutRight).toBeCloseTo(0.2, 12);
    expect(right.eyeLookOutLeft).toBe(0);
    expect(right.eyeLookInRight).toBe(0);
    expect(right.eyeLookUpLeft).toBeCloseTo(0.1, 12);
    expect(right.eyeLookUpRight).toBeCloseTo(0.1, 12);
    expect(right.eyeLookDownLeft).toBe(0);
    const half = lookMorphs({ x: -0.2, y: 0.1 }, 0.5);
    expect(half.eyeLookOutLeft).toBeCloseTo(0.1, 12);
    expect(half.eyeLookDownRight).toBeCloseTo(0.05, 12);
    expect(Object.values(lookMorphs({ x: 0.3, y: 0.3 }, 1)).every((v) => v === 0)).toBe(true);
  });
});

describe("the face's life", () => {
  afterEach(() => vi.restoreAllMocks());

  it("blinks first between 1.2 and 3.2 s, for 15 frames, then every 2.2 to 5.4 s", () => {
    const life = new FaceLife(scripted(0.5, 0.5, 0.25));
    life.start(0); // first blink at 2200
    expect(life.blink(2199)).toBe(0);
    const sweep: number[] = [];
    for (let i = 0; i < 16; i++) sweep.push(life.blink(2200 + i * FRAME));
    expect(sweep[0]).toBeGreaterThan(0);
    expect(Math.max(...sweep)).toBeGreaterThan(0.95);
    expect(sweep.slice(0, 14).every((v) => v > 0)).toBe(true);
    expect(sweep[14]).toBe(0); // open again after 15 frames
    // Next: 2200 + 2200 + 0.25 * 3200 = 5200.
    expect(life.blink(5199)).toBe(0);
    expect(life.blink(5200)).toBeGreaterThan(0);
  });

  it("glances first between 0.6 and 1.8 s, and moves a third of the way there each frame", () => {
    // start: the blink's draw, the saccade's (0.5 -> 1200); at the glance:
    // the next saccade's draw, then x and y.
    const life = new FaceLife(scripted(0.5, 0.5, 0.5, 1, 0));
    life.start(0);
    expect(life.look(1199, false)).toEqual({ x: 0, y: 0 });
    // x = (1*2-1)*0.3, y = (0*2-1)*0.3*0.5, a third of the way (0.35).
    const first = { ...life.look(1200, false) };
    expect(first.x).toBeCloseTo(0.3 * 0.35, 12);
    expect(first.y).toBeCloseTo(-0.15 * 0.35, 12);
    let gaze = first;
    for (let i = 1; i < 60; i++) gaze = { ...life.look(1200 + i, false) };
    expect(gaze.x).toBeCloseTo(0.3, 6);
    expect(gaze.y).toBeCloseTo(-0.15, 6);
  });

  it("keeps the glances nearer the viewer while speaking", () => {
    const quiet = new FaceLife(scripted(0, 0, 0, 1, 1));
    quiet.start(0);
    const speaking = new FaceLife(scripted(0, 0, 0, 1, 1));
    speaking.start(0);
    let q = { x: 0, y: 0 };
    let s = { x: 0, y: 0 };
    for (let t = 600; t < 1400; t += FRAME) {
      q = { ...quiet.look(t, false) };
      s = { ...speaking.look(t, true) };
    }
    expect(q.x).toBeCloseTo(0.3, 3);
    expect(s.x).toBeCloseTo(0.16, 3);
  });

  it("nods only while speaking, over about 41 frames, rising and settling", () => {
    const life = new FaceLife(scripted(0.5, 0.5, 0.5));
    life.start(0); // first nod due at 2500
    expect(life.nod(3000, false)).toBe(0);
    const lifts: number[] = [];
    for (let i = 0; i < 45; i++) lifts.push(life.nod(3000 + i * FRAME, true));
    expect(lifts[0]).toBeGreaterThan(0);
    expect(Math.max(...lifts)).toBeGreaterThan(0.99);
    expect(lifts[40]).toBe(0); // done after 41 frames
    // The next nod waits 1.8 to 4.4 s.
    expect(lifts.slice(41).every((v) => v === 0)).toBe(true);
  });

  it("reads Math.random when it draws, so a page that seeds it later is seeded", () => {
    const life = new FaceLife();
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    life.start(0);
    expect(random).toHaveBeenCalledTimes(2);
    expect(life.blink(1199)).toBe(0);
    expect(life.blink(1200)).toBeGreaterThan(0);
  });
});
