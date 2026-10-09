import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { Rig } from "../../types";
import { ExpressionRig, ExpressionRigs, NONE, type ShapeMix } from "../expression-rig";
import {
  HUMAN_GAINS,
  REGION_CAP,
  REGIONS,
  SHAPE_NAMES,
  type ExpressionGains,
  type ShapeName,
} from "../expression-table";
import { layOutFace, refineMesh, type Point } from "../geometry";
import { HeadTurn } from "../head-turn";
import { FACE_OVAL, INNER_LOWER, INNER_UPPER } from "../jaw-rig";
import { EYE_CORNERS, IRISES, LOWER_LIDS, UPPER_LIDS } from "../landmarks";

/**
 * The expressions laid on a face (expression-rig.ts), on the committed
 * rigs: the outline and the irises' centres never move, the lips that meet
 * at rest move together, no expression folds a triangle, and the head's
 * turn turns the face the expression made.
 */
const load = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../__tests__/fixtures/${name}`, import.meta.url), "utf8")) as Rig;
const RIGS = { human: load("human-rig.json"), animal: load("fitted-animal-rig.json") };
const pointsOf = (rig: Rig): Point[] => rig.points.map(([x, y]) => ({ x, y }));
const mix = (shapes: Partial<Record<ShapeName, number>>): ShapeMix => ({ ...NONE, ...shapes });
const area = (p: readonly Point[], [a, b, c]: readonly number[]) =>
  (p[b].x - p[a].x) * (p[c].y - p[a].y) - (p[c].x - p[a].x) * (p[b].y - p[a].y);
const iodOf = (p: readonly Point[]) =>
  Math.hypot((p[263].x + p[362].x - p[33].x - p[133].x) / 2, (p[263].y + p[362].y - p[33].y - p[133].y) / 2);

/** The smallest area ratio of the rig's (non-sliver) triangles, `pts`
 *  against `base`. */
function smallestRatio(rig: Rig, base: readonly Point[], pts: readonly Point[]): number {
  const iod = iodOf(base);
  let min = Infinity;
  for (const t of rig.triangles) {
    if (t.some((i) => i >= 478)) continue;
    const was = area(base, t);
    if (Math.abs(was) < 0.0005 * iod * iod) continue;
    min = Math.min(min, area(pts, t) / was);
  }
  return min;
}

describe.each(Object.entries(RIGS))("the expression rig on the %s fixture", (_, rig) => {
  const base = pointsOf(rig);
  const xr = ExpressionRig.build(base, rig.triangles, HUMAN_GAINS)!;

  it("never moves the face's outline or the irises' centres", () => {
    for (const region of REGIONS)
      for (const side of [0, 1] as const) {
        for (const i of FACE_OVAL) expect(xr.weightOf(region, side, i), `${region} ${i}`).toBe(0);
        for (const [centre] of IRISES) expect(xr.weightOf(region, side, centre)).toBe(0);
      }
  });

  it("keeps the brows' regions off the eyes, and the mouth's and the cheeks' too", () => {
    for (const side of [0, 1] as const) {
      const eye = [...UPPER_LIDS[side], ...LOWER_LIDS[side], ...EYE_CORNERS[side]];
      for (const region of ["browInner", "browOuter", "cheek", "mouthCorner"] as const)
        for (const i of eye) expect(xr.weightOf(region, side, i), `${region} ${i}`).toBe(0);
      // The eye's corners stay under the lids' regions too.
      for (const c of EYE_CORNERS[side]) expect(xr.weightOf("upperLid", side, c)).toBe(0);
    }
  });

  it("moves the two inner lips of a column together", () => {
    for (const side of [0, 1] as const)
      for (let k = 0; k < INNER_UPPER.length; k++)
        expect(xr.weightOf("mouthCorner", side, INNER_UPPER[k])).toBe(xr.weightOf("mouthCorner", side, INNER_LOWER[k]));
  });

  it("moves nothing when nothing is on, or at scale 0", () => {
    const pts = pointsOf(rig);
    expect(xr.apply(pts, NONE, 1)).toBe(false);
    expect(xr.apply(pts, mix({ happy: 1 }), 0)).toBe(false);
    expect(pts).toEqual(base);
  });

  it("folds no triangle with any expression at 1 (the ceilings stay 1)", () => {
    for (const name of SHAPE_NAMES) {
      expect(xr.ceiling[name]).toBe(1);
      const pts = pointsOf(rig);
      xr.apply(pts, mix({ [name]: 1 }), 1);
      expect(smallestRatio(rig, base, pts), name).toBeGreaterThan(0.2);
    }
  });

  it("mirrors a symmetric expression, and keeps thinking one-sided", () => {
    const pts = pointsOf(rig);
    xr.apply(pts, mix({ happy: 1 }), 1);
    const l = { x: pts[61].x - base[61].x, y: pts[61].y - base[61].y };
    const r = { x: pts[291].x - base[291].x, y: pts[291].y - base[291].y };
    expect(l.y).toBeLessThan(0); // up
    expect(r.y).toBeLessThan(0);
    expect(l.x).toBeLessThan(0); // out
    expect(r.x).toBeGreaterThan(0);
    expect(Math.hypot(l.x, l.y)).toBeCloseTo(Math.hypot(r.x, r.y), 0);
    const think = pointsOf(rig);
    xr.apply(think, mix({ thinking: 1 }), 1);
    expect(think[300].y).toBeLessThan(base[300].y); // the picture's right outer brow up
    expect(think[70].y).toBeCloseTo(base[70].y, 6); // the left one not raised
  });

  it("caps a region however many expressions sum in it", () => {
    const iod = iodOf(base);
    const pts = pointsOf(rig);
    xr.apply(pts, mix({ surprised: 1, browFlash: 1, thinking: 1 }), 1);
    for (const i of [107, 336, 70, 300]) {
      const d = Math.hypot(pts[i].x - base[i].x, pts[i].y - base[i].y);
      expect(d).toBeLessThanOrEqual(REGION_CAP.browInner * iod * 1.0001);
    }
  });
});

describe("the expression rig's calibration and cache", () => {
  const rig = RIGS.human;
  const base = pointsOf(rig);

  it("lowers an expression's ceiling on a face where it would fold", () => {
    const huge = Object.fromEntries(REGIONS.map((r) => [r, 12])) as unknown as ExpressionGains;
    const xr = ExpressionRig.build(base, rig.triangles, huge)!;
    expect(xr.ceiling.surprised).toBeLessThan(1);
    const pts = pointsOf(rig);
    xr.apply(pts, mix({ surprised: 1 }), 1);
    expect(smallestRatio(rig, base, pts)).toBeGreaterThan(0.2 - 1e-9);
  });

  it("is built once per mesh, on first need, and refuses a face it cannot read", () => {
    const rigs = new ExpressionRigs(rig.triangles, HUMAN_GAINS);
    const mesh = { basePoints: base } as Parameters<ExpressionRigs["get"]>[0];
    expect(rigs.get(mesh, false)).toBeNull();
    const first = rigs.get(mesh, true);
    expect(first).not.toBeNull();
    expect(rigs.get(mesh, true)).toBe(first);
    expect(ExpressionRig.build(base.slice(0, 400), rig.triangles, HUMAN_GAINS)).toBeNull();
    const dot = base.map(() => ({ x: 1, y: 1 }));
    expect(ExpressionRig.build(dot, rig.triangles, HUMAN_GAINS)).toBeNull();
  });
});

describe("an expression under the head's turn in depth", () => {
  const rig = RIGS.human;
  const [W, H] = rig.image_size;
  const image = { naturalWidth: W, naturalHeight: H, width: W, height: H } as HTMLImageElement;
  const mesh = layOutFace(rig, image, { width: 960, height: 960 }, 1, undefined);
  refineMesh(mesh, rig, image);
  const turn = HeadTurn.build(mesh, rig.triangles)!;
  const xr = ExpressionRig.build(mesh.basePoints, rig.triangles, HUMAN_GAINS)!;
  const DEG = Math.PI / 180;
  const expressed = (shapes: Partial<Record<ShapeName, number>>) => {
    const pts = mesh.basePoints.map((p) => ({ x: p.x, y: p.y }));
    xr.apply(pts, mix(shapes), 1);
    return pts;
  };

  it("is untouched by a turn of nothing", () => {
    const pts = expressed({ happy: 1, surprised: 0.5 });
    const want = pts.map((p) => ({ ...p }));
    turn.apply(pts, { yaw: 0, pitch: 0, roll: 0 }, null, 0);
    for (let i = 0; i < 478; i++) {
      expect(pts[i].x).toBeCloseTo(want[i].x, 6);
      expect(pts[i].y).toBeCloseTo(want[i].y, 6);
    }
  });

  it("is turned whole at the pose's limits: no fold, nothing scaled back", () => {
    for (const shapes of [{ happy: 1 }, { surprised: 1 }, { concerned: 1 }, { thinking: 1 }, { serious: 1 }])
      for (const [yaw, pitch] of [
        [9, 5],
        [-9, -5],
        [9, -5],
        [-9, 5],
      ]) {
        const pts = expressed(shapes);
        turn.apply(pts, { yaw: yaw * DEG, pitch: pitch * DEG, roll: 0 }, null, 0);
        expect(turn.stats.flipsAfter, JSON.stringify(shapes)).toBe(0);
        expect(turn.stats.scale).toBe(1);
      }
  });

  it("keeps what the expression did to the brows through the turn", () => {
    const plain = mesh.basePoints.map((p) => ({ x: p.x, y: p.y }));
    const up = expressed({ surprised: 1 });
    const pose = { yaw: 6 * DEG, pitch: 0, roll: 0 };
    turn.apply(plain, pose, null, 0);
    const turnedPlain = plain.map((p) => ({ ...p }));
    turn.apply(up, pose, null, 0);
    for (const i of [105, 334]) {
      const raised = mesh.basePoints[i].y - expressed({ surprised: 1 })[i].y;
      expect(turnedPlain[i].y - up[i].y).toBeGreaterThan(raised * 0.8);
    }
  });
});
