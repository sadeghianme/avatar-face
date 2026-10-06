import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AvatarEngine } from "../engine";
import { engineSeam } from "../engine/seam";
import type { Rig } from "../types";

/**
 * The scene on the engine: what is drawn behind a cut-out, in what order,
 * and that a background that never loads never holds the avatar up. A
 * recording context, as the goldens use, says what was drawn and when.
 */

const rig = JSON.parse(readFileSync(new URL("./fixtures/human-rig.json", import.meta.url), "utf8")) as Rig;
type Pixel = [number, number, number, number];
type Texture = (x: number, y: number) => Pixel;
const opaque: Texture = () => [182, 128, 110, 255];
/** A cut-out: transparent corners (the probe reads a 32x32 copy), skin inside. */
const cutOut: Texture = (x, y) => (x < 4 || y < 4 || x > 28 || y > 28 ? [0, 0, 0, 0] : [182, 128, 110, 255]);

function fakeCanvas(log: string[], texture: Texture, size = 512): HTMLCanvasElement {
  const target: Record<string, unknown> = {
    createLinearGradient: () => ({ addColorStop: () => undefined }),
    createRadialGradient: () => ({ addColorStop: () => undefined }),
    getImageData: (x: number, y: number, w: number, h: number) => {
      const data = new Uint8ClampedArray(Math.max(1, w * h) * 4);
      for (let i = 0; i < data.length; i += 4) {
        const n = i / 4;
        data.set(texture(x + (n % w), y + Math.floor(n / w)), i);
      }
      return { data, width: w, height: h };
    },
    measureText: () => ({ width: 0 }),
  };
  const ctx = new Proxy(target, {
    get(obj, key: string) {
      if (key in obj) return obj[key];
      return (...args: unknown[]) => { log.push(`${key}(${args.map((a) => (typeof a === "number" ? Math.round(a) : typeof a === "object" && a ? "obj" : String(a))).join(",")})`); };
    },
    set(obj, key: string, value: unknown) {
      obj[key] = value;
      if (typeof value === "string") log.push(`${key}=${value}`);
      return true;
    },
  });
  return { width: size, height: size, getContext: () => ctx } as unknown as HTMLCanvasElement;
}

function engineWith(texture: Texture, scene: ConstructorParameters<typeof AvatarEngine>[3]["scene"]) {
  const log: string[] = [];
  vi.stubGlobal("document", { createElement: () => fakeCanvas([], texture, 64) });
  const image = { naturalWidth: 1024, naturalHeight: 1024, width: 1024, height: 1024 } as HTMLImageElement;
  const engine = new AvatarEngine(fakeCanvas(log, texture), rig, image, { fullPhoto: false, scene });
  log.length = 0;
  return { engine, e: engineSeam(engine), log };
}

describe("the scene's background", () => {
  beforeEach(() => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    vi.spyOn(performance, "now").mockReturnValue(10_000);
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    vi.stubGlobal("Path2D", class { moveTo() {} lineTo() {} closePath() {} bezierCurveTo() {} quadraticCurveTo() {} arc() {} ellipse() {} rect() {} addPath() {} });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("is a colour filled first, under everything, behind a cut-out", () => {
    const { engine, e, log } = engineWith(cutOut, { background: { kind: "color", color: "#1e3a8a" } });
    expect(e.cutOut).toBe(true);
    e.render();
    engine.destroy();
    const clear = log.findIndex((l) => l.startsWith("clearRect("));
    const fill = log.findIndex((l) => l === "fillStyle=#1e3a8a");
    const rect = log.findIndex((l) => l === "fillRect(0,0,512,512)");
    const picture = log.findIndex((l) => l.startsWith("drawImage("));
    expect(clear).toBeGreaterThanOrEqual(0);
    expect(fill).toBeGreaterThan(clear);
    expect(rect).toBe(fill + 1);
    expect(picture).toBeGreaterThan(rect);
  });

  it("is not drawn behind an opaque picture, which would cover it anyway", () => {
    const { engine, e, log } = engineWith(opaque, { background: { kind: "color", color: "#1e3a8a" } });
    expect(e.cutOut).toBe(false);
    e.render();
    engine.destroy();
    expect(log).not.toContain("fillStyle=#1e3a8a");
  });

  it("a picture that cannot load leaves the scene transparent and the avatar drawing", () => {
    // No Image in this environment: the load fails at once.
    const { engine, e, log } = engineWith(cutOut, { background: { kind: "image", image_url: "https://example.test/bg.webp" } });
    expect(e.backdrop.image).toBeNull();
    e.render();
    engine.destroy();
    expect(log.some((l) => l.startsWith("drawImage("))).toBe(true);
    expect(log.some((l) => l.startsWith("fillRect(0,0,512,512)"))).toBe(false);
  });

  it("changes live: a new zoom moves every base point and keeps the mesh whole", () => {
    const { engine, e } = engineWith(cutOut, { zoom: 1 });
    const before = engine.landmarks().map((p) => ({ ...p }));
    const vertices = e.deformedPoints().length;
    engine.setScene({ zoom: 0, pan: { x: 0, y: 0 }, background: { kind: "color", color: "#ffffff" } });
    expect(engine.landmarks()[152].y).not.toBeCloseTo(before[152].y, 1);
    expect(e.deformedPoints().length).toBe(vertices);
    // The same scene again moves nothing.
    const after = engine.landmarks().map((p) => ({ ...p }));
    engine.setScene({ zoom: 0, pan: { x: 0, y: 0 }, background: { kind: "transparent" } });
    expect(engine.landmarks()[152]).toEqual(after[152]);
    engine.destroy();
  });

  it("the zoom option wins over the scene's, which wins over the framing", () => {
    const framed = engineWith(cutOut, undefined);
    const byScene = engineWith(cutOut, { zoom: 0 });
    const byOption = new AvatarEngine(fakeCanvas([], cutOut), rig, { naturalWidth: 1024, naturalHeight: 1024, width: 1024, height: 1024 } as HTMLImageElement, { fullPhoto: false, scene: { zoom: 0 }, zoom: 1 });
    expect(byScene.engine.landmarks()[152].y).not.toBeCloseTo(framed.engine.landmarks()[152].y, 1);
    expect(byOption.landmarks()[152].y).toBeCloseTo(framed.engine.landmarks()[152].y, 6);
    framed.engine.destroy(); byScene.engine.destroy(); byOption.destroy();
  });
});
