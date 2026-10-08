import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { Rig } from "../../types";
import { layOutFace, refineMesh, type Point } from "../geometry";
import { POSE_LIMIT_DEG } from "../head-personality";
import { HeadTurn, PIVOT_CM, outlineBasis, type HeadPose3D } from "../head-turn";
import { JAW_ARC, LIP_CORNERS, LOWER_ROWS, UPPER_ROWS } from "../jaw-rig";
import { EYE_CORNERS, IRISES, LOWER_LIDS, UPPER_LIDS } from "../landmarks";
import { headMotionAffine } from "../render2d";
import { apply } from "../warp-gl";

/**
 * The head's turn in depth (head-turn.ts) on the human fixture: the
 * rotation and the perspective, nothing at rest, an outline that never
 * moves in the head's frame while the chin and the nose turn, the harmonic
 * weights that hold it, each eye as one piece, and the fold clamp, which
 * the personality's limits never reach.
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
const mesh = meshAt(960, 1);
const turn = HeadTurn.build(mesh, rig.triangles)!;
const DEG = Math.PI / 180;
const rest = () => mesh.basePoints.map((p) => ({ x: p.x, y: p.y }));
const moved = (pts: Point[], i: number) => Math.hypot(pts[i].x - mesh.basePoints[i].x, pts[i].y - mesh.basePoints[i].y);
const turned = (pose: Partial<HeadPose3D>, rigid: Parameters<HeadTurn["apply"]>[2] = null) => {
  const pts = rest();
  turn.apply(pts, { yaw: 0, pitch: 0, roll: 0, ...pose }, rigid, 0);
  return pts;
};

describe("HeadTurn's geometry", () => {
  it("fits a depth with the nose ahead of the cheeks and the pivot behind the face", () => {
    expect(turn).not.toBeNull();
    expect(turn.depth[1]).toBeGreaterThan(turn.depth[234] + 0.5 * turn.iod);
    expect(turn.depth[1]).toBeGreaterThan(turn.depth[454] + 0.5 * turn.iod);
    // The pivot: behind the ears (their depth is the canonical -2.4 cm), on
    // the face's middle line.
    expect(turn.pivot.z).toBeLessThan(Math.min(turn.depth[234], turn.depth[454]));
    expect(Math.abs(turn.pivot.x - (mesh.basePoints[234].x + mesh.basePoints[454].x) / 2)).toBeLessThan(0.1 * turn.iod);
    expect(PIVOT_CM.z).toBeLessThan(-2.4);
  });

  it("rotates about the pivot and sees the result through the camera", () => {
    // The same rotation and perspective, written out: back out of the photo's
    // perspective, rotate (yaw, then pitch, then roll), project again.
    const D = 9 * turn.iod;
    const P = turn.pivot;
    const by = (x: number, y: number, z: number, { yaw, pitch, roll }: HeadPose3D) => {
      const k0 = (D - (z - P.z)) / D;
      const v = [(x - P.x) * k0, (y - P.y) * k0, z - P.z];
      const [X1, Z1] = [v[0] * Math.cos(yaw) + v[2] * Math.sin(yaw), -v[0] * Math.sin(yaw) + v[2] * Math.cos(yaw)];
      const [Y2, Z2] = [v[1] * Math.cos(pitch) + Z1 * Math.sin(pitch), -v[1] * Math.sin(pitch) + Z1 * Math.cos(pitch)];
      const [X3, Y3] = [X1 * Math.cos(roll) - Y2 * Math.sin(roll), X1 * Math.sin(roll) + Y2 * Math.cos(roll)];
      const k = D / (D - Z2);
      return { x: P.x + X3 * k, y: P.y + Y3 * k };
    };
    for (const [i, pose] of [
      [1, { yaw: 0.1, pitch: 0, roll: 0 }],
      [10, { yaw: 0, pitch: -0.08, roll: 0 }],
      [152, { yaw: 0.05, pitch: 0.07, roll: 0.04 }],
      [33, { yaw: -0.12, pitch: 0.03, roll: -0.05 }],
    ] as [number, HeadPose3D][]) {
      const p = mesh.basePoints[i];
      const got = turn.project(p.x, p.y, turn.depth[i], pose);
      const want = by(p.x, p.y, turn.depth[i], pose);
      expect(got.x).toBeCloseTo(want.x, 9);
      expect(got.y).toBeCloseTo(want.y, 9);
    }
    // Yaw moves a point ahead of the pivot toward +x, and further the
    // further ahead it is; roll alone at the pivot's depth is a rotation in
    // the picture about the pivot.
    const nose = turn.project(P.x, P.y, P.z + turn.iod, { yaw: 0.1, pitch: 0, roll: 0 });
    const brow = turn.project(P.x, P.y, P.z + 0.5 * turn.iod, { yaw: 0.1, pitch: 0, roll: 0 });
    expect(nose.x - P.x).toBeGreaterThan(brow.x - P.x);
    expect(brow.x - P.x).toBeGreaterThan(0);
    const r = turn.project(P.x + 100, P.y, P.z, { yaw: 0, pitch: 0, roll: 0.1 });
    expect(r.x - P.x).toBeCloseTo(100 * Math.cos(0.1), 9);
    expect(r.y - P.y).toBeCloseTo(100 * Math.sin(0.1), 9);
  });

  it("moves the skull's point by the turn, for the rigid share", () => {
    const s = turn.skullShift({ yaw: 7 * DEG, pitch: 0, roll: 0 });
    expect(s.x).toBeGreaterThan(0.02 * turn.iod);
    expect(Math.abs(s.y)).toBeLessThan(0.01 * turn.iod);
    const nod = turn.skullShift({ yaw: 0, pitch: 5 * DEG, roll: 0 });
    expect(nod.y).toBeGreaterThan(0.01 * turn.iod);
  });
});

describe("HeadTurn on the face", () => {
  const outline = [...turn.basis.outline];

  it("is nothing at rest", () => {
    const pts = turned({});
    pts.forEach((_, i) => expect(moved(pts, i)).toBeLessThan(1e-9));
  });

  it("holds the outline where the rigid motion puts it, at every pose", () => {
    const L = POSE_LIMIT_DEG;
    for (const pose of [
      { yaw: L.yaw * DEG },
      { pitch: -L.pitch * DEG },
      { yaw: -L.yaw * DEG, pitch: L.pitch * DEG, roll: L.roll * DEG },
    ]) {
      const pts = turned(pose);
      for (const i of outline) expect(moved(pts, i)).toBeLessThan(1e-9);
    }
    // The outline is the face's edge above the jaw: the forehead, the
    // temples, down to the jaw line's ends below the ears.
    for (const i of [10, 234, 454, 93, 323]) expect(outline).toContain(i);
    for (const i of [152, 148, 377, 58, 288]) expect(outline).not.toContain(i);
  });

  it("turns the nose and the chin the way they are asked, the jaw line with them", () => {
    const right = turned({ yaw: 7 * DEG });
    expect(right[1].x - mesh.basePoints[1].x).toBeGreaterThan(0.05 * turn.iod);
    // The nose, well ahead of the outline, travels further than an eye.
    expect(right[1].x - mesh.basePoints[1].x).toBeGreaterThan(right[33].x - mesh.basePoints[33].x);
    const down = turned({ pitch: 5 * DEG });
    expect(down[1].y - mesh.basePoints[1].y).toBeGreaterThan(0.02 * turn.iod);
    // The chin nods with the face (the neck band takes it up below).
    expect(down[152].y - mesh.basePoints[152].y).toBeGreaterThan(0.004 * turn.iod);
    const up = turned({ pitch: -5 * DEG });
    expect(up[152].y).toBeLessThan(mesh.basePoints[152].y);
    for (const i of JAW_ARC.slice(4, -4)) expect(moved(right, i)).toBeGreaterThan(0);
  });

  it("carries none of what the rigid motion already moves when the outline moves with it", () => {
    // A pure shift of the head's frame, no turn: the outline and everything
    // inside it shift alike, so nothing is left for the mesh to do.
    const shift = { a: 1, b: 0, c: 0, d: 1, e: 3, f: -2 };
    const pts = rest();
    turn.apply(pts, { yaw: 1e-9, pitch: 0, roll: 0 }, shift, 0);
    pts.forEach((_, i) => expect(moved(pts, i)).toBeLessThan(1e-6));
  });

  it("adds up with the rigid motion to the turn, on the face's middle", () => {
    // The turn with the head's rigid share, and without: through the rigid
    // motion, the face's landmarks land where the turn alone puts them,
    // less only what the outline (which goes with the rigid motion) adds.
    const pose = { yaw: 6 * DEG, pitch: 2 * DEG, roll: 1 * DEG };
    const geom = { pivotX: turn.pivot.x, pivotY: mesh.basePoints[152].y + 200, bustPivotY: 0, bustReach: 1 };
    const s = turn.skullShift(pose);
    const rigid = headMotionAffine(geom, { dx: s.x * 0.5, dy: s.y * 0.5, roll: 0 }, false);
    const alone = turned(pose);
    const shared = turned(pose, rigid).map((p) => apply(rigid, p));
    // The nose's travel relative to the eyes is the turn's either way.
    const rel = (pts: Point[]) => pts[1].x - (pts[33].x + pts[263].x) / 2;
    expect(rel(shared)).toBeCloseTo(rel(alone), 0);
  });

  it("leaves the roll to the rigid motion: a tilt alone moves nothing inside the mesh", () => {
    const pts = turned({ roll: 3 * DEG });
    pts.forEach((_, i) => expect(moved(pts, i)).toBeLessThan(1e-9));
    // And the turn's yaw and pitch are the same whatever the roll.
    const a = turned({ yaw: 5 * DEG, pitch: 2 * DEG, roll: -3 * DEG });
    const b = turned({ yaw: 5 * DEG, pitch: 2 * DEG });
    a.forEach((p, i) => expect(p).toEqual(b[i]));
  });

  it("moves each eye as one piece", () => {
    const pts = turned({ yaw: -7 * DEG, pitch: 3 * DEG });
    for (let e = 0; e < 2; e++) {
      const [c0, c1] = EYE_CORNERS[e];
      const group = [c0, c1, ...UPPER_LIDS[e], ...LOWER_LIDS[e], IRISES[e][0], ...IRISES[e][1]];
      const d = (i: number) => [pts[i].x - mesh.basePoints[i].x, pts[i].y - mesh.basePoints[i].y];
      for (const i of group) {
        expect(d(i)[0]).toBeCloseTo(d(c0)[0], 9);
        expect(d(i)[1]).toBeCloseTo(d(c0)[1], 9);
      }
      expect(Math.hypot(...d(c0))).toBeGreaterThan(0);
    }
  });

  it("moves the lips as one piece, so the mouth the speech shaped keeps its shape", () => {
    // An open mouth (the lower lip dropped), then turned to a corner.
    const open = rest();
    for (const i of LOWER_ROWS.flat()) open[i].y += 0.08 * turn.iod;
    const pts = open.map((p) => ({ ...p }));
    turn.apply(pts, { yaw: 7 * DEG, pitch: -5 * DEG, roll: 0 }, null, 0);
    const lips = [...new Set([...UPPER_ROWS.flat(), ...LOWER_ROWS.flat(), ...LIP_CORNERS])];
    const d0 = { x: pts[lips[0]].x - open[lips[0]].x, y: pts[lips[0]].y - open[lips[0]].y };
    expect(Math.hypot(d0.x, d0.y)).toBeGreaterThan(0);
    for (const i of lips) {
      expect(pts[i].x - open[i].x).toBeCloseTo(d0.x, 9);
      expect(pts[i].y - open[i].y).toBeCloseTo(d0.y, 9);
    }
  });

  it("folds nothing and keeps the whole turn at the personality's limits", () => {
    const L = POSE_LIMIT_DEG;
    for (const yaw of [-L.yaw, 0, L.yaw]) {
      for (const pitch of [-L.pitch, 0, L.pitch]) {
        for (const roll of [-L.roll, L.roll]) {
          turned({ yaw: yaw * DEG, pitch: pitch * DEG, roll: roll * DEG });
          expect(turn.stats.flipsAfter).toBe(0);
          expect(turn.stats.scale).toBe(1);
          expect(turn.stats.minAreaRatio).toBeGreaterThan(0.2);
        }
      }
    }
  });

  it("scales a turn far past them back until nothing folds", () => {
    const pts = turned({ yaw: 45 * DEG, pitch: 25 * DEG });
    expect(turn.stats.flipsBefore).toBeGreaterThan(0);
    expect(turn.stats.flipsAfter).toBe(0);
    expect(turn.stats.scale).toBeLessThan(1);
    expect(turn.stats.scale).toBeGreaterThan(0);
    expect(moved(pts, 1)).toBeGreaterThan(0);
  });

  it("raises the brows on an accent and leaves the outline and the eyes", () => {
    const pts = rest();
    turn.apply(pts, { yaw: 1e-9, pitch: 0, roll: 0 }, null, 1);
    expect(mesh.basePoints[105].y - pts[105].y).toBeGreaterThan(0.01 * turn.iod);
    for (const i of [...turn.basis.outline, 159, 145]) expect(moved(pts, i)).toBeLessThan(1e-6);
  });
});

describe("the outline's harmonic weights", () => {
  const { outline, free, weights } = turn.basis;
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
    const tris = rig.triangles.filter((t) => t.every((i) => i < other.basePoints.length));
    const b = outlineBasis(other.basePoints, tris);
    expect([...b.outline]).toEqual([...outline]);
    expect([...b.free]).toEqual([...free]);
    for (let k = 0; k < weights.length; k += 37) expect(b.weights[k]).toBeCloseTo(weights[k], 9);
    const again = HeadTurn.build(other, rig.triangles, turn.basis)!;
    expect(again.basis).toBe(turn.basis);
  });
});
