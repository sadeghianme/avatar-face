import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { Rig } from "../../types";
import { ExpressionRig, ExpressionRigs, NONE, type ShapeMix } from "../expression-rig";
import {
  BROW_CAP,
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
import { BROW_LOWER, BROW_UPPER, EYE_CORNERS, IRISES, LOWER_LIDS, UPPER_LIDS } from "../landmarks";

/**
 * The expressions laid on a face (expression-rig.ts), on the committed
 * rigs: the outline and the irises' centres never move, the lips that meet
 * at rest move together, the brows move as rigid strips and never move the
 * lids, the eyes open and close only where an expression means them to,
 * no expression folds a triangle, and the head's turn turns the face the
 * expression made.
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
const dist = (p: readonly Point[], a: number, b: number) => Math.hypot(p[a].x - p[b].x, p[a].y - p[b].y);

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

/** Each eye's opening: the lids' mean distance over three columns. */
const OPENINGS: readonly (readonly [number, number][])[] = [
  [
    [159, 145],
    [158, 153],
    [160, 144],
  ],
  [
    [386, 374],
    [385, 380],
    [387, 373],
  ],
];
const opening = (p: readonly Point[], e: 0 | 1) =>
  OPENINGS[e].reduce((s, [a, b]) => s + dist(p, a, b), 0) / OPENINGS[e].length;

describe.each(Object.entries(RIGS))("the expression rig on the %s fixture", (fixture, rig) => {
  const base = pointsOf(rig);
  const xr = ExpressionRig.build(base, rig.triangles, HUMAN_GAINS)!;
  const expressed = (shapes: Partial<Record<ShapeName, number>>) => {
    const pts = pointsOf(rig);
    xr.apply(pts, mix(shapes), 1);
    return pts;
  };

  it("never moves the face's outline or the irises' centres", () => {
    for (const region of REGIONS)
      for (const side of [0, 1] as const) {
        for (const i of FACE_OVAL) expect(xr.weightOf(region, side, i), `${region} ${i}`).toBe(0);
        for (const [centre] of IRISES) expect(xr.weightOf(region, side, centre)).toBe(0);
      }
    for (const name of SHAPE_NAMES) {
      const pts = expressed({ [name]: 1 });
      for (const i of [...FACE_OVAL, ...IRISES.map(([c]) => c)]) {
        expect(pts[i].x, `${name} ${i}`).toBeCloseTo(base[i].x, 9);
        expect(pts[i].y, `${name} ${i}`).toBeCloseTo(base[i].y, 9);
      }
    }
  });

  it("keeps the cheeks' and the mouth's regions off the eyes, and a brow off the lids", () => {
    for (const side of [0, 1] as const) {
      const eye = [...UPPER_LIDS[side], ...LOWER_LIDS[side], ...EYE_CORNERS[side]];
      for (const region of ["cheek", "mouthCorner"] as const)
        for (const i of eye) expect(xr.weightOf(region, side, i), `${region} ${i}`).toBe(0);
      for (const c of EYE_CORNERS[side]) expect(xr.weightOf("upperLid", side, c)).toBe(0);
      for (const s of [0, 1] as const) for (const i of eye) expect(xr.brows.weightOf(s, i).weight, `brow ${i}`).toBe(0);
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
      expect(xr.ceiling[name], name).toBe(1);
      expect(smallestRatio(rig, base, expressed({ [name]: 1 })), name).toBeGreaterThan(0.2);
    }
  });

  it("moves a brow as a rigid strip: its thickness, edge to edge down a column, kept", () => {
    // The lower edge's height at `x` (its landmarks as a polyline).
    const lowerAt = (p: readonly Point[], side: 0 | 1, x: number) => {
      const row = BROW_LOWER[side].map((i) => p[i]).sort((a, b) => a.x - b.x);
      for (let k = 1; k < row.length; k++)
        if (x <= row[k].x)
          return row[k - 1].y + ((row[k].y - row[k - 1].y) * (x - row[k - 1].x)) / (row[k].x - row[k - 1].x);
      return row[row.length - 1].y;
    };
    for (const name of ["surprised", "concerned", "serious", "thinking", "browFlash"] as const) {
      const pts = expressed({ [name]: 1 });
      for (const side of [0, 1] as const)
        for (const u of BROW_UPPER[side].slice(1, -1)) {
          const was = lowerAt(base, side, base[u].x) - base[u].y;
          const now = lowerAt(pts, side, pts[u].x) - pts[u].y;
          // The lower edge is read between its landmarks as a straight line,
          // the brow's move along it is a curve: on the animal's short, thin
          // brows that reads a little more than the hair's change (the
          // rendered brows' thickness is measured in docs/emotions.md).
          expect(Math.abs(now / was - 1), `${name} ${u}`).toBeLessThanOrEqual(fixture === "human" ? 0.04 : 0.06);
        }
    }
  });

  it("lifts a surprised brow by a good share of the brow-to-lid distance, and the inner end of a worried one", () => {
    const up = (pts: readonly Point[], i: number) => (base[i].y - pts[i].y) / iodOf(base);
    const surprised = expressed({ surprised: 1 });
    const concerned = expressed({ concerned: 1 });
    const serious = expressed({ serious: 1 });
    for (const side of [0, 1] as const) {
      const [inner, mid, outer] = [0, 2, 4].map((k) => BROW_LOWER[side][k]);
      expect(up(surprised, mid)).toBeGreaterThan(0.025);
      expect(up(concerned, inner)).toBeGreaterThan(up(concerned, outer) + 0.02);
      expect(up(serious, inner)).toBeLessThan(-0.015);
    }
    // The knit: the inner ends drawn toward each other.
    const gap = (p: readonly Point[]) => Math.abs(p[BROW_LOWER[1][0]].x - p[BROW_LOWER[0][0]].x);
    expect(gap(serious)).toBeLessThan(gap(base) - 0.02 * iodOf(base));
  });

  it("opens or closes the eyes only where an expression means to (≤ 3% otherwise)", () => {
    for (const name of SHAPE_NAMES) {
      const pts = expressed({ [name]: 1 });
      for (const e of [0, 1] as const) {
        const change = opening(pts, e) / opening(base, e) - 1;
        if (name === "surprised") expect(change, name).toBeGreaterThan(0.03);
        else if (name === "happy") expect(change, name).toBeLessThan(0);
        else expect(Math.abs(change), `${name} eye ${e}`).toBeLessThanOrEqual(0.03);
      }
    }
  });

  it("mirrors a symmetric expression, and keeps thinking one-sided", () => {
    const pts = expressed({ happy: 1 });
    const l = { x: pts[61].x - base[61].x, y: pts[61].y - base[61].y };
    const r = { x: pts[291].x - base[291].x, y: pts[291].y - base[291].y };
    expect(l.y).toBeLessThan(0); // up
    expect(r.y).toBeLessThan(0);
    expect(l.x).toBeLessThan(0); // out
    expect(r.x).toBeGreaterThan(0);
    expect(Math.hypot(l.x, l.y)).toBeCloseTo(Math.hypot(r.x, r.y), 0);
    const think = expressed({ thinking: 1 });
    expect(think[300].y).toBeLessThan(base[300].y - 0.01 * iodOf(base)); // the picture's right brow up
    expect(think[70].y).toBeGreaterThanOrEqual(base[70].y); // the left one not raised
  });

  it("caps a region and a brow however many expressions sum in them", () => {
    const iod = iodOf(base);
    const pts = expressed({ surprised: 1, browFlash: 1, thinking: 1, concerned: 1 });
    for (const i of [61, 291]) {
      const d = Math.hypot(pts[i].x - base[i].x, pts[i].y - base[i].y);
      expect(d).toBeLessThanOrEqual((REGION_CAP.mouthCorner + REGION_CAP.cheek) * iod);
    }
    for (const side of [0, 1] as const)
      for (const i of BROW_LOWER[side]) {
        const unit = xr.brows.unitAt(side, i);
        expect(base[i].y - pts[i].y).toBeLessThanOrEqual(BROW_CAP.rise * unit * iod * 1.0001 + 1e-9);
      }
  });
});

describe("the expression rig's brows over the picture", () => {
  const rig = RIGS.human;
  const base = pointsOf(rig);

  it("reads the brows' hair from the picture when it can, and the landmarks stand in when it cannot", () => {
    // A picture whose brows are dark bands where the landmarks put them.
    const luma = (p: Point) => {
      for (const side of [0, 1] as const)
        for (let k = 0; k + 1 < BROW_UPPER[side].length; k++) {
          const [a, b] = [base[BROW_UPPER[side][k]], base[BROW_UPPER[side][k + 1]]];
          const [c, d] = [base[BROW_LOWER[side][k]], base[BROW_LOWER[side][k + 1]]];
          const lo = Math.min(a.x, b.x),
            hi = Math.max(a.x, b.x);
          if (p.x < lo || p.x > hi) continue;
          const u = (p.x - a.x) / (b.x - a.x || 1);
          const top = a.y + (b.y - a.y) * u,
            bottom = c.y + (d.y - c.y) * u;
          if (p.y >= top && p.y <= bottom) return 40;
        }
      return 200;
    };
    const read = ExpressionRig.build(base, rig.triangles, HUMAN_GAINS, luma)!;
    expect(read.bands[0]).not.toBeNull();
    expect(read.bands[1]).not.toBeNull();
    const flat = ExpressionRig.build(base, rig.triangles, HUMAN_GAINS, () => 128)!;
    expect(flat.bands).toEqual([null, null]);
  });
});

describe("the expression rig's calibration and cache", () => {
  const rig = RIGS.human;
  const base = pointsOf(rig);

  it("lowers an expression's ceiling on a face where it would fold", () => {
    const huge = {
      ...Object.fromEntries(REGIONS.map((r) => [r, 12])),
      brows: 1,
      cues: 1,
    } as unknown as ExpressionGains;
    const xr = ExpressionRig.build(base, rig.triangles, huge)!;
    expect(xr.ceiling.happy).toBeLessThan(1);
    const pts = pointsOf(rig);
    xr.apply(pts, mix({ happy: 1 }), 1);
    expect(smallestRatio(rig, base, pts)).toBeGreaterThan(0.2 - 1e-9);
  });

  it("is built once per mesh, on first need, and refuses a face it cannot read", () => {
    const rigs = new ExpressionRigs(rig.triangles, HUMAN_GAINS);
    const mesh = { basePoints: base, texPoints: base } as Parameters<ExpressionRigs["get"]>[0];
    expect(rigs.get(mesh, null, false)).toBeNull();
    const first = rigs.get(mesh, null, true);
    expect(first).not.toBeNull();
    expect(rigs.get(mesh, null, true)).toBe(first);
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
