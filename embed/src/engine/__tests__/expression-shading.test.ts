import { createCanvas } from "@napi-rs/canvas";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { Rig } from "../../types";
import { NONE, type ShapeMix } from "../expression-rig";
import { cueStrengths, paintSkinCues } from "../expression-shading";
import { SKIN_CUES, type ShapeName } from "../expression-table";

/**
 * The skin cues in real pixels (Skia, @napi-rs/canvas): nothing is painted
 * when no cue is on; a cue only darkens or lightens what is there, by a
 * share of the skin's own light, capped, alike on dark and light skin; and
 * each shape's cues land where they belong on the face.
 */
const rig = JSON.parse(
  readFileSync(new URL("../../__tests__/fixtures/human-rig.json", import.meta.url), "utf8")
) as Rig;
const pts = rig.points.slice(0, 478).map(([x, y]) => ({ x, y }));
const xs = pts.map((p) => p.x),
  ys = pts.map((p) => p.y);
const W = Math.ceil(Math.max(...xs) + 20),
  H = Math.ceil(Math.max(...ys) + 20);
const mix = (shapes: Partial<Record<ShapeName, number>>): ShapeMix => ({ ...NONE, ...shapes });

/** The face painted in one flat `skin`, with `shapes`' cues over it. */
function painted(skin: readonly [number, number, number], shapes: Partial<Record<ShapeName, number>>, gain = 1) {
  const c = createCanvas(W, H);
  const ctx = c.getContext("2d");
  ctx.fillStyle = `rgb(${skin.join(",")})`;
  ctx.fillRect(0, 0, W, H);
  paintSkinCues(ctx as unknown as CanvasRenderingContext2D, pts, mix(shapes), gain);
  return ctx.getImageData(0, 0, W, H).data;
}
const luma = (d: Uint8ClampedArray, k: number) => 0.299 * d[k] + 0.587 * d[k + 1] + 0.114 * d[k + 2];

/** Each pixel's change of light, as a share of the skin's. */
function changes(skin: readonly [number, number, number], shapes: Partial<Record<ShapeName, number>>) {
  const d = painted(skin, shapes);
  const was = 0.299 * skin[0] + 0.587 * skin[1] + 0.114 * skin[2];
  const out = new Float64Array(W * H);
  for (let k = 0; k < W * H; k++) out[k] = luma(d, 4 * k) / was - 1;
  return out;
}

describe("the skin cues", () => {
  it("are off with no shape on, at no gain, and scale with the mix", () => {
    for (const c of SKIN_CUES) expect(cueStrengths(NONE, 1)[c]).toBe(0);
    expect(cueStrengths(mix({ surprised: 0.5 }), 1).foreheadLines).toBeCloseTo(0.5, 9);
    expect(cueStrengths(mix({ surprised: 1, concerned: 1 }), 1).foreheadLines).toBe(1);
    expect(cueStrengths(mix({ happy: 1 }), 0).nasolabial).toBe(0);
    const skin = [180, 140, 120] as const;
    for (const [shapes, gain] of [
      [{}, 1],
      [{ surprised: 1 }, 0],
      [{ thinking: 1 }, 1],
    ] as const) {
      const d = painted(skin, shapes, gain);
      let off = 0;
      for (let k = 0; k < W * H; k++)
        if (d[4 * k] !== skin[0] || d[4 * k + 1] !== skin[1] || d[4 * k + 2] !== skin[2]) off++;
      expect(off).toBe(0);
    }
  });

  it("darken and lighten by a capped share of the skin's own light, alike on dark skin and light", () => {
    for (const shapes of [{ happy: 1 }, { surprised: 1 }, { serious: 1 }, { concerned: 1 }]) {
      const light = changes([226, 188, 165], shapes);
      const dark = changes([110, 72, 52], shapes);
      let most = 0,
        least = 0,
        far = 0;
      for (let k = 0; k < W * H; k++) {
        most = Math.max(most, light[k]);
        least = Math.min(least, light[k]);
        // The same share, within the 8-bit rounding of the darker skin.
        far = Math.max(far, Math.abs(light[k] - dark[k]));
      }
      expect(least).toBeLessThan(-0.02);
      expect(least).toBeGreaterThan(-0.2);
      expect(most).toBeLessThan(0.12);
      expect(far).toBeLessThan(0.05);
    }
  });

  it("land where each shape's skin folds: the forehead for surprise, the cheeks for a smile", () => {
    const iod = Math.hypot(pts[263].x - pts[33].x, pts[263].y - pts[33].y);
    const browY = Math.min(pts[105].y, pts[334].y);
    const centroid = (shapes: Partial<Record<ShapeName, number>>) => {
      const d = changes([200, 160, 140], shapes);
      let n = 0,
        y = 0;
      for (let k = 0; k < W * H; k++)
        if (d[k] < -0.01) {
          n++;
          y += Math.floor(k / W);
        }
      return y / n;
    };
    expect(centroid({ surprised: 1 })).toBeLessThan(browY);
    expect(centroid({ happy: 1 })).toBeGreaterThan(pts[1].y - 0.2 * iod);
    expect(centroid({ serious: 1 })).toBeGreaterThan(browY - 0.4 * iod);
    expect(centroid({ serious: 1 })).toBeLessThan(pts[1].y);
  });
});
