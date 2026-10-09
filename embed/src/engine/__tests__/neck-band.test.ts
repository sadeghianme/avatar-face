import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { mouthFrame, type Pt } from "../jaw-rig";
import { JAW_ARC, NECK_BAND, buildNeckBand } from "../neck-band";

/**
 * The neck band below the jaw line (neck-band.ts), on the Reference's own
 * rest pose (the face the bundled motion is measured on).
 */

const motion = JSON.parse(readFileSync(new URL("../../../assets/mouth-motion.json", import.meta.url), "utf8")) as {
  poses: { points: [number, number][] }[];
};
const reference: Pt[] = motion.poses[0].points.map(([x, y]) => ({ x: x * 1000, y: y * 1000 }));

describe("the neck band", () => {
  const f = mouthFrame(reference);
  const FIRST = 478 + 200;
  const band = buildNeckBand(reference, FIRST);
  const n = JAW_ARC.length;

  it("is two rings below the jaw line, pivot to pivot, the inner following and the outer still", () => {
    expect(band.vertices).toHaveLength(2 * n);
    expect(band.triangles).toHaveLength(4 * (n - 1));
    for (let k = 0; k < n; k++) {
      const inner = band.vertices[k],
        outer = band.vertices[n + k];
      expect(inner.parent).toBe(JAW_ARC[k]);
      expect(outer.parent).toBe(JAW_ARC[k]);
      expect(inner.share).toBe(NECK_BAND.innerShare);
      expect(outer.share).toBe(0);
      // Outside the jaw line, further for the outer ring.
      const p = reference[JAW_ARC[k]];
      const out = (q: { x: number; y: number }) =>
        Math.hypot(q.x - f.cx, q.y - f.cy) - Math.hypot(p.x - f.cx, p.y - f.cy);
      expect(out(inner)).toBeGreaterThan(f.w * 0.2);
      expect(out(outer)).toBeGreaterThan(out(inner));
    }
    // Below the chin tip by the stated offsets.
    const chin = JAW_ARC.indexOf(152);
    expect((band.vertices[chin].y - reference[152].y) / f.w).toBeCloseTo(NECK_BAND.inner, 1);
    expect((band.vertices[n + chin].y - reference[152].y) / f.w).toBeCloseTo(NECK_BAND.outer, 1);
  });

  it("triangulates the band to the jaw line with valid, non-degenerate triangles", () => {
    const all = [...reference];
    for (let i = reference.length; i < FIRST; i++) all.push({ x: 0, y: 0 });
    for (const v of band.vertices) all.push({ x: v.x, y: v.y });
    for (const [a, b, c] of band.triangles) {
      for (const i of [a, b, c]) {
        expect(i).toBeGreaterThanOrEqual(0);
        expect(i).toBeLessThan(all.length);
        expect(i < 478 || i >= FIRST).toBe(true);
      }
      const area = (all[b].x - all[a].x) * (all[c].y - all[a].y) - (all[c].x - all[a].x) * (all[b].y - all[a].y);
      expect(Math.abs(area)).toBeGreaterThan(f.w * f.w * 0.001);
    }
  });

  it("makes the mesh's outer edge stand still: nothing moves where the still picture begins", () => {
    for (let k = 0; k < n; k++) expect(band.vertices[n + k].share).toBe(0);
    expect(NECK_BAND.innerShare).toBeGreaterThan(0.5);
    expect(NECK_BAND.innerShare).toBeLessThan(1);
    expect(NECK_BAND.outer).toBeGreaterThan(NECK_BAND.inner);
  });
});
