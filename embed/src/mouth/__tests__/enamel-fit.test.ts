import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { DentalOralSurface } from "../dental-oral-surface";
import { ContinuousMouth, SEAM_STROKES } from "../continuous-mouth";
import { DEFAULT_REFERENCE_PROFILE, REFERENCE_POSES } from "../reference-mouth-model";
import { validatePerformanceManifest } from "../photographic-performance-model";
import { ZERO_WEIGHTS, type Rig } from "../../types";
import type { MouthSurfaceFrame } from "../../mouth-extension";
import { fakeCanvas } from "../../__tests__/browser-fakes";

/**
 * The teeth photo fitted to the face it is drawn into, and revealed as the
 * lips part: what the surface and the mouth do with enamel-match-model and
 * lip-occlusion-model. Draw-only fixtures; extraction has its own tests.
 */

class TestPath { moveTo() {} lineTo() {} closePath() {} }

/** A surface as extracted: two arches, an enamel sample like the standard teeth's. */
function surface(origin: "own" | "standard" = "standard") {
  const s = Object.create(DentalOralSurface.prototype) as DentalOralSurface;
  Object.assign(s, { lowerIncisal: 0, origin, fitted: null, enamel: { cast: [1.093, 0.984, 0.922], bright: 227, edge: 4 },
    arches: [0, 1].map((i) => ({ canvas: { id: `raw${i}` }, layer: { count: 1000, box: { x: 100, y: 120, width: 400, height: 80 } } })) });
  s.setProfile(DEFAULT_REFERENCE_PROFILE);
  return s;
}

/** A context that records the images drawn and the alpha they were drawn at. */
function context() {
  const drawn: { image: unknown; alpha: number }[] = [];
  const stack: number[] = [];
  const gradient = { addColorStop() {} };
  const ctx = {
    globalAlpha: 1, filter: "none",
    save() { stack.push(this.globalAlpha); }, restore() { this.globalAlpha = stack.pop()!; },
    translate() {}, rotate() {}, scale() {}, createRadialGradient: () => gradient, createLinearGradient: () => gradient,
    fillRect() {}, drawImage(image: unknown) { drawn.push({ image, alpha: this.globalAlpha }); }, clip() {},
    rect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, drawn };
}

const points = Array.from({ length: 478 }, () => ({ x: 50, y: 25 }));
const ring = [{ x: 0, y: 0 }, { x: 50, y: 30 }, { x: 100, y: 0 }, { x: 50, y: -10 }];
ring.forEach((p, i) => { points[i] = p; });
const warmFace = { lipColour: [175, 79, 66], skinColour: [247, 166, 105], faceHighlight: 207, sharpness: 2.7, pixelScale: 1 };
const frame = (face: Partial<MouthSurfaceFrame> = warmFace) => ({
  points, neutral: points, rig: { inner_lip_ring: [0, 1, 2, 3, ...Array(17).fill(3)] }, weights: { ...ZERO_WEIGHTS }, viseme: "aa", ...face,
} as unknown as MouthSurfaceFrame);

describe("the teeth photo on a face", () => {
  let created = 0;
  beforeEach(() => {
    created = 0;
    vi.stubGlobal("Path2D", TestPath);
    vi.stubGlobal("document", { createElement: () => { created++; return fakeCanvas(); } });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("is fitted once, on the first frame the face is known, and reused after", () => {
    const s = surface();
    const { ctx, drawn } = context();
    expect(s.match).toBeNull();
    s.draw(ctx, frame(), { x: 0, y: 0 }, { x: 100, y: 0 });
    const match = s.match!;
    expect(match).not.toBeNull();
    // A warm face: the standard enamel warmed, capped, softened.
    expect(match.gain[0]).toBeGreaterThan(match.gain[2]);
    expect(match.blur).toBeGreaterThan(0);
    // Two fitted canvases, drawn in place of the raw arches.
    expect(created).toBe(2);
    expect(drawn).toHaveLength(2);
    expect(drawn.every((d) => d.image !== undefined && !String((d.image as { id?: string }).id ?? "").startsWith("raw"))).toBe(true);
    for (let i = 0; i < 10; i++) s.draw(ctx, frame(), { x: 0, y: 0 }, { x: 100, y: 0 });
    expect(created).toBe(2);
    expect(s.match).toBe(match);
  });

  it("is fitted again only when the face's sampled values change (the texture upgrading)", () => {
    const s = surface();
    const { ctx } = context();
    s.draw(ctx, frame(), { x: 0, y: 0 }, { x: 100, y: 0 });
    const first = s.match;
    s.draw(ctx, frame({ ...warmFace, faceHighlight: 150 }), { x: 0, y: 0 }, { x: 100, y: 0 });
    expect(s.match).not.toBe(first);
    expect(s.match!.gain[0]).toBeLessThan(first!.gain[0]);
    expect(created).toBe(4);
  });

  it("leaves the raw arches in place when the face asks for no change", () => {
    const s = surface("own");
    const { ctx, drawn } = context();
    // The Reference's own face, crisp: its own teeth photo needs nothing.
    s.draw(ctx, frame({ lipColour: [144, 89, 66], skinColour: [233, 170, 135], faceHighlight: 214, sharpness: 0.6, pixelScale: 1 }), { x: 0, y: 0 }, { x: 100, y: 0 });
    for (const g of s.match!.gain) expect(Math.abs(g - 1)).toBeLessThan(1e-3);
    expect(s.match!.blur).toBe(0);
    expect(created).toBe(0);
    expect(drawn.map((d) => (d.image as { id: string }).id)).toEqual(["raw1", "raw0"]);
  });

  it("draws the arches at the reveal alpha, and not at all when hidden; the cavity stays whole", () => {
    const s = surface();
    const { ctx, drawn } = context();
    s.draw(ctx, frame(), { x: 0, y: 0 }, { x: 100, y: 0 }, 0.4);
    expect(drawn.map((d) => d.alpha)).toEqual([0.4, 0.4]);
    expect(ctx.globalAlpha).toBe(1);
    drawn.length = 0;
    s.draw(ctx, frame(), { x: 0, y: 0 }, { x: 100, y: 0 }, 0);
    expect(drawn).toHaveLength(0);
  });
});

describe("the photographic mouth as the lips part", () => {
  const manifest = validatePerformanceManifest(JSON.parse(readFileSync(new URL("../../../assets/mouth-motion.json", import.meta.url), "utf8")));
  const neutral = manifest.poses[0].points.map(([x, y]) => ({ x: x * 1000, y: y * 1000 }));
  const rig = { inner_lip_ring: manifest.inner_ring } as Rig;
  const width = Math.hypot(neutral[291].x - neutral[61].x, neutral[291].y - neutral[61].y);

  /** A 2D context that records its calls and property sets into `calls`;
   *  its transform is the identity, as a face drawn straight has. */
  const gradient = { addColorStop() {} };
  const recording = (calls: string[]) => new Proxy({ globalAlpha: 1, getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }), createRadialGradient: () => { calls.push("createRadialGradient"); return gradient; } } as Record<string, unknown>, {
    get: (obj, key: string) => (key in obj ? obj[key] : (...args: unknown[]) => { calls.push(`${key}${typeof args[0] === "string" ? `(${args[0]})` : ""}`); }),
    set: (obj, key: string, value) => { obj[key] = value; calls.push(`${key}=${value}`); return true; },
  }) as unknown as CanvasRenderingContext2D;

  /** The mouth with a recording oral surface, its lips `gap` apart: what
   *  reaches the face's own context, and what is painted into the layer the
   *  interior is feathered through (aperture-feather.ts). */
  function parted(gap: number) {
    const mouth = new ContinuousMouth(manifest);
    const draws: { alpha: number; ctx: unknown }[] = [];
    Object.assign(mouth, { oral: { draw: (c: unknown, _f: unknown, _l: unknown, _r: unknown, alpha: number) => draws.push({ alpha, ctx: c }) } });
    const points = neutral.map((p) => ({ ...p }));
    points[13].y -= gap / 2; points[14].y += gap / 2;
    const calls: string[] = [];
    const layer: string[] = [];
    const layerCtx = recording(layer);
    vi.stubGlobal("document", { createElement: () => ({ width: 0, height: 0, getContext: () => layerCtx }) });
    const ctx = recording(calls);
    const painted = mouth.paint(ctx, { points, neutral, rig, weights: REFERENCE_POSES.rest.weights, viseme: "sil", lipColour: [150, 90, 84] });
    return { painted, draws: draws.map((d) => d.alpha), onLayer: draws.every((d) => d.ctx === layerCtx), calls, layer };
  }

  beforeEach(() => vi.stubGlobal("Path2D", TestPath));
  afterEach(() => vi.unstubAllGlobals());

  it("paints nothing at the Reference's closed rest, exactly as before", () => {
    const { painted, draws, calls, layer } = parted(0);
    expect(painted).toBe(true);
    expect(draws).toEqual([]);
    expect(calls).toEqual([]);
    expect(layer).toEqual([]);
  });

  it("between words: the lips' own seam, a soft dark line, no enamel", () => {
    const { draws, onLayer, calls, layer } = parted(width * 0.035);
    expect(draws).toHaveLength(1);
    expect(draws[0]).toBeLessThan(0.05);
    expect(onLayer).toBe(true);
    // The interior is let through only partly (into the layer), and on the
    // face the seam line's stacked strokes are the only strokes, with no
    // filter: the layer comes as one image.
    const alpha = layer.find((c) => c.startsWith("globalAlpha=") && c !== "globalAlpha=1");
    expect(alpha).toBeDefined();
    expect(Number(alpha!.slice("globalAlpha=".length))).toBeLessThan(0.5);
    expect(calls.filter((c) => c === "stroke")).toHaveLength(SEAM_STROKES.length);
    expect(calls.some((c) => c.startsWith("filter="))).toBe(false);
    expect(calls.filter((c) => c === "drawImage")).toHaveLength(1);
    // No halo on the lips of a picture whose sharpness is unknown.
    expect(calls.filter((c) => c === "stroke(aperture)" || c.startsWith("strokeStyle"))).toHaveLength(SEAM_STROKES.length);
    // The corners' stamps are on the mask, never on the face.
    expect(calls).not.toContain("createRadialGradient");
    expect(layer.filter((c) => c === "createRadialGradient")).toHaveLength(2);
  });

  it("open: the teeth whole, the interior whole, no seam line", () => {
    const { draws, onLayer, calls, layer } = parted(width * 0.15);
    expect(draws).toEqual([1]);
    expect(onLayer).toBe(true);
    expect(layer).toContain("globalAlpha=1");
    expect(calls.filter((c) => c === "stroke")).toHaveLength(0);
    expect(calls.filter((c) => c === "drawImage")).toHaveLength(1);
    // The inner lip's bands are painted into the layer, never onto the face.
    expect(layer.filter((c) => c === "stroke").length).toBeGreaterThanOrEqual(6);
  });

  it("paints straight onto the face, clipped, when no layer can be had", () => {
    const mouth = new ContinuousMouth(manifest);
    const draws: unknown[] = [];
    Object.assign(mouth, { oral: { draw: (c: unknown) => draws.push(c) } });
    const points = neutral.map((p) => ({ ...p }));
    points[13].y -= width * 0.075; points[14].y += width * 0.075;
    vi.stubGlobal("document", undefined);
    const calls: string[] = [];
    const ctx = recording(calls);
    mouth.paint(ctx, { points, neutral, rig, weights: REFERENCE_POSES.rest.weights, viseme: "sil", lipColour: [150, 90, 84] });
    expect(draws).toHaveLength(1);
    expect(draws[0]).toBe(ctx);
    expect(calls.slice(0, 2)).toEqual(["save", "clip"]);
    expect(calls).not.toContain("drawImage");
  });

  it("hands the reveal to the geometric fallback as its teeth alpha", () => {
    const mouth = new ContinuousMouth(manifest);
    const geometric = vi.spyOn((mouth as unknown as { geometric: { draw: (...a: unknown[]) => void } }).geometric, "draw").mockImplementation(() => {});
    const points = neutral.map((p) => ({ ...p }));
    points[13].y -= width * 0.025; points[14].y += width * 0.025;
    const ctx = { save() {}, restore() {}, clip() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, setTransform() {}, drawImage() {}, globalAlpha: 1 } as unknown as CanvasRenderingContext2D;
    mouth.paint(ctx, { points, neutral, rig, weights: REFERENCE_POSES.rest.weights, viseme: "sil" });
    const frame = geometric.mock.calls[0][1] as { teethAlpha: number; cavityAlpha: number };
    expect(frame.teethAlpha).toBeGreaterThan(0);
    expect(frame.teethAlpha).toBeLessThan(0.5);
    expect(frame.cavityAlpha).toBeGreaterThanOrEqual(frame.teethAlpha);
  });
});
