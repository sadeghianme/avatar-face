import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { Rig } from "../../types";
import { layOutFace, refineMesh } from "../geometry";
import { outlineBasis, outlineFade } from "../head-outline";

/**
 * The face mesh's outline and the harmonic weights that hold it
 * (head-outline.ts), on the human fixture: the outline is the face's edge
 * above the jaw, every other landmark on an edge the mean of its
 * neighbours, the same at any viewport.
 */
const rig = JSON.parse(
  readFileSync(new URL("../../__tests__/fixtures/human-rig.json", import.meta.url), "utf8")
) as Rig;
const [W, H] = rig.image_size;
const image = { naturalWidth: W, naturalHeight: H, width: W, height: H } as HTMLImageElement;
const meshAt = (size: number, zoom: number) => {
  const mesh = layOutFace(rig, image, { width: size, height: size }, zoom, undefined);
  refineMesh(mesh, rig, image);
  return mesh;
};
const trianglesOf = (n: number) => rig.triangles.filter(([a, b, c]) => a < n && b < n && c < n);
const mesh = meshAt(960, 1);
const basis = outlineBasis(mesh.basePoints, trianglesOf(mesh.basePoints.length));

describe("the outline", () => {
  it("is the face's edge above the jaw: the forehead, the temples, down to the jaw line's ends below the ears", () => {
    const outline = [...basis.outline];
    for (const i of [10, 234, 454, 93, 323]) expect(outline).toContain(i);
    for (const i of [152, 148, 377, 58, 288]) expect(outline).not.toContain(i);
    // No landmark is both.
    for (const i of basis.free) expect(outline).not.toContain(i);
  });

  it("fades from 0 on it to 1 a band's width inside it", () => {
    const iod = Math.hypot(
      mesh.basePoints[33].x - mesh.basePoints[263].x,
      mesh.basePoints[33].y - mesh.basePoints[263].y
    );
    const fade = outlineFade(mesh.basePoints, basis.outline, 0.42 * iod);
    for (const i of basis.outline) expect(fade[i]).toBe(0);
    // The nose tip is well inside.
    expect(fade[1]).toBe(1);
    for (const v of fade) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe("the outline's harmonic weights", () => {
  const { outline, free, weights } = basis;
  const h = outline.length;

  it("are a smooth average of the outline's: each row sums to one, none negative", () => {
    for (let r = 0; r < free.length; r++) {
      let sum = 0;
      for (let k = 0; k < h; k++) {
        const w = weights[r * h + k];
        expect(w).toBeGreaterThanOrEqual(-1e-9);
        sum += w;
      }
      expect(sum).toBeCloseTo(1, 6);
    }
  });

  it("are each free landmark's neighbours' mean (the discrete Laplace equation)", () => {
    const value = new Float64Array(mesh.basePoints.length);
    // A test function on the outline: its x, so the extension is near x.
    outline.forEach((i) => (value[i] = mesh.basePoints[i].x));
    free.forEach((i, r) => {
      let v = 0;
      for (let k = 0; k < h; k++) v += weights[r * h + k] * value[outline[k]];
      value[i] = v;
    });
    const base = mesh.basePoints;
    const nb = new Map<number, Map<number, number>>();
    for (const [a, b, c] of rig.triangles) {
      for (const [i, j] of [
        [a, b],
        [b, c],
        [c, a],
      ]) {
        const w = 1 / Math.hypot(base[i].x - base[j].x, base[i].y - base[j].y);
        if (!nb.has(i)) nb.set(i, new Map());
        if (!nb.has(j)) nb.set(j, new Map());
        nb.get(i)!.set(j, w);
        nb.get(j)!.set(i, w);
      }
    }
    for (const i of free) {
      let s = 0,
        t = 0;
      for (const [j, w] of nb.get(i)!) {
        s += w * value[j];
        t += w;
      }
      expect(value[i]).toBeCloseTo(s / t, 6);
    }
  });

  it("are the same at any viewport of the rig, so one serves them all", () => {
    const other = meshAt(480, 0.4);
    const b = outlineBasis(other.basePoints, trianglesOf(other.basePoints.length));
    expect([...b.outline]).toEqual([...outline]);
    expect([...b.free]).toEqual([...free]);
    for (let k = 0; k < weights.length; k += 37) expect(b.weights[k]).toBeCloseTo(weights[k], 9);
  });
});
