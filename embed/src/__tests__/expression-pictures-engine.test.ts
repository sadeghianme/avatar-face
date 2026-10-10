import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AvatarEngine } from "../engine";
import { engineSeam } from "../engine/seam";
import type { Rig } from "../types";
import { fakeCanvas, NoopPath, stubNetwork } from "./browser-fakes";

/**
 * The AI expression pictures in a live engine: loaded on the side (the
 * animated expressions play meanwhile), shown for the expressions they
 * cover once in, taken off again, and never a reason for the engine to
 * fail (a manifest that cannot be had leaves the animated ones).
 */
const rig = JSON.parse(readFileSync(new URL("./fixtures/human-rig.json", import.meta.url), "utf8")) as Rig;
const [W, H] = rig.image_size;
const FRAME = 1000 / 60;
const pairs = rig.points.map(([x, y]) => [x, y]);
const face = Math.hypot(rig.points[454][0] - rig.points[234][0], rig.points[454][1] - rig.points[234][1]);
const BROWS = [70, 63, 105, 66, 107, 336, 296, 334, 293, 300];
const manifest = {
  version: 1,
  kind: "liveface-expressions",
  kit: "k",
  image_size: [W, H],
  base: pairs,
  expressions: {
    surprised: {
      size: [W, H],
      uv: pairs,
      targets: pairs.map(([x, y], i) => [x, BROWS.includes(i) ? y - face * 0.05 : y]),
      smile: false,
    },
  },
};
const SOURCE = { manifestUrl: "/expr.json", imageUrls: { surprised: "/surprised.webp" } };

describe("AI expression pictures in the engine", () => {
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

  const engineFor = () => {
    const image = { naturalWidth: W, naturalHeight: H, width: W, height: H } as HTMLImageElement;
    const engine = new AvatarEngine(fakeCanvas(), structuredClone(rig), image, { fullPhoto: true, headMotion: "2d" });
    engine.tuning.headMotion = 0;
    engine.tuning.bodyMotion = 0;
    engine.tuning.blink = 0;
    return { engine, e: engineSeam(engine) };
  };
  const settle = (e: ReturnType<typeof engineSeam>, ms: number) => {
    for (let t = 0; t < ms; t += FRAME) {
      now += FRAME;
      e.tick(now);
    }
  };

  it("shows the picture's brows once in, and the animated ones again once taken off", async () => {
    stubNetwork({ "/expr.json": { json: manifest }, "/surprised.webp": { image: [200, 150, 120, 255] } });
    const { engine, e } = engineFor();
    engine.setExpression("surprised", 1, { attackMs: 0 });
    settle(e, 400);
    const animated = e.deformedPoints()[105].y;
    await engine.setExpressionPictures(SOURCE);
    expect(engine.expressionPictures()).toEqual(["surprised"]);
    settle(e, 400);
    const pictured = e.deformedPoints()[105].y;
    expect(Math.abs(pictured - animated)).toBeGreaterThan(0.5);
    // A frame is drawn through the picture, on the 2D path here.
    expect(() => e.render()).not.toThrow();
    await engine.setExpressionPictures(null);
    expect(engine.expressionPictures()).toEqual([]);
    expect(e.deformedPoints()[105].y).toBeCloseTo(animated, 6);
    engine.destroy();
  });

  it("keeps the animated expressions when the pictures cannot be had", async () => {
    stubNetwork({});
    const { engine } = engineFor();
    await engine.setExpressionPictures(SOURCE);
    expect(engine.expressionPictures()).toEqual([]);
    stubNetwork({ "/expr.json": { json: manifest } });
    await engine.setExpressionPictures(SOURCE);
    expect(engine.expressionPictures()).toEqual([]);
    engine.destroy();
    await engine.setExpressionPictures(SOURCE);
    expect(engine.expressionPictures()).toEqual([]);
  });

  it("lets a later set win over one still loading", async () => {
    stubNetwork({ "/expr.json": { json: manifest }, "/surprised.webp": { image: [200, 150, 120, 255] } });
    const { engine } = engineFor();
    const first = engine.setExpressionPictures(SOURCE);
    await engine.setExpressionPictures(null);
    await first;
    expect(engine.expressionPictures()).toEqual([]);
    engine.destroy();
  });
});
