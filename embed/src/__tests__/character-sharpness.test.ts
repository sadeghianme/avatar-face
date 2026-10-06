import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_LOOK } from "../character-mouth";
import { AvatarEngine } from "../engine";
import { engineSeam, type EngineSeam } from "../engine/seam";
import type { Rig } from "../types";

/**
 * The character mouth's softness on the engine: `look.soft` is the
 * picture's sharpness (face-sharpness.ts) over the mouth's width, read
 * before the look is built, in the constructor and again when the texture
 * is upgraded from its thumbnail (setTexture); the lip seam only when the
 * picture has no sharpness.
 */

const rig = JSON.parse(
  readFileSync(new URL("./fixtures/fitted-animal-rig.json", import.meta.url), "utf8")
) as Rig;

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

type Texture = (x: number, y: number) => [number, number, number, number];

function fakeCanvas(texture: Texture, size = 512) {
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
    get: (obj, key: string) => (key in obj ? obj[key] : () => undefined),
    set: (obj, key: string, value: unknown) => ((obj[key] = value), true),
  });
  return { width: size, height: size, getContext: () => ctx } as unknown as HTMLCanvasElement;
}

const grey = (v: number): [number, number, number, number] => [v, v, v, 255];
/** Vertical stripes, 60 and 200 luma, 256 px apart (so the edges are a
 *  few percent of the pixels, as a picture's are), each edge a ramp `ramp`
 *  px wide (0: a hard step). The 10-90% rise of a hard step reads 0.8 px,
 *  of a ramp 0.8 of its width. */
const stripes = (ramp: number): Texture => (x) => {
  const phase = ((x % 256) + 256) % 256;
  const d = Math.min(phase, 256 - phase) - 64; // distance into the bright half, signed
  const t = ramp > 0 ? Math.max(0, Math.min(1, d / ramp + 0.5)) : d >= 0 ? 1 : 0;
  return grey(60 + 140 * t);
};
const flat: Texture = () => grey(140);

describe("the look's softness on the engine", () => {
  let texture: Texture = flat;
  beforeEach(() => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    vi.spyOn(performance, "now").mockReturnValue(10_000);
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    vi.stubGlobal("Path2D", NoopPath);
    // Every canvas the engine makes reads the current texture.
    vi.stubGlobal("document", { createElement: () => fakeCanvas((x, y) => texture(x, y), 64) });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const image = (size: number) => ({ naturalWidth: size, naturalHeight: size, width: size, height: size }) as HTMLImageElement;
  const mouthWidth = (e: EngineSeam) => Math.hypot(e.mesh.texPoints[291].x - e.mesh.texPoints[61].x, e.mesh.texPoints[291].y - e.mesh.texPoints[61].y);

  it("is the picture's sharpness over the mouth's width, and is rebuilt from the upgraded texture", () => {
    texture = stripes(0);
    const engine = new AvatarEngine(fakeCanvas(texture), { ...rig, render_profile: "toon@1" }, image(1024), { fullPhoto: false });
    const e = engineSeam(engine);
    const sharp = e.samples.faceSharpness;
    expect(sharp).not.toBeNull();
    expect(sharp!).toBeLessThan(1.3);
    // (Two-tone stripes are cel art to the palette; the softness is read
    // the same way whichever the picture is.)
    expect(e.samples.look.soft).toBeCloseTo(sharp! / mouthWidth(e), 9);
    const crisp = e.samples.look.soft;

    // The full-resolution picture lands, softer: the look follows it.
    texture = stripes(6);
    engine.setTexture(image(1024));
    expect(e.samples.faceSharpness).not.toBeNull();
    expect(e.samples.faceSharpness!).toBeGreaterThan(3.5);
    expect(e.samples.look.soft).toBeCloseTo(e.samples.faceSharpness! / mouthWidth(e), 9);
    expect(e.samples.look.soft).toBeGreaterThan(crisp * 3);

    // A flat picture has no sharpness and no seam: the default, nothing stale.
    texture = flat;
    engine.setTexture(image(1024));
    expect(e.samples.faceSharpness).toBeNull();
    expect(e.samples.look.soft).toBe(DEFAULT_LOOK.soft);
    engine.destroy();
  });

  it("reads the seam only for a picture with no sharpness", () => {
    // A 30-level step across the seam: an edge to the seam's measure
    // (contrast 25 and over), none to the sharpness (50 and over).
    const seamY = (rig.points[13][1] * 1024) / rig.image_size[1];
    texture = (_x, y) => grey(y < seamY ? 170 : 140);
    const engine = new AvatarEngine(fakeCanvas(texture), { ...rig, render_profile: "toon@1" }, image(1024), { fullPhoto: false });
    const e = engineSeam(engine);
    expect(e.samples.faceSharpness).toBeNull();
    // A hard 30-level step: contrast over its steepest step is 1 px.
    expect(e.samples.look.soft).toBeCloseTo(1 / mouthWidth(e), 9);
    engine.destroy();
  });
});
