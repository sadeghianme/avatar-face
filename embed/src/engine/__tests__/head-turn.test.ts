import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { Rig } from "../../types";
import { layOutFace, refineMesh, type Point } from "../geometry";
import { POSE_LIMIT_DEG } from "../head-personality";
import { CAMERA_IOD, projectTurn, type HeadPose3D } from "../head-camera";
import { HeadTurn } from "../head-turn";
import { LIP_CORNERS, LOWER_ROWS, UPPER_ROWS } from "../jaw-rig";
import { EYE_CORNERS, IRISES, LOWER_LIDS, UPPER_LIDS } from "../landmarks";
import { headMotionAffine } from "../render2d";
import { apply } from "../affine";
import { JAW_ARC } from "../neck-band";

/**
 * The head's turn in depth (head-turn.ts) on the human fixture: nothing at
 * rest, an outline that never moves in the head's frame while the chin and
 * the nose turn, each eye and the lips as one piece, and the fold clamp,
 * which the personality's limits never reach. The camera, the depth and the
 * outline's weights have their own tests (head-camera, head-depth,
 * head-outline).
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
  it("projects through the camera about its pivot, nine eye distances away", () => {
    const pose = { yaw: 0.05, pitch: 0.07, roll: 0.04 };
    for (const i of [1, 10, 152, 33]) {
      const p = mesh.basePoints[i];
      const want = projectTurn({ x: 0, y: 0 }, p.x, p.y, turn.depth[i], pose, turn.pivot, CAMERA_IOD * turn.iod);
      expect(turn.project(p.x, p.y, turn.depth[i], pose)).toEqual(want);
    }
  });

  it("moves the skull's point by the turn, for the rigid share", () => {
    const s = turn.skullShift({ yaw: 7 * DEG, pitch: 0, roll: 0 });
    expect(s.x).toBeGreaterThan(0.02 * turn.iod);
    expect(Math.abs(s.y)).toBeLessThan(0.01 * turn.iod);
    const nod = turn.skullShift({ yaw: 0, pitch: 5 * DEG, roll: 0 });
    expect(nod.y).toBeGreaterThan(0.01 * turn.iod);
  });
});

describe("HeadTurn.applied", () => {
  it("is nothing before the first apply", () => {
    expect(HeadTurn.build(mesh, rig.triangles)!.applied()).toBeNull();
  });

  it("is what the last apply did: each landmark's shift, the turn, its share, the rigid motion undone", () => {
    const pose = { yaw: 6 * DEG, pitch: -3 * DEG, roll: 2 * DEG };
    const pts = turned(pose);
    const last = turn.applied()!;
    for (const i of [1, 13, 61, 152, 234]) {
      expect(last.shift[2 * i]).toBeCloseTo(pts[i].x - mesh.basePoints[i].x, 9);
      expect(last.shift[2 * i + 1]).toBeCloseTo(pts[i].y - mesh.basePoints[i].y, 9);
    }
    // The roll is the rigid motion's: the turn asked has none.
    expect(last.pose).toEqual({ yaw: pose.yaw, pitch: pose.pitch, roll: 0 });
    expect(last.share).toBe(turn.stats.scale);
    expect(last.back).toBeNull();
    const geom = { pivotX: 480, pivotY: 400, bustPivotY: 900, bustReach: 300 };
    turned(pose, headMotionAffine(geom, { dx: 9, dy: 3, roll: 0 }, false));
    const back = turn.applied()!.back!;
    expect(back.e).toBeCloseTo(-9, 9);
    expect(back.f).toBeCloseTo(-3, 9);
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

describe("the outline's weights", () => {
  it("are built once per rig: a turn for another viewport takes the same", () => {
    const other = layOutFace(rig, image, { width: 480, height: 480 }, 0.4, undefined);
    refineMesh(other, rig, image);
    const again = HeadTurn.build(other, rig.triangles, turn.basis)!;
    expect(again.basis).toBe(turn.basis);
  });
});
