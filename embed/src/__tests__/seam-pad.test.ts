import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AvatarEngine } from "../engine";
import { engineSeam } from "../engine/seam";
import { MITRE_LIMIT, padTriangle } from "../engine/seam-pad";
import type { Pt } from "../engine/jaw-rig";
import type { Rig } from "../types";

/**
 * Seam padding: how a warped triangle grows to overlap its neighbours, and
 * which triangles grow for which picture.
 */

/** Signed distance of `p` from the line through a and b, positive on the
 *  side away from `inside`. */
function edgeDistance(a: Pt, b: Pt, p: Pt, inside: Pt): number {
  let nx = -(b.y - a.y),
    ny = b.x - a.x;
  const len = Math.hypot(nx, ny);
  nx /= len;
  ny /= len;
  if (nx * (inside.x - a.x) + ny * (inside.y - a.y) > 0) {
    nx = -nx;
    ny = -ny;
  }
  return nx * (p.x - a.x) + ny * (p.y - a.y);
}

describe("padTriangle", () => {
  it("offsets every edge outward by a whole pad on a plump triangle", () => {
    const plump: [Pt, Pt, Pt] = [
      { x: 0, y: 0 },
      { x: 40, y: 0 },
      { x: 20, y: 35 },
    ];
    const c = { x: 20, y: 35 / 3 };
    const grown = padTriangle(plump[0], plump[1], plump[2], 1, 0);
    for (let k = 0; k < 3; k++) {
      const a = plump[k],
        b = plump[(k + 1) % 3];
      // Both grown corners of this edge sit a pad outside it.
      expect(edgeDistance(a, b, grown[k], c)).toBeCloseTo(1, 9);
      expect(edgeDistance(a, b, grown[(k + 1) % 3], c)).toBeCloseTo(1, 9);
    }
  });

  it("keeps a thin triangle's long edges covered, where the centroid growth it replaces left them bare", () => {
    // The stretched triangle under a moving chin: long and thin, corners
    // of about 17 degrees.
    const thin: [Pt, Pt, Pt] = [
      { x: 0, y: 0 },
      { x: 40, y: 0 },
      { x: 20, y: 12 },
    ];
    const c = { x: 20, y: 4 };
    const centroidGrown = thin.map((p) => {
      const d = Math.hypot(p.x - c.x, p.y - c.y);
      return { x: p.x + (p.x - c.x) / d, y: p.y + (p.y - c.y) / d };
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

  it("pads each edge by its own amount when asked: an outline's edge not at all", () => {
    const plump: [Pt, Pt, Pt] = [
      { x: 0, y: 0 },
      { x: 40, y: 0 },
      { x: 20, y: 35 },
    ];
    const c = { x: 20, y: 35 / 3 };
    const pads: [number, number, number] = [0, 1, 0.5];
    const grown = padTriangle(plump[0], plump[1], plump[2], 0, 0, pads);
    for (let k = 0; k < 3; k++) {
      const a = plump[k],
        b = plump[(k + 1) % 3];
      expect(edgeDistance(a, b, grown[k], c)).toBeCloseTo(pads[k], 9);
      expect(edgeDistance(a, b, grown[(k + 1) % 3], c)).toBeCloseTo(pads[k], 9);
    }
    // All edges alike, it is the uniform pad.
    const even = padTriangle(plump[0], plump[1], plump[2], 0, 0, [1, 1, 1]);
    const uniform = padTriangle(plump[0], plump[1], plump[2], 1, 0);
    even.forEach((p, k) => {
      expect(p.x).toBeCloseTo(uniform[k].x, 9);
      expect(p.y).toBeCloseTo(uniform[k].y, 9);
    });
  });

  it("cuts a sharp corner's mitre short instead of growing a spike", () => {
    const needle: [Pt, Pt, Pt] = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 0.5 },
    ];
    const grown = padTriangle(needle[0], needle[1], needle[2], 1, 0);
    expect(Math.hypot(grown[0].x - needle[0].x, grown[0].y - needle[0].y)).toBeLessThanOrEqual(MITRE_LIMIT + 1e-9);
  });

  it("measures only a mitre near its limit, and pads to the bit as measuring every mitre does", () => {
    // The padding as it was, every corner's mitre put to Math.hypot; and
    // how many mitres were cut, and how many came within a hair of it.
    let cut = 0,
      near = 0;
    const measured = (d: Pt[], pad: number, edges?: readonly [number, number, number]): Pt[] => {
      const cx = (d[0].x + d[1].x + d[2].x) / 3,
        cy = (d[0].y + d[1].y + d[2].y) / 3;
      const n = [0, 1, 2].map((k) => {
        const a = d[k],
          b = d[(k + 1) % 3];
        let nx = -(b.y - a.y),
          ny = b.x - a.x;
        const len = Math.hypot(nx, ny) || 1;
        nx /= len;
        ny /= len;
        if (nx * ((a.x + b.x) / 2 - cx) + ny * ((a.y + b.y) / 2 - cy) < 0) [nx, ny] = [-nx, -ny];
        return [nx, ny];
      });
      return d.map((p, k) => {
        const gx = p.x + (p.x - cx) * 0.015,
          gy = p.y + (p.y - cy) * 0.015;
        const j = (k + 2) % 3;
        const [ax, ay] = n[k],
          [bx, by] = n[j];
        let mx: number, my: number, most: number;
        if (edges) {
          const pa = edges[k],
            pb = edges[j];
          const det = ax * by - ay * bx;
          [mx, my] =
            Math.abs(det) < 1e-3
              ? [((ax + bx) / 2) * Math.max(pa, pb), ((ay + by) / 2) * Math.max(pa, pb)]
              : [(pa * by - ay * pb) / det, (ax * pb - pa * bx) / det];
          most = MITRE_LIMIT * Math.max(pa, pb);
        } else {
          const denom = Math.max(1e-3, 1 + ax * bx + ay * by);
          [mx, my] = [(ax + bx) / denom, (ay + by) / denom];
          most = MITRE_LIMIT;
        }
        const len = Math.hypot(mx, my);
        if (len > most) {
          cut++;
          mx *= most / len;
          my *= most / len;
        } else if (len * len > most * most * (1 - 1e-6)) near++;
        if (!edges) [mx, my] = [mx * pad, my * pad];
        return { x: gx + mx, y: gy + my };
      });
    };
    let seed = 11;
    const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    // Triangles with a corner at the angle whose mitre is the limit (and a
    // hair either side), at every size, turned and moved; and any triangle;
    // and none at all.
    const atLimit = 2 * Math.asin(1 / MITRE_LIMIT);
    const cases: Pt[][] = [
      [
        { x: 5, y: 5 },
        { x: 5, y: 5 },
        { x: 5, y: 5 },
      ],
      [
        { x: NaN, y: 0 },
        { x: 1, y: 0 },
        { x: 0, y: 1 },
      ],
    ];
    for (let i = 0; i < 3000; i++) {
      const angle = i % 3 ? atLimit * (1 + (rand() - 0.5) * 10 ** -(3 + (i % 13))) : rand() * Math.PI,
        size = 10 ** (rand() * 5 - 2),
        side = size * (0.5 + rand()),
        turn = rand() * 2 * Math.PI,
        x = rand() * 960,
        y = rand() * 960;
      const corner = [
        [0, 0],
        [size, 0],
        [side * Math.cos(angle), side * Math.sin(angle)],
      ];
      cases.push(
        corner.map(([u, v]) => ({
          x: x + u * Math.cos(turn) - v * Math.sin(turn),
          y: y + u * Math.sin(turn) + v * Math.cos(turn),
        }))
      );
    }
    const differ: string[] = [];
    const out: [Pt, Pt, Pt] = [
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 0, y: 0 },
    ];
    for (const d of cases) {
      for (const [pad, edges] of [
        [1, undefined],
        [0.45, undefined],
        [0, [1, 0.45, 0]],
        [0, [1, 1, 1]],
      ] as [number, [number, number, number] | undefined][]) {
        const want = measured(d, pad, edges);
        const got = padTriangle(d[0], d[1], d[2], pad, 0.015, edges, out);
        for (let k = 0; k < 3; k++)
          if (!Object.is(got[k].x, want[k].x) || !Object.is(got[k].y, want[k].y))
            differ.push(`${JSON.stringify(d)} ${pad} ${edges}: ${k}`);
      }
    }
    expect(differ).toEqual([]);
    // Both sides of the limit were met, close.
    expect(cut).toBeGreaterThan(1000);
    expect(near).toBeGreaterThan(100);
  });

  it("with no pad, grows only in proportion, as every triangle always did", () => {
    const tri: [Pt, Pt, Pt] = [
      { x: 0, y: 0 },
      { x: 40, y: 0 },
      { x: 20, y: 35 },
    ];
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
    get(obj, key: string) {
      return key in obj ? obj[key] : () => undefined;
    },
    set(obj, key: string, value: unknown) {
      obj[key] = value;
      return true;
    },
  });
  return { width: size, height: size, getContext: () => ctx } as unknown as HTMLCanvasElement;
}

function padsFor(
  texture: Texture,
  profile?: string
): { tris: [number, number, number][]; pads: Float32Array; flat: boolean } {
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

const EYE = 159,
  BROW = 65,
  CHIN = 152,
  LIP = 14;
const padOfTrianglesWith = (tris: [number, number, number][], pads: Float32Array, index: number) =>
  tris.map((t, k) => (t.includes(index) ? pads[k] : null)).filter((p): p is number => p !== null);

describe("seam pads per picture", () => {
  beforeEach(() => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    vi.spyOn(performance, "now").mockReturnValue(10_000);
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    vi.stubGlobal(
      "Path2D",
      class {
        moveTo() {}
        lineTo() {}
        closePath() {}
        bezierCurveTo() {}
        quadraticCurveTo() {}
        arc() {}
        ellipse() {}
        rect() {}
        addPath() {}
      }
    );
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
