import { describe, expect, it } from "vitest";

import { DEFAULT_ATTACK_MS, DEFAULT_RELEASE_MS, Envelope, ExpressionMixer, IdleExpressions } from "../expression-mixer";
import { NONE } from "../expression-rig";
import type { ShapeName } from "../expression-table";

/** The expressions over time (expression-mixer.ts): the envelope, the
 *  cross-fade, the track, the idle layer. */
describe("an envelope", () => {
  it("attacks from where it is, holds, then releases, eased at both ends", () => {
    const env = new Envelope();
    env.go(0, 0.8, 200, 300, 400);
    expect(env.step(0)).toBe(0);
    expect(env.step(100)).toBeCloseTo(0.4, 6); // smoothstep's middle
    expect(env.step(20)).toBeLessThan(0.8 * 0.1 * 1.01); // slow start
    expect(env.step(200)).toBeCloseTo(0.8, 9);
    expect(env.step(499)).toBeCloseTo(0.8, 9); // held
    expect(env.step(700)).toBeCloseTo(0.4, 6); // half released
    expect(env.step(900)).toBe(0);
    expect(env.target).toBe(0);
  });

  it("holds until changed when given no hold", () => {
    const env = new Envelope();
    env.go(0, 1, 100);
    expect(env.step(1e7)).toBe(1);
  });

  it("changes course mid-flight without a jump", () => {
    const env = new Envelope();
    env.go(0, 1, 300);
    const at = env.step(150);
    env.go(150, 0, 300);
    expect(env.step(150)).toBeCloseTo(at, 12);
    expect(env.step(151)).toBeLessThanOrEqual(at);
  });
});

describe("the expression mixer", () => {
  const steps = (m: ExpressionMixer, from: number, to: number, dt = 16) => {
    const seen: Record<ShapeName, number>[] = [];
    for (let t = from; t <= to; t += dt) seen.push({ ...m.step(t, false) });
    return seen;
  };

  it("sets an expression on its envelope and reports it", () => {
    const m = new ExpressionMixer();
    m.set("happy", 0.6, {}, 0, "api");
    m.step(DEFAULT_ATTACK_MS / 2, false);
    expect(m.state().level).toBeCloseTo(0.3, 6);
    m.step(DEFAULT_ATTACK_MS, false);
    expect(m.state()).toMatchObject({ name: "happy", intensity: 0.6, source: "api", level: 0.6 });
    expect(m.weights.happy).toBeCloseTo(0.6, 9);
    expect(m.active()).toBe(true);
  });

  it("cross-fades from one expression to the next with no frame jumping", () => {
    const m = new ExpressionMixer();
    m.set("happy", 1, {}, 0, "api");
    steps(m, 0, 400);
    m.set("concerned", 1, { attackMs: 300 }, 400, "api");
    const seen = steps(m, 400, 900, 16);
    for (let k = 1; k < seen.length; k++) {
      expect(Math.abs(seen[k].happy - seen[k - 1].happy)).toBeLessThan(0.1);
      expect(Math.abs(seen[k].concerned - seen[k - 1].concerned)).toBeLessThan(0.1);
    }
    expect(seen[seen.length - 1].happy).toBe(0);
    expect(seen[seen.length - 1].concerned).toBe(1);
  });

  it("releases on neutral, and on a hold that ends", () => {
    const m = new ExpressionMixer();
    m.set("surprised", 1, { attackMs: 0 }, 0, "api");
    m.set("neutral", 1, { releaseMs: 200 }, 100, "api");
    expect(m.state().name).toBe("neutral");
    m.step(400, false);
    expect(m.active()).toBe(false);
    m.set("happy", 1, { attackMs: 100, holdMs: 200, releaseMs: 100 }, 1000, "api");
    m.step(1250, false);
    expect(m.weights.happy).toBe(1);
    m.step(1400, false);
    expect(m.weights.happy).toBe(0);
  });

  it("clamps the intensity, and treats 0 as a release", () => {
    const m = new ExpressionMixer();
    m.set("happy", 7, { attackMs: 0 }, 0, "api");
    m.step(1, false);
    expect(m.weights.happy).toBe(1);
    m.set("happy", Number.NaN, { releaseMs: 0 }, 2, "api");
    m.step(3, false);
    expect(m.state().name).toBe("neutral");
    expect(m.weights.happy).toBe(0);
  });

  it("walks a text's track on the speech's clock, and seeks", () => {
    const m = new ExpressionMixer();
    m.setTrack([
      { t: 500, name: "concerned", intensity: 0.7 },
      { t: 100, name: "happy", intensity: 1 },
      { t: 900, name: "neutral", intensity: 0 },
    ]);
    m.walk(50, 0);
    expect(m.state().name).toBe("neutral");
    m.walk(120, 10);
    expect(m.state()).toMatchObject({ name: "happy", source: "text" });
    m.walk(600, 20);
    expect(m.state()).toMatchObject({ name: "concerned", intensity: 0.7 });
    m.seek(0);
    m.walk(150, 30);
    expect(m.state().name).toBe("happy");
    m.walk(1000, 40);
    expect(m.state().name).toBe("neutral");
  });

  it("retimes a track in place: a fired cue is not fired again, an unreached one still is", () => {
    const m = new ExpressionMixer();
    m.setTrack([
      { t: 100, name: "happy", intensity: 1 },
      { t: 500, name: "concerned", intensity: 0.7 },
    ]);
    m.walk(150, 10);
    expect(m.state().name).toBe("happy");
    // The speech turned out longer: both later; happy, already on, is not
    // set again (a page's expression set since would be kept).
    m.set("thinking", 1, {}, 20, "api");
    m.retime([
      { t: 200, name: "happy", intensity: 1 },
      { t: 1000, name: "concerned", intensity: 0.7 },
    ]);
    m.walk(600, 30);
    expect(m.state().name).toBe("thinking");
    // Shorter again: concerned, not yet reached, fires as soon as its time
    // has passed.
    m.retime([
      { t: 50, name: "happy", intensity: 1 },
      { t: 400, name: "concerned", intensity: 0.7 },
    ]);
    m.walk(600, 40);
    expect(m.state()).toMatchObject({ name: "concerned", source: "text" });
  });

  it("lets a text's neutral release only what a text set", () => {
    const m = new ExpressionMixer();
    m.set("thinking", 1, {}, 0, "api");
    m.setTrack([{ t: 10, name: "neutral", intensity: 0 }]);
    m.walk(20, 20);
    expect(m.state()).toMatchObject({ name: "thinking", source: "api" });
    m.releaseText(30);
    expect(m.state().name).toBe("thinking");
    m.set("happy", 1, {}, 40, "text");
    m.releaseText(50);
    expect(m.state().name).toBe("neutral");
  });

  it("sums the jaw and the gaze of what is on", () => {
    const m = new ExpressionMixer();
    expect(m.jaw()).toBe(0);
    m.set("surprised", 0.5, { attackMs: 0 }, 0, "api");
    m.step(1, false);
    expect(m.jaw()).toBeCloseTo(0.08, 9);
    m.set("thinking", 1, { attackMs: 0 }, 2, "api");
    m.step(3, false);
    const g = m.gaze({ x: 9, y: 9 });
    expect(g.x).toBeGreaterThan(0);
    expect(g.y).toBeLessThan(0);
  });

  it("lays the idle layer under an explicit expression, in proportion", () => {
    const m = new ExpressionMixer();
    m.setIdle(true);
    expect(m.idleOn).toBe(true);
    m.step(3000, false); // picks its first smile, from nothing
    m.step(5000, false);
    const idle = m.weights.happy;
    expect(idle).toBeGreaterThan(0);
    expect(idle).toBeLessThan(0.15);
    m.set("serious", 1, { attackMs: 0 }, 5000, "api");
    m.step(5001, false);
    expect(m.weights.happy).toBeCloseTo(0, 9);
    m.setIdle(false);
    m.set("neutral", 0, { releaseMs: 0 }, 6000, "api");
    m.step(6001, false);
    expect(m.weights).toEqual(NONE);
  });
});

describe("the idle micro-expressions", () => {
  it("are seeded: the same run twice is the same", () => {
    const run = () => {
      const idle = new IdleExpressions(5);
      const out = { ...NONE };
      const seen: number[] = [];
      for (let t = 0; t < 30_000; t += 100) {
        if (t === 9000) idle.accent(t);
        idle.step(t, t > 15_000, out);
        seen.push(out.happy, out.browFlash);
      }
      return seen;
    };
    expect(run()).toEqual(run());
  });

  it("smile faintly, lower while speaking, and flash the brows on an accent at most so often", () => {
    const idle = new IdleExpressions();
    const out = { ...NONE };
    let most = 0;
    for (let t = 0; t < 60_000; t += 50) {
      idle.step(t, false, out);
      most = Math.max(most, out.happy);
    }
    expect(most).toBeGreaterThan(0.05);
    expect(most).toBeLessThanOrEqual(0.14);
    idle.step(70_000, true, out);
    idle.step(73_000, true, out);
    expect(out.happy).toBeLessThanOrEqual(0.07 + 1e-9);
    idle.accent(80_000);
    idle.step(80_200, true, out);
    expect(out.browFlash).toBeGreaterThan(0.7);
    idle.accent(80_500); // too soon: ignored
    idle.step(81_000, true, out);
    expect(out.browFlash).toBe(0);
    expect(DEFAULT_RELEASE_MS).toBeGreaterThan(0);
  });
});
