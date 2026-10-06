import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AvatarEngine } from "../engine";
import { engineSeam } from "../engine/seam";
import { ZERO_WEIGHTS, type Rig } from "../types";

/** The owner's character settings and the lid blink, on the engine. */

const rig = JSON.parse(readFileSync(new URL("./fixtures/fitted-animal-rig.json", import.meta.url), "utf8")) as Rig;

class NoopPath {
  moveTo() {}
  lineTo() {}
  quadraticCurveTo() {}
  bezierCurveTo() {}
  arc() {}
  ellipse() {}
  rect() {}
  closePath() {}
  addPath() {}
}

function fakeCanvas(size = 512) {
  const target: Record<string, unknown> = {
    createLinearGradient: () => ({ addColorStop: () => undefined }),
    createRadialGradient: () => ({ addColorStop: () => undefined }),
    getImageData: (_x: number, _y: number, w: number, h: number) => {
      const data = new Uint8ClampedArray(Math.max(1, w * h) * 4);
      for (let i = 0; i < data.length; i += 4) data.set([182, 128, 110, 255], i);
      return { data, width: w, height: h };
    },
    measureText: () => ({ width: 0 }),
  };
  const ctx = new Proxy(target, {
    get: (obj, key: string) => (key in obj ? obj[key] : () => undefined),
    set: (obj, key: string, value: unknown) => ((obj[key] = value), true),
  });
  return { width: size, height: size, getContext: () => ctx } as unknown as HTMLCanvasElement;
}

describe("character settings and blinks", () => {
  beforeEach(() => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    vi.spyOn(performance, "now").mockReturnValue(10_000);
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    vi.stubGlobal("Path2D", NoopPath);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const make = (profile: string | null) => {
    vi.stubGlobal("document", { createElement: () => fakeCanvas(64) });
    const image = { naturalWidth: 1024, naturalHeight: 1024, width: 1024, height: 1024 } as HTMLImageElement;
    const r = { ...rig } as Rig;
    if (profile) r.render_profile = profile;
    else delete r.render_profile;
    const engine = new AvatarEngine(fakeCanvas(), r, image, { fullPhoto: false });
    return { engine, e: engineSeam(engine) };
  };

  it("the owner's jaw setting opens the chin further, and is clamped", () => {
    const { engine, e } = make("toon@1");
    const rest = e.deformedPoints();
    e.face.weights = { ...ZERO_WEIGHTS, jawOpen: 0.8 };
    const normal = e.deformedPoints()[152].y - rest[152].y;
    expect(normal).toBeGreaterThan(20);
    engine.setCharacterTraits({ jaw: 1.5 });
    expect(e.deformedPoints()[152].y - rest[152].y).toBeCloseTo(normal * 1.5, 1);
    engine.setCharacterTraits({ jaw: 99 });
    expect(e.deformedPoints()[152].y - rest[152].y).toBeCloseTo(normal * 1.6, 1);
    engine.setCharacterTraits(null);
    expect(e.deformedPoints()[152].y - rest[152].y).toBeCloseTo(normal, 1);
  });

  it("a classic mouth ignores the owner's character settings", () => {
    const { engine, e } = make(null);
    e.face.weights = { ...ZERO_WEIGHTS, jawOpen: 0.8 };
    const before = e.deformedPoints()[152].y;
    engine.setCharacterTraits({ jaw: 1.6 });
    expect(e.deformedPoints()[152].y).toBe(before);
  });

  it("opens the muzzle further than the classic mouth did, chin included", () => {
    const classic = make("animal@1");
    const character = make("animal@2");
    for (const m of [classic, character]) m.e.face.weights = { ...ZERO_WEIGHTS, jawOpen: 0.9 };
    const drop = (m: ReturnType<typeof make>, rest: { y: number }[]) => m.e.deformedPoints()[152].y - rest[152].y;
    const restC = make("animal@1").e.deformedPoints();
    expect(drop(character, restC)).toBeGreaterThan(drop(classic, restC) + 10);
  });

  it("the lid blink leaves the mesh still; the mesh blink moves it", () => {
    const lid = make("toon@1");
    const restLid = lid.e.deformedPoints()[159].y;
    lid.e.face.blink = 0.35;
    expect(lid.e.deformedPoints()[159].y).toBe(restLid);
    const mesh = make("animal@1");
    const restMesh = mesh.e.deformedPoints()[159].y;
    mesh.e.face.blink = 0.35;
    expect(mesh.e.deformedPoints()[159].y).toBeGreaterThan(restMesh);
  });
});
