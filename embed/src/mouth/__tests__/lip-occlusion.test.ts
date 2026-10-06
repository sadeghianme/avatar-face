import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dentalOpening } from "../lip-occlusion-model";
import { MouthMotion, mouthMixWeights } from "../continuous-mouth-model";
import { ContinuousMouth } from "../continuous-mouth";
import { dentalSurfaceIn } from "../seam";
import { ReferenceMouth } from "../reference-mouth";
import { DEFAULT_REFERENCE_PROFILE, REFERENCE_POSES } from "../reference-mouth-model";
import { PERFORMANCE_POSES, validatePerformanceManifest } from "../photographic-performance-model";
import { ZERO_WEIGHTS, type BlendWeights, type Rig } from "../../types";
import { centralMouthAnchors, type MouthPoint, type MouthSurfaceFrame } from "../../mouth-extension";
import { fakeCanvas } from "../../__tests__/browser-fakes";

class TestPath {
  points: MouthPoint[] = [];
  moveTo(x: number, y: number) {
    this.points.push({ x, y });
  }
  lineTo(x: number, y: number) {
    this.points.push({ x, y });
  }
  closePath() {}
}
const left = { x: 0, y: 0 },
  right = { x: 100, y: 0 };
const ring = [
  { x: 0, y: 0 },
  { x: 50, y: 30 },
  { x: 100, y: 0 },
  { x: 50, y: -10 },
];
const mixPose = (a: BlendWeights, b: BlendWeights, t: number): BlendWeights =>
  Object.fromEntries(
    Object.keys(a).map((k) => [k, a[k as keyof BlendWeights] * (1 - t) + b[k as keyof BlendWeights] * t])
  ) as unknown as BlendWeights;

describe("lip-driven tooth visibility", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("leaves unrounded openings and source points unchanged", () => {
    expect(dentalOpening(ring, left, right, ZERO_WEIGHTS)).toEqual(ring);
    expect(dentalOpening([], left, right, ZERO_WEIGHTS)).toEqual([]);
    expect(dentalOpening(ring, left, left, ZERO_WEIGHTS)).toEqual(ring);
  });

  it("narrows the back opening without changing tooth dimensions or crossing the lips", () => {
    const open = dentalOpening(ring, left, right, REFERENCE_POSES.oo.weights);
    expect(open[1].y).toBeLessThan(ring[1].y);
    expect(open[3].y).toBeGreaterThan(ring[3].y);
    expect(open[0].x).toBeGreaterThan(ring[0].x);
    expect(open[2].x).toBeLessThan(ring[2].x);
    expect(open[1].y).toBeGreaterThan(open[3].y);
    expect(ring[1]).toEqual({ x: 50, y: 30 });
  });

  it("follows a rotated, scaled and translated mouth instead of the screen axes", () => {
    const transform = (p: MouthPoint) => ({ x: 220 - p.y * 2, y: 70 + p.x * 2 });
    const expected = dentalOpening(ring, left, right, REFERENCE_POSES.oo.weights).map(transform);
    const actual = dentalOpening(ring.map(transform), transform(left), transform(right), REFERENCE_POSES.oo.weights);
    actual.forEach((p, i) => {
      expect(p.x).toBeCloseTo(expected[i].x);
      expect(p.y).toBeCloseTo(expected[i].y);
    });
  });

  it("can close the dental-depth opening in a narrow pucker without inverting it", () => {
    const narrow = ring.map((p) => ({ ...p, y: p.y * 0.25 }));
    const open = dentalOpening(narrow, left, right, REFERENCE_POSES.oo.weights);
    expect(Math.max(...open.map((p) => p.y)) - Math.min(...open.map((p) => p.y))).toBeCloseTo(0);
    for (let i = 0; i <= 100; i++) {
      const partial = dentalOpening(narrow, left, right, mixPose(ZERO_WEIGHTS, REFERENCE_POSES.oo.weights, i / 100));
      expect(partial[1].y + 1e-10).toBeGreaterThanOrEqual(partial[3].y);
    }
  });

  it("reconstructs every authored pose from the same geometry mixture", () => {
    PERFORMANCE_POSES.forEach((id, index) =>
      expect(mouthMixWeights(PERFORMANCE_POSES.map((_, i) => (i === index ? 1 : 0)))).toEqual(
        REFERENCE_POSES[id].weights
      )
    );
  });

  it("does not jump ahead to a newly requested rounded vowel", () => {
    const motion = new MouthMotion();
    for (let i = 0; i < 60; i++) motion.step(REFERENCE_POSES.ee.weights, 1 / 60);
    const weights = mouthMixWeights(motion.step(REFERENCE_POSES.oo.weights, 1 / 120));
    expect(weights.mouthPucker).toBeGreaterThan(0);
    expect(weights.mouthPucker).toBeLessThan(0.15);
    expect(weights.mouthStretch).toBeGreaterThan(0.6);
  });

  it("keeps the occlusion boundary continuous through all vowel pairs and reversals", () => {
    for (const a of Object.values(REFERENCE_POSES))
      for (const b of Object.values(REFERENCE_POSES)) {
        const motion = new MouthMotion();
        for (let frame = 0; frame < 120; frame++) motion.step(a.weights, 1 / 120);
        let previous = dentalOpening(ring, left, right, mouthMixWeights(motion.values));
        for (let i = 0; i <= 240; i++) {
          const weights = mouthMixWeights(
            motion.step(mixPose(a.weights, b.weights, i <= 120 ? i / 120 : 2 - i / 120), 1 / 120)
          );
          const current = dentalOpening(ring, left, right, weights);
          current.forEach((p, j) => {
            expect(Number.isFinite(p.x + p.y)).toBe(true);
            expect(Math.hypot(p.x - previous[j].x, p.y - previous[j].y)).toBeLessThan(2);
          });
          previous = current;
        }
      }
  });

  it("passes the integrated pose to both photo and uploaded-photo fallback rendering", () => {
    vi.stubGlobal("Path2D", TestPath);
    const manifest = validatePerformanceManifest(
      JSON.parse(
        readFileSync(new URL("../../../../frontend/public/lab/reference/performance.json", import.meta.url), "utf8")
      )
    );
    const neutral = manifest.poses[0].points.map(([x, y]) => ({ x: x * 1000, y: y * 1000 }));
    const points = neutral.map((p) => ({ ...p }));
    const mouth = new ContinuousMouth(manifest);
    const rig = { inner_lip_ring: manifest.inner_ring } as Rig;
    mouth.deform(points, neutral, rig, REFERENCE_POSES.aa.weights);
    // One step of the spring leaves the lips barely apart: the contact seam
    // is painted too, with these.
    const ctx = {
      save() {},
      restore() {},
      clip() {},
      beginPath() {},
      moveTo() {},
      lineTo() {},
      stroke() {},
      setTransform() {},
      drawImage() {},
    } as unknown as CanvasRenderingContext2D;
    const frame = { points, neutral, rig, weights: REFERENCE_POSES.oo.weights, viseme: "ou" };
    const geometric = vi.spyOn(ReferenceMouth.prototype, "draw").mockImplementation(() => {});
    mouth.paint(ctx, frame);
    expect(geometric).toHaveBeenCalledOnce();
    expect(geometric.mock.calls[0][1].weights.mouthPucker).toBe(0);
    expect(geometric.mock.calls[0][2]).toBeInstanceOf(TestPath);
    const draw = vi.fn();
    Object.assign(mouth, { oral: { draw } });
    mouth.paint(ctx, frame);
    expect(draw.mock.calls[0][1].weights).toEqual(geometric.mock.calls[0][1].weights);
  });

  it("covers both dental rows in the actual authored OO pose, not just a synthetic opening", () => {
    const manifest = validatePerformanceManifest(
      JSON.parse(
        readFileSync(new URL("../../../../frontend/public/lab/reference/performance.json", import.meta.url), "utf8")
      )
    );
    const neutral = manifest.poses[0].points.map(([x, y]) => ({ x: x * 1000, y: y * 1000 }));
    const points = neutral.map((p) => ({ ...p }));
    const mouth = new ContinuousMouth(manifest);
    const rig = { inner_lip_ring: manifest.inner_ring } as Rig;
    let now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    for (let i = 0; i < 60; i++) {
      now += 1000 / 60;
      mouth.deform(points, neutral, rig, REFERENCE_POSES.oo.weights);
    }
    const [a, b] = centralMouthAnchors(
      manifest.inner_ring.map((i) => neutral[i]),
      neutral[61],
      neutral[291]
    );
    const width = Math.hypot(b.x - a.x, b.y - a.y),
      ux = (b.x - a.x) / width,
      uy = (b.y - a.y) / width;
    const cy = (a.y + b.y) / 2,
      cx = (a.x + b.x) / 2;
    const y = (p: MouthPoint) => (-(p.x - cx) * uy + (p.y - cy) * ux) / width;
    const opening = dentalOpening(
      manifest.inner_ring.map((i) => points[i]),
      a,
      b,
      REFERENCE_POSES.oo.weights
    ).map(y);
    expect(Math.min(...opening)).toBeGreaterThan(0.055 + 0.016); // fixed upper incisal edge
    expect(Math.max(...opening)).toBeLessThan(y(points[14]) - 0.055); // lower incisal edge
  });

  it("draws both photo arches opaque with spatial clips through the entire rounding range", () => {
    vi.stubGlobal("Path2D", TestPath);
    // The first frame fits the enamel to the face on a canvas of its own.
    vi.stubGlobal("document", { createElement: () => fakeCanvas() });
    const surface = dentalSurfaceIn({
      lowerIncisal: 0,
      origin: "own",
      enamel: { cast: [1, 1, 1], bright: 220, edge: 4 },
      arches: [0, 1].map(() => ({
        canvas: {},
        layer: { count: 1000, box: { x: 100, y: 120, width: 400, height: 80 } },
      })),
    });
    surface.setProfile(DEFAULT_REFERENCE_PROFILE);
    for (let step = 0; step <= 20; step++) {
      const alpha: number[] = [],
        clips: unknown[] = [],
        stack: number[] = [];
      const gradient = { addColorStop() {} };
      const ctx = {
        globalAlpha: 1,
        save() {
          stack.push(this.globalAlpha);
        },
        restore() {
          this.globalAlpha = stack.pop()!;
        },
        translate() {},
        rotate() {},
        scale() {},
        createRadialGradient: () => gradient,
        createLinearGradient: () => gradient,
        fillRect() {},
        drawImage() {
          alpha.push(this.globalAlpha);
        },
        clip(p?: unknown) {
          clips.push(p);
        },
        rect() {},
        beginPath() {},
        moveTo() {},
        lineTo() {},
        stroke() {},
      };
      const points = Array.from({ length: 478 }, () => ({ x: 50, y: 25 }));
      ring.forEach((p, i) => {
        points[i] = p;
      });
      const frame = {
        points,
        neutral: points,
        rig: { inner_lip_ring: [0, 1, 2, 3, ...Array(17).fill(3)] },
        weights: mixPose(REFERENCE_POSES.ee.weights, REFERENCE_POSES.oo.weights, step / 20),
      } as unknown as MouthSurfaceFrame;
      surface.draw(ctx as unknown as CanvasRenderingContext2D, frame, left, right);
      expect(alpha).toEqual([1, 1]);
      expect(clips.filter((p) => p instanceof TestPath)).toHaveLength(2);
      expect(clips).toHaveLength(3);
      expect(stack).toHaveLength(0);
    }
  });
});
