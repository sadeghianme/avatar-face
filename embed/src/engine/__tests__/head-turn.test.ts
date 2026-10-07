import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { Cue, Rig } from "../../types";
import { layOutFace, refineMesh, type Point } from "../geometry";
import { HeadPersonality, POSE_LIMIT_DEG, readSpeech } from "../head-personality";
import { HeadTurn } from "../head-turn";

/**
 * The "3d" head motion's prototype (head-turn.ts, head-personality.ts) on
 * the human fixture: the turn is nothing at rest, never moves the mesh's
 * outer edge, turns the nose the way it is asked and folds no triangle at
 * the pose limits; the personality is reproducible and stays in range.
 */
const rig = JSON.parse(
  readFileSync(new URL("../../__tests__/fixtures/human-rig.json", import.meta.url), "utf8")
) as Rig;
const [W, H] = rig.image_size;
const image = { naturalWidth: W, naturalHeight: H, width: W, height: H } as HTMLImageElement;
const mesh = layOutFace(rig, image, { width: 960, height: 960 }, 1, undefined);
refineMesh(mesh, rig, image);
const turn = HeadTurn.build(mesh, rig.triangles)!;
const DEG = Math.PI / 180;
const rest = () => mesh.basePoints.map((p) => ({ x: p.x, y: p.y }));

describe("HeadTurn", () => {
  it("fits a depth with the nose ahead of the cheeks", () => {
    expect(turn).not.toBeNull();
    expect(turn.depth[1]).toBeGreaterThan(turn.depth[234] + 0.5 * turn.iod);
    expect(turn.depth[1]).toBeGreaterThan(turn.depth[454] + 0.5 * turn.iod);
  });

  it("is nothing at rest", () => {
    const pts = rest();
    turn.apply(pts, { yaw: 0, pitch: 0, roll: 0 }, null, 0);
    pts.forEach((p, i) => {
      expect(p.x).toBeCloseTo(mesh.basePoints[i].x, 6);
      expect(p.y).toBeCloseTo(mesh.basePoints[i].y, 6);
    });
  });

  it("turns the nose and leaves the outer edge where it is", () => {
    const pts = rest();
    turn.apply(pts, { yaw: 10 * DEG, pitch: 0, roll: 0 }, null, 0);
    expect(pts[1].x - mesh.basePoints[1].x).toBeGreaterThan(0.08 * turn.iod);
    // The forehead's top and the temples are on the hull.
    for (const i of [10, 234, 454]) {
      expect(Math.hypot(pts[i].x - mesh.basePoints[i].x, pts[i].y - mesh.basePoints[i].y)).toBeLessThan(1e-6);
    }
    const down = rest();
    turn.apply(down, { yaw: 0, pitch: 6 * DEG, roll: 0 }, null, 0);
    expect(down[1].y - mesh.basePoints[1].y).toBeGreaterThan(0.04 * turn.iod);
  });

  it("folds no triangle at the pose limits", () => {
    const L = POSE_LIMIT_DEG;
    for (const yaw of [-L.yaw, L.yaw]) {
      for (const pitch of [-L.pitch, L.pitch]) {
        const pts: Point[] = rest();
        turn.apply(pts, { yaw: yaw * DEG, pitch: pitch * DEG, roll: L.roll * DEG }, null, 1);
        expect(turn.stats.flipsAfter).toBe(0);
      }
    }
  });
});

describe("HeadPersonality", () => {
  const cues = JSON.parse(
    readFileSync(new URL("../../__tests__/fixtures/native-cues-hello.json", import.meta.url), "utf8")
  ) as { cues: Cue[] } | Cue[];
  const track = Array.isArray(cues) ? cues : cues.cues;

  const run = () => {
    const p = new HeadPersonality(3);
    p.start(0);
    p.setSpeech(track);
    const out: number[] = [];
    for (let t = 16; t < 6000; t += 16) {
      p.update(16, t, t > 500 && t < 3500, 0.5, () => t - 500);
      out.push(p.pose.yaw, p.pose.pitch, p.pose.roll, p.gaze.x);
    }
    return out;
  };

  it("is reproducible and within its limits", () => {
    const a = run(),
      b = run();
    expect(a).toEqual(b);
    const L = POSE_LIMIT_DEG;
    for (let k = 0; k < a.length; k += 4) {
      expect(Math.abs(a[k])).toBeLessThanOrEqual(L.yaw * DEG + 1e-9);
      expect(Math.abs(a[k + 1])).toBeLessThanOrEqual(L.pitch * DEG + 1e-9);
      expect(Math.abs(a[k + 2])).toBeLessThanOrEqual(L.roll * DEG + 1e-9);
      expect(Math.abs(a[k + 3])).toBeLessThanOrEqual(0.6 + 1e-9);
    }
    // It moves.
    expect(Math.max(...a.filter((_, k) => k % 4 === 0)) - Math.min(...a.filter((_, k) => k % 4 === 0))).toBeGreaterThan(
      DEG
    );
  });

  it("reads phrases and accents off a cue track", () => {
    const s = readSpeech(track);
    expect(s.phrases.length).toBeGreaterThan(0);
    for (const p of s.phrases) expect(p.end).toBeGreaterThan(p.start);
  });
});
