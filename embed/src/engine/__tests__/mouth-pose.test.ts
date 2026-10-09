import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { Rig } from "../../types";
import { layOutFace, refineMesh, type Point } from "../geometry";
import type { HeadPose3D } from "../head-camera";
import { CANON_IOD_CM } from "../head-depth";
import { HeadTurn } from "../head-turn";
import { LIP_FRAME, MouthPose } from "../mouth-pose";
import { headMotionAffine } from "../render2d";

/**
 * The mouth's frame under the turn in depth (mouth-pose.ts) on the human
 * fixture: the rest pose moved as the turn moved each landmark, and what
 * lies behind the lips seen with them, less the parallax of its depth.
 */
const rig = JSON.parse(
  readFileSync(new URL("../../__tests__/fixtures/human-rig.json", import.meta.url), "utf8")
) as Rig;
const [W, H] = rig.image_size;
const image = { naturalWidth: W, naturalHeight: H, width: W, height: H } as HTMLImageElement;
const mesh = layOutFace(rig, image, { width: 960, height: 960 }, 1, undefined);
refineMesh(mesh, rig, image);
const base = mesh.basePoints;
const DEG = Math.PI / 180;

/** A fresh turn and mouth pose, the face turned by `pose` (degrees). */
function turnedBy(pose: Partial<HeadPose3D>, rigid: Parameters<HeadTurn["apply"]>[2] = null) {
  const turn = HeadTurn.build(mesh, rig.triangles)!;
  const pts = base.map((p) => ({ x: p.x, y: p.y }));
  const rad = { yaw: (pose.yaw ?? 0) * DEG, pitch: (pose.pitch ?? 0) * DEG, roll: 0 };
  turn.apply(pts, rad, rigid, 0);
  const posed = new MouthPose().pose(turn, base)!;
  return { turn, pts, posed };
}
const lips = (pts: readonly Point[]) => ({ x: (pts[13].x + pts[14].x) / 2, y: (pts[13].y + pts[14].y) / 2 });

describe("the mouth's frame under the turn", () => {
  it("is nothing before the face has turned", () => {
    const turn = HeadTurn.build(mesh, rig.triangles)!;
    expect(new MouthPose().pose(turn, base)).toBeNull();
  });

  it("is the rest pose moved as the turn moved each landmark", () => {
    const { pts, posed } = turnedBy({ yaw: 7, pitch: 3 });
    expect(posed.neutral).toHaveLength(base.length);
    for (const i of [13, 14, 61, 291, 1, 152, 33]) {
      expect(posed.neutral[i].x).toBeCloseTo(pts[i].x, 9);
      expect(posed.neutral[i].y).toBeCloseTo(pts[i].y, 9);
    }
  });

  it("reports the turn as far as the face turned, and a millimetre of the face", () => {
    const { turn, posed } = turnedBy({ yaw: -7, pitch: 4 });
    const share = turn.stats.scale;
    expect(posed.turn.yaw).toBeCloseTo(-7 * DEG * share, 12);
    expect(posed.turn.pitch).toBeCloseTo(4 * DEG * share, 12);
    expect(posed.turn.mm).toBeCloseTo(turn.iod / (10 * CANON_IOD_CM), 12);
  });

  it("is reused from frame to frame", () => {
    const turn = HeadTurn.build(mesh, rig.triangles)!;
    const mouth = new MouthPose();
    const pts = base.map((p) => ({ x: p.x, y: p.y }));
    turn.apply(pts, { yaw: 0.1, pitch: 0, roll: 0 }, null, 0);
    const first = mouth.pose(turn, base)!;
    turn.apply(pts, { yaw: -0.1, pitch: 0, roll: 0 }, null, 0);
    const second = mouth.pose(turn, base)!;
    expect(second).toBe(first);
    expect(second.neutral).toBe(first.neutral);
  });
});

describe("a point behind the lips", () => {
  const out: Point = { x: 0, y: 0 };

  it("is the point itself at the lips' depth", () => {
    const { posed } = turnedBy({ yaw: 7, pitch: -4 });
    const at = lips(posed.neutral);
    expect(posed.turn.behindLips(out, at.x, at.y, 0)).toEqual(at);
    expect(posed.turn.behindLips(out, at.x + 30, at.y + 5, 0)).toEqual({ x: at.x + 30, y: at.y + 5 });
  });

  it("is the point itself, at any depth, while the head faces the camera", () => {
    const { posed } = turnedBy({});
    const at = lips(posed.neutral);
    const q = posed.turn.behindLips(out, at.x + 20, at.y, 40);
    expect(Math.abs(q.x - at.x - 20)).toBeLessThan(1e-9);
    expect(Math.abs(q.y - at.y)).toBeLessThan(1e-9);
  });

  it("turns with the lips less, by its depth: a yaw lags it, a nod lifts it", () => {
    const depth = 10;
    for (const yaw of [7, -7]) {
      const { posed } = turnedBy({ yaw });
      const at = lips(posed.neutral);
      const mm = posed.turn.mm;
      const q = posed.turn.behindLips(out, at.x, at.y, depth * mm);
      // yaw + turns the nose to the canvas's right: what is 10 mm behind
      // the lips goes right by about 10 mm * sin(7 deg) less.
      const lag = (at.x - q.x) * Math.sign(yaw);
      const expected = depth * mm * Math.sin(7 * DEG);
      expect(lag).toBeGreaterThan(0.8 * expected);
      // More by the perspective: the lips are nearer the camera than the pivot.
      expect(lag).toBeLessThan(1.3 * expected);
      expect(Math.abs(q.y - at.y)).toBeLessThan(0.1 * expected);
    }
    // Nodding down, it drops less than the lips.
    const { posed } = turnedBy({ pitch: 5 });
    const at = lips(posed.neutral);
    const q = posed.turn.behindLips(out, at.x, at.y, depth * posed.turn.mm);
    expect(at.y - q.y).toBeGreaterThan(0.8 * depth * posed.turn.mm * Math.sin(5 * DEG));
  });

  it("moves continuously with the turn, from nothing", () => {
    const parallax = (yaw: number) => {
      const { posed } = turnedBy({ yaw });
      const at = lips(posed.neutral);
      return posed.turn.behindLips(out, at.x, at.y, 12 * posed.turn.mm).x - at.x;
    };
    const small = parallax(0.01);
    expect(Math.abs(small)).toBeLessThan(0.02);
    expect(parallax(0.02) / small).toBeCloseTo(2, 2);
    expect(parallax(1) / small).toBeCloseTo(100, 0);
  });

  it("is seen through the rigid motion the turn took out", () => {
    // A cut-out's bust leans by a share of the turn: what the turn adds is
    // in the head's frame, under that lean.
    const geom = { pivotX: 480, pivotY: 400, bustPivotY: 900, bustReach: 300 };
    const lean = headMotionAffine(geom, { dx: 12, dy: 4, roll: 0 }, true);
    const plain = turnedBy({ yaw: 7 });
    const leaning = turnedBy({ yaw: 7 }, lean);
    const at = lips(plain.posed.neutral);
    const d = 10 * plain.posed.turn.mm;
    const a = { ...plain.posed.turn.behindLips(out, at.x, at.y, d) };
    const lat = lips(leaning.posed.neutral);
    const b = leaning.posed.turn.behindLips(out, lat.x, lat.y, d);
    // The lean undone (its linear part: a shear and a squash) on the
    // plain parallax is the leaning one's, to the shift of the lips.
    const back = leaning.turn.applied()!.back!;
    const dx = a.x - at.x,
      dy = a.y - at.y;
    expect(b.x - lat.x).toBeCloseTo(back.a * dx + back.c * dy, 1);
    expect(b.y - lat.y).toBeCloseTo(back.b * dx + back.d * dy, 1);
    expect(back.c).not.toBe(0);
  });

  it("carries the mouth's frame by the lips' own shift", () => {
    const { pts, posed } = turnedBy({ yaw: 5, pitch: 2 });
    for (const i of LIP_FRAME) {
      expect(posed.neutral[i].x - base[i].x).toBeCloseTo(pts[i].x - base[i].x, 9);
    }
  });
});
