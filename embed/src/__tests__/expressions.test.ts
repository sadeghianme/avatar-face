import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AvatarEngine } from "../engine";
import { engineSeam } from "../engine/seam";
import type { ExpressionName } from "../engine/expression-table";
import { INNER_LOWER, INNER_UPPER } from "../engine/jaw-rig";
import type { MouthPose } from "../mouth-extension";
import type { Cue, Rig } from "../types";
import { FakeAudio, fakeCanvas, NoopPath } from "./browser-fakes";

/**
 * Expressions in a live engine (docs/emotions.md): layered on the speech,
 * which keeps the lips, under every mouth (the classic field, a
 * character's, an animal's); driven by the API and by a text's track; the
 * jaw only while silent; nothing moved, and no random number drawn, when
 * none is on.
 */
const load = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as Rig;
const human = load("human-rig.json");
const SUBJECTS: Record<string, Rig> = {
  "a photo (classic mouth)": human,
  "a toon (character mouth)": { ...structuredClone(human), render_profile: "toon@1" },
  "an animal (animal@2)": { ...load("fitted-animal-rig.json"), render_profile: "animal@2" },
};
const FRAME = 1000 / 60;

describe("expressions in the engine", () => {
  let now = 10_000;
  beforeEach(() => {
    now = 10_000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.spyOn(Math, "random").mockReturnValue(0.3);
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    vi.stubGlobal("Path2D", NoopPath);
    vi.stubGlobal("document", { createElement: () => fakeCanvas() });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const engineFor = (rig: Rig, pose: { current: MouthPose | null } = { current: null }) => {
    const [w, h] = rig.image_size;
    const image = { naturalWidth: w, naturalHeight: h, width: w, height: h } as HTMLImageElement;
    const engine = new AvatarEngine(fakeCanvas(), structuredClone(rig), image, {
      fullPhoto: true,
      headMotion: "2d",
      pose: () => pose.current,
    });
    engine.tuning.headMotion = 0;
    engine.tuning.bodyMotion = 0;
    engine.tuning.blink = 0;
    return { engine, e: engineSeam(engine) };
  };
  const settle = (e: ReturnType<typeof engineSeam>, ms = 800) => {
    for (let t = 0; t < ms; t += FRAME) {
      now += FRAME;
      e.tick(now);
    }
  };
  const gaps = (pts: { x: number; y: number }[]) =>
    INNER_UPPER.map((u, k) => Math.hypot(pts[u].x - pts[INNER_LOWER[k]].x, pts[u].y - pts[INNER_LOWER[k]].y));

  describe.each(Object.entries(SUBJECTS))("on %s", (_, rig) => {
    it.each(["aa", "E", "ou"])("keeps the lips' opening of a held %s under every expression", (viseme) => {
      const pose = { current: { viseme, weights: { ...human.visemes[viseme] } } as MouthPose };
      const { engine, e } = engineFor(rig, pose);
      settle(e);
      const plain = gaps(e.deformedPoints());
      for (const name of ["happy", "surprised", "concerned", "thinking", "serious"] as ExpressionName[]) {
        engine.setExpression(name, 1, { attackMs: 0 });
        settle(e, 100);
        const pts = e.deformedPoints();
        const g = gaps(pts);
        // (The held shape's own filter is still settling by a millionth.)
        g.forEach((v, k) =>
          expect(Math.abs(v - plain[k]), `${name} column ${k}`).toBeLessThan(1e-4 * Math.max(1, plain[k]))
        );
        // ...and it did move the face.
        const moved = Math.hypot(pts[105].x - e.mesh.basePoints[105].x, pts[105].y - e.mesh.basePoints[105].y);
        if (name !== "happy") expect(moved, name).toBeGreaterThan(0.05);
      }
    });
  });

  it("draws nothing different until an expression is on, and nothing at tuning 0", () => {
    const { engine, e } = engineFor(human);
    settle(e);
    const before = e.deformedPoints().map((p) => ({ ...p }));
    expect(engine.expression).toMatchObject({ name: "neutral", level: 0, source: null });
    engine.setExpression("happy", 1, { attackMs: 0 });
    engine.tuning.expression = 0;
    settle(e, 50);
    expect(e.deformedPoints()).toEqual(before);
    engine.tuning.expression = 1;
    expect(e.deformedPoints()).not.toEqual(before);
    expect(engine.expression).toMatchObject({ name: "happy", intensity: 1, level: 1, source: "api" });
  });

  it("drops the jaw for a surprise only while nothing is said", () => {
    const { engine, e } = engineFor(human);
    engine.setExpression("surprised", 1, { attackMs: 0 });
    settle(e, 300);
    expect(e.face.targetWeights.jawOpen).toBeCloseTo(0.16, 6);
    engine.playCues([
      { t: 0, viseme: "sil" },
      { t: 2000, viseme: "sil" },
    ]);
    settle(e, 200);
    expect(e.face.targetWeights.jawOpen).toBe(0);
  });

  it("follows a text's track on the speech's clock, and a stop releases it", () => {
    const { engine, e } = engineFor(human);
    settle(e);
    const cues: Cue[] = [
      { t: 0, viseme: "sil" },
      { t: 100, viseme: "aa" },
      { t: 1500, viseme: "sil" },
    ];
    engine.playCues(cues, [
      { t: 200, name: "happy", intensity: 0.8 },
      { t: 700, name: "concerned", intensity: 1 },
    ]);
    settle(e, 400);
    expect(engine.expression).toMatchObject({ name: "happy", intensity: 0.8, source: "text" });
    settle(e, 500);
    expect(engine.expression.name).toBe("concerned");
    engine.stopSpeech();
    expect(engine.expression.name).toBe("neutral");
    // A page's expression outlives a text's end.
    engine.setExpression("thinking");
    engine.playCues(cues, [{ t: 100, name: "neutral", intensity: 0 }]);
    settle(e, 400);
    expect(engine.expression).toMatchObject({ name: "thinking", source: "api" });
    expect(e.motion.gazeBias.x).toBeGreaterThan(0);
  });

  it("sets what a text's track left behind when its voice ends, and re-places it on a re-sync", () => {
    vi.stubGlobal("Audio", FakeAudio);
    const { engine, e } = engineFor(human);
    const cues: Cue[] = [
      { t: 0, viseme: "aa" },
      { t: 300, viseme: "sil" },
    ];
    engine.playAudio("AAAA", "audio/wav", cues, undefined, [
      { t: 100, name: "happy", intensity: 1 },
      { t: 5000, name: "neutral", intensity: 0 },
    ]);
    const audio = FakeAudio.last!;
    audio.fire("playing");
    audio.currentTime = 0.2;
    settle(e, 100);
    expect(engine.expression.name).toBe("happy");
    engine.syncCueTime(0);
    settle(e, 50);
    expect(engine.expression.name).toBe("happy");
    audio.fire("ended");
    expect(engine.expression.name).toBe("neutral");
  });

  it("draws no random number for the idle micro-expressions", () => {
    const random = vi.mocked(Math.random);
    const count = (idle: boolean) => {
      const { engine, e } = engineFor(human);
      engine.setIdleExpressions(idle);
      random.mockClear();
      settle(e, 20_000);
      return { calls: random.mock.calls.length, happy: engine.expression.weights.happy };
    };
    const off = count(false);
    const on = count(true);
    expect(on.calls).toBe(off.calls);
    expect(off.happy).toBe(0);
    expect(on.happy).toBeGreaterThan(0.03);
  });
});
