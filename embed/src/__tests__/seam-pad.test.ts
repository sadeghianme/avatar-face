import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AvatarEngine } from "../engine";
import { engineSeam } from "../engine/seam";
import { MITRE_LIMIT, padTriangle } from "../seam-pad";
import type { Pt } from "../jaw-rig";
import type { Rig } from "../types";

/**
 * Seam padding: how a warped triangle grows to overlap its neighbours, and
 * which triangles grow for which picture.
 */

/** Signed distance of `p` from the line through a and b, positive on the
 *  side away from `inside`. */
function edgeDistance(a: Pt, b: Pt, p: Pt, inside: Pt): number {
  let nx = -(b.y - a.y), ny = b.x - a.x;
  const len = Math.hypot(nx, ny);
  nx /= len; ny /= len;
  if (nx * (inside.x - a.x) + ny * (inside.y - a.y) > 0) { nx = -nx; ny = -ny; }
  return nx * (p.x - a.x) + ny * (p.y - a.y);
}

describe("padTriangle", () => {
  it("offsets every edge outward by a whole pad on a plump triangle", () => {
    const plump: [Pt, Pt, Pt] = [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 20, y: 35 }];
    const c = { x: 20, y: 35 / 3 };
    const grown = padTriangle(plump[0], plump[1], plump[2], 1, 0);
    for (let k = 0; k < 3; k++) {
      const a = plump[k], b = plump[(k + 1) % 3];
      // Both grown corners of this edge sit a pad outside it.
      expect(edgeDistance(a, b, grown[k], c)).toBeCloseTo(1, 9);
      expect(edgeDistance(a, b, grown[(k + 1) % 3], c)).toBeCloseTo(1, 9);
    }
  });

  it("keeps a thin triangle's long edges covered, where the centroid growth it replaces left them bare", () => {
    // The stretched triangle under a moving chin: long and thin, corners
    // of about 17 degrees.
    const thin: [Pt, Pt, Pt] = [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 20, y: 12 }];
    const c = { x: 20, y: 4 };
    const centroidGrown = thin.map((p) => {
      const d = Math.hypot(p.x - c.x, p.y - c.y);
      return { x: p.x + ((p.x - c.x) / d), y: p.y + ((p.y - c.y) / d) };
    });
    // The long edge (0 -> 40) moved a fifth of a pixel at its ends that way...
    expect(edgeDistance(thin[0], thin[1], centroidGrown[0], c)).toBeLessThan(0.25);
    // ...and at least twice that now, the mitre cut short only at the
    // sharp corners; the obtuse corner's edges get the whole pad.
    const grown = padTriangle(thin[0], thin[1], thin[2], 1, 0);
    expect(edgeDistance(thin[0], thin[1], grown[0], c)).toBeGreaterThan(0.4);
    expect(edgeDistance(thin[0], thin[1], grown[1], c)).toBeGreaterThan(0.4);
    expect(edgeDistance(thin[1], thin[2], grown[2], c)).toBeCloseTo(1, 9);
    expect(edgeDistance(thin[2], thin[0], grown[2], c)).toBeCloseTo(1, 9);
  });

  it("cuts a sharp corner's mitre short instead of growing a spike", () => {
    const needle: [Pt, Pt, Pt] = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 0.5 }];
    const grown = padTriangle(needle[0], needle[1], needle[2], 1, 0);
    expect(Math.hypot(grown[0].x - needle[0].x, grown[0].y - needle[0].y)).toBeLessThanOrEqual(MITRE_LIMIT + 1e-9);
  });

  it("with no pad, grows only in proportion, as every triangle always did", () => {
    const tri: [Pt, Pt, Pt] = [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 20, y: 35 }];
    const grown = padTriangle(tri[0], tri[1], tri[2], 0);
    const c = { x: 20, y: 35 / 3 };
    grown.forEach((g, k) => {
      expect(g.x).toBeCloseTo(tri[k].x + (tri[k].x - c.x) * 0.015, 9);
      expect(g.y).toBeCloseTo(tri[k].y + (tri[k].y - c.y) * 0.015, 9);
    });
  });
});

// --- Which triangles pad, for which picture -------------------------------------

const rig = JSON.parse(readFileSync(new URL("./fixtures/human-rig.json", import.meta.url), "utf8")) as Rig;
type Texture = (x: number, y: number) => [number, number, number, number];
const flatSkin: Texture = () => [182, 128, 110, 255];
const positional: Texture = (x, y) => [(x * 3 + y) % 256, (x + y * 5) % 256, (x * 7 + y * 11) % 256, 255];

function fakeCanvas(texture: Texture, size = 512): HTMLCanvasElement {
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
    get(obj, key: string) { return key in obj ? obj[key] : () => undefined; },
    set(obj, key: string, value: unknown) { obj[key] = value; return true; },
  });
  return { width: size, height: size, getContext: () => ctx } as unknown as HTMLCanvasElement;
}

function padsFor(texture: Texture, profile?: string): { tris: [number, number, number][]; pads: Float32Array; flat: boolean } {
  vi.stubGlobal("document", { createElement: () => fakeCanvas(texture, 64) });
  const image = { naturalWidth: 1024, naturalHeight: 1024, width: 1024, height: 1024 } as HTMLImageElement;
  const source = { ...rig } as Rig;
  if (profile) source.render_profile = profile;
  const engine = new AvatarEngine(fakeCanvas(texture), source, image, { fullPhoto: false });
  const e = engineSeam(engine);
  const pads = e.meshWarp.trianglePads()!;
  engine.destroy();
  return { tris: e.mesh.triangles, pads, flat: e.samples.look.flat };
}

const EYE = 159, BROW = 65, CHIN = 152, LIP = 14;
const padOfTrianglesWith = (tris: [number, number, number][], pads: Float32Array, index: number) =>
  tris.map((t, k) => (t.includes(index) ? pads[k] : null)).filter((p): p is number => p !== null);

describe("seam pads per picture", () => {
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

  it("a flat picture pads every triangle, whichever mouth it has", () => {
    const { tris, pads, flat } = padsFor(flatSkin);
    expect(flat).toBe(true);
    expect(pads).toHaveLength(tris.length);
    for (const p of pads) expect(p).toBeGreaterThanOrEqual(0.44); // float32: 0.45 reads back a hair under
    for (const p of padOfTrianglesWith(tris, pads, EYE)) expect(p).toBe(1);
    for (const p of padOfTrianglesWith(tris, pads, LIP)) expect(p).toBeCloseTo(0.45, 5);
  });

  it("a photograph pads the jaw, the chin, the cheeks and the neck band, and never the eyes or brows", () => {
    const { tris, pads, flat } = padsFor(positional);
    expect(flat).toBe(false);
    for (const p of padOfTrianglesWith(tris, pads, CHIN)) expect(p).toBe(1);
    for (const p of padOfTrianglesWith(tris, pads, EYE)) expect(p).toBe(0);
    for (const p of padOfTrianglesWith(tris, pads, BROW)) expect(p).toBe(0);
    for (const p of padOfTrianglesWith(tris, pads, LIP)) expect(p).toBeCloseTo(0.45, 5);
    // The neck band's triangles (the last 80) move with the jaw: padded.
    for (let k = tris.length - 80; k < tris.length; k++) expect(pads[k]).toBe(1);
  });

  it("a character profile pads everything on a render too, as it always did", () => {
    const { tris, pads } = padsFor(positional, "toon@1");
    for (const p of padOfTrianglesWith(tris, pads, EYE)) expect(p).toBe(1);
    for (const p of padOfTrianglesWith(tris, pads, LIP)) expect(p).toBeCloseTo(0.45, 5);
  });
});
