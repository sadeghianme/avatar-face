import { readFileSync } from "node:fs";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AvatarEngine } from "../engine";
import { INNER_LOWER, INNER_UPPER, type Pt } from "../engine/character-mouth";
import { engineSeam } from "../engine/seam";
import type { MouthPose } from "../mouth-extension";
import { ZERO_WEIGHTS } from "../types";
import { SKIA_BROWSER, SUBJECTS, seededRandom } from "./pixel-frames";

/**
 * One lower lip on a rendered character's open mouth, in real pixels (the
 * engine on Skia's CPU raster, as pixels.test.ts draws it): the toon
 * subject, a photographed face with the character mouth, holding open
 * vowels.
 *
 * The owner's report (2026-10-09): "below the lips is weird and double".
 * The tongue lay along the lower lip, a third to a half of the opening tall,
 * as red as the lip, with a light edge along its top and a groove down its
 * middle, and a dark line ran between it and the lip: a second lower lip
 * right under the teeth. Read along the lip's normal at its middle, that is
 * a band inside the opening nearly as bright as the lip, standing well above
 * the dark line at the lip's edge (on the owner's avatar, held E: 140 over
 * 73). Now the tongue lies low behind the lip, darker than it, and nothing
 * inside the opening stands out above the edge's own dark.
 */

const SIDE = 512;
const STEP = 16;
const LUMA = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;

function along(line: readonly Pt[], t: number): Pt {
  const f = t * (line.length - 1);
  const i = Math.min(line.length - 2, Math.floor(f));
  const k = f - i;
  return { x: line[i].x + (line[i + 1].x - line[i].x) * k, y: line[i].y + (line[i + 1].y - line[i].y) * k };
}

/** The toon subject holding each of `visemes`, as pixels and the mesh. */
async function held(visemes: string[]): Promise<{ viseme: string; data: Uint8ClampedArray; pts: Pt[] }[]> {
  const subject = SUBJECTS.toon;
  const texture = await loadImage(readFileSync(new URL(`./fixtures/${subject.texture}`, import.meta.url)));
  const canvas = createCanvas(SIDE, SIDE);
  const ctx = canvas.getContext("2d");
  const pose: { current: MouthPose | null } = { current: null };
  const rig = structuredClone(subject.rig);
  const engine = new AvatarEngine(canvas as unknown as HTMLCanvasElement, rig, texture as unknown as HTMLImageElement, {
    warp: "2d",
    pose: () => pose.current,
  });
  // The head and the body still, so the mesh is where the pixels are.
  engine.tuning.headMotion = 0;
  engine.tuning.bodyMotion = 0;
  const e = engineSeam(engine);
  const clock = { now: 10_000 };
  vi.spyOn(performance, "now").mockImplementation(() => clock.now);
  const tick = (n: number) => {
    for (let i = 0; i < n; i++) e.tick((clock.now += STEP));
  };
  tick(60);
  const out = [];
  for (const viseme of visemes) {
    pose.current = { viseme, weights: { ...ZERO_WEIGHTS, ...(rig.visemes[viseme] ?? {}) } };
    tick(40);
    e.render();
    out.push({
      viseme,
      data: new Uint8ClampedArray(ctx.getImageData(0, 0, SIDE, SIDE).data),
      pts: e.deformedPoints(),
    });
  }
  engine.destroy();
  return out;
}

/**
 * Across the lower lip at `t` of its inner edge: the darkest luma within
 * 2 px of the edge (the dark there), and the brightest inside the opening
 * from a tenth of its height above the edge to 45% (stopping at the
 * enamel of the upper teeth), and the lip's own brightest.
 */
function across(data: Uint8ClampedArray, pts: Pt[], t: number) {
  const lower = INNER_LOWER.map((i) => pts[i]);
  const upper = INNER_UPPER.map((i) => pts[i]);
  const p = along(lower, t);
  const a = along(lower, t - 0.02),
    b = along(lower, t + 0.02);
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  let nx = (b.y - a.y) / len,
    ny = -(b.x - a.x) / len;
  if (ny > 0) {
    nx = -nx;
    ny = -ny;
  }
  const gap = Math.hypot(p.x - along(upper, t).x, p.y - along(upper, t).y);
  const at = (s: number) => {
    const x = Math.round(p.x + nx * s),
      y = Math.round(p.y + ny * s);
    const o = (y * SIDE + x) * 4;
    const [r, g, bl] = [data[o], data[o + 1], data[o + 2]];
    const enamel = Math.max(r, g, bl) - Math.min(r, g, bl) < 45 && Math.max(r, g, bl) > 150;
    return { luma: LUMA(r, g, bl), enamel };
  };
  let edge = 255;
  for (let s = -2; s <= 2; s += 0.25) edge = Math.min(edge, at(s).luma);
  let inside = 0;
  for (let s = gap * 0.1; s <= gap * 0.45; s += 0.25) {
    const v = at(s);
    if (v.enamel) break;
    inside = Math.max(inside, v.luma);
  }
  let lip = 0;
  for (let s = -12; s <= -3; s += 0.25) lip = Math.max(lip, at(s).luma);
  return { edge: Math.round(edge), inside: Math.round(inside), lip: Math.round(lip), gap: Math.round(gap) };
}

describe("a rendered character's lower lip", () => {
  beforeEach(() => {
    vi.spyOn(Math, "random").mockImplementation(seededRandom());
    for (const [name, value] of Object.entries(SKIA_BROWSER)) vi.stubGlobal(name, value);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("is one lip on an open vowel: nothing inside the opening stands out over the dark at its edge", async () => {
    for (const frame of await held(["aa", "E", "ou"])) {
      for (const t of [0.4, 0.5, 0.6]) {
        const m = across(frame.data, frame.pts, t);
        const what = `held ${frame.viseme} at ${t}: ${JSON.stringify(m)}`;
        expect(m.gap, what).toBeGreaterThan(8);
        // The lip itself is there, well above the edge's dark.
        expect(m.lip - m.edge, what).toBeGreaterThan(30);
        // No second lip: the opening's floor stays within a few levels of
        // the dark at the edge (the tongue that lay along the lip stood
        // 50 to 70 levels above it).
        expect(m.inside - m.edge, what).toBeLessThan(20);
      }
    }
  });
});
