import { createCanvas } from "@napi-rs/canvas";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { FaceMesh, Point } from "../geometry";
import { POSE_LIMIT_DEG } from "../head-personality";
import { HeadTurn } from "../head-turn";
import { DEG, meshFor, portraits, rig } from "./head-fixtures";

/**
 * The head's field turned with the face (head-field-turn.ts, through
 * HeadTurn.field): its outline with the turn, its ends and its outer edge
 * still, its vertices fading out toward the silhouette, none of its
 * triangles folding, and a narrow band of hair capping the outline's
 * travel.
 */
let photo: HTMLImageElement;
beforeAll(async () => {
  ({ photo } = await portraits());
});

describe("the head's field, turning", () => {
  let mesh: FaceMesh;
  let head: NonNullable<FaceMesh["head"]>;
  let turn: HeadTurn;
  beforeAll(() => {
    vi.stubGlobal("document", { createElement: () => createCanvas(300, 150) });
    mesh = meshFor(photo, false);
    head = mesh.head!;
    turn = HeadTurn.build(mesh, rig.triangles)!;
    vi.unstubAllGlobals();
  });
  const L = POSE_LIMIT_DEG;
  const rest = () => mesh.basePoints.map((p) => ({ x: p.x, y: p.y }));
  /** The frame's every vertex the field reads (the landmarks turned, the
   *  midpoints and the band where they rest), the field pushed after. */
  const turned = (yaw: number, pitch: number) => {
    const pts = rest();
    turn.apply(pts, { yaw: yaw * DEG, pitch: pitch * DEG, roll: 0 }, null, 0);
    const base = mesh.basePoints;
    for (const [a, b] of mesh.derivedParents)
      pts.push({ x: (base[a].x + base[b].x) / 2, y: (base[a].y + base[b].y) / 2 });
    for (const v of mesh.neckBand) pts.push({ ...v.base });
    turn.field(pts);
    return pts;
  };
  const restOf = (i: number): Point =>
    i < mesh.basePoints.length
      ? mesh.basePoints[i]
      : i >= head.first
        ? head.vertices[i - head.first].base
        : mesh.neckBand[i - mesh.basePoints.length - mesh.derivedParents.length].base;
  const moved = (pts: Point[], i: number) => Math.hypot(pts[i].x - restOf(i).x, pts[i].y - restOf(i).y);

  it("rests where it rests", () => {
    const pts = rest();
    for (const [a, b] of mesh.derivedParents) pts.push({ x: (pts[a].x + pts[b].x) / 2, y: (pts[a].y + pts[b].y) / 2 });
    for (const v of mesh.neckBand) pts.push({ ...v.base });
    turn.field(pts, true);
    for (let i = head.first; i < head.first + head.count; i++) expect(moved(pts, i)).toBe(0);
  });

  it("takes the face's outline with the turn, and holds its ends below the ears", () => {
    const pts = turned(L.yaw, 0);
    // The forehead's top travels with the face, toward the turn.
    expect(pts[10].x - mesh.basePoints[10].x).toBeGreaterThan(0.05 * turn.iod);
    for (const i of [234, 454, 93, 323]) expect(moved(pts, i)).toBeLessThan(1e-9);
    // A nod takes the forehead down with the face.
    const down = turned(0, L.pitch);
    expect(down[10].y - mesh.basePoints[10].y).toBeGreaterThan(0.02 * turn.iod);
  });

  it("ends still: its outer edge, and the neck band's end columns", () => {
    for (const [yaw, pitch] of [
      [L.yaw, L.pitch],
      [-L.yaw, -L.pitch],
      [L.yaw, 0],
    ]) {
      const pts = turned(yaw, pitch);
      for (const s of head.spokes) expect(moved(pts, s.vertices[s.vertices.length - 1])).toBeLessThan(1e-9);
      for (const i of [...head.spokes[0].vertices, ...head.spokes[head.spokes.length - 1].vertices])
        expect(moved(pts, i)).toBeLessThan(1e-9);
    }
  });

  it("goes with the outline at the hairline and fades out toward the silhouette, the way a turning skull's surface does", () => {
    const pts = turned(L.yaw, 0);
    const top = head.spokes.find((s) => s.landmark === 10)!;
    const along = top.vertices.map((i) => moved(pts, i));
    // Near the outline the hair moves nearly as the forehead does...
    expect(along[1]).toBeGreaterThan(0.6 * along[0]);
    // ...and less and less further out, to nothing where the field ends.
    for (let m = 1; m < along.length; m++) expect(along[m]).toBeLessThanOrEqual(along[m - 1] + 1e-9);
    expect(along[along.length - 1]).toBe(0);
  });

  it("folds none of its triangles and keeps most of the outline's travel at the limits", () => {
    for (const yaw of [-L.yaw, 0, L.yaw]) {
      for (const pitch of [-L.pitch, 0, L.pitch]) {
        if (!yaw && !pitch) continue;
        turned(yaw, pitch);
        expect(turn.stats.headMinAreaRatio).toBeGreaterThan(0.4);
        expect(turn.stats.scale).toBe(1);
        // The temples' band of hair is narrow on this portrait: at the
        // corners its cap keeps four fifths of their travel.
        expect(turn.stats.headMinShare).toBeGreaterThan(0.75);
      }
    }
  });

  it("caps what a narrow band of hair is asked to take", () => {
    // Far past the limits, the outline would cross the hair's band: its
    // travel is held to what the band takes.
    turned(30, 0);
    expect(turn.stats.headCapped).toBeGreaterThan(0);
    expect(turn.stats.headMinShare).toBeLessThan(1);
    expect(turn.stats.headMinAreaRatio).toBeGreaterThan(0);
  });
});
