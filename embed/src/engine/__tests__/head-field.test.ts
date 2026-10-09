import { createCanvas } from "@napi-rs/canvas";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AvatarEngine } from "../../engine";
import { NoopPath } from "../../__tests__/browser-fakes";
import { layOutFace, refineMesh, type Point } from "../geometry";
import { outlineArc } from "../head-field";
import { engineSeam } from "../seam";
import { SIZE, meshFor, portraits, rig, stubCanvasDocument } from "./head-fixtures";

/**
 * The head's field (head-field.ts): the hair, the ears and the head's
 * outline as a ring of triangles around the face mesh, laid from the
 * face's outline out to where the picture says the head ends
 * (head-extent.test.ts), and laid by the engine for the turn in depth
 * only (its turning: head-field-turn.test.ts).
 */
let photo: HTMLImageElement;
beforeAll(async () => {
  ({ photo } = await portraits());
});
beforeEach(stubCanvasDocument);
afterEach(() => vi.unstubAllGlobals());

describe("the head's field, laid", () => {
  it("starts at the face's outline from 234 over the top to 454, and ends at the neck band's end columns", () => {
    const arc = outlineArc(rig.triangles, rig.points.length)!;
    expect(arc[0]).toBe(234);
    expect(arc[arc.length - 1]).toBe(454);
    expect(arc).toContain(10);
    expect(arc).not.toContain(152);
    const mesh = meshFor(photo, false);
    const head = mesh.head!;
    expect(head).toBeDefined();
    expect(head.spokes.map((s) => s.landmark)).toEqual(arc);
    // Its own vertices come after the neck band's, four to a spoke between
    // the ends, each with its texture position.
    const bandFirst = mesh.basePoints.length + mesh.derivedParents.length;
    expect(head.first).toBe(bandFirst + mesh.neckBand.length);
    expect(head.count).toBe((arc.length - 2) * 4);
    expect(mesh.texPoints).toHaveLength(head.first + head.count);
    // The ends are the band's end columns: 234 and its inner and outer
    // vertices, 454 and its.
    const n = mesh.neckBand.length / 2;
    expect(head.spokes[0].vertices).toEqual([234, bandFirst, bandFirst + n]);
    expect(head.spokes[arc.length - 1].vertices).toEqual([454, bandFirst + n - 1, bandFirst + 2 * n - 1]);
    // Each texture position is the picture's pixel under the vertex at rest.
    const tw = photo.naturalWidth / rig.image_size[0];
    head.vertices.forEach((v, j) => {
      const t = mesh.texPoints[head.first + j];
      expect(((v.base.x - mesh.offsetX) / mesh.scale) * tw).toBeCloseTo(t.x, 6);
    });
  });

  it("gives every one of its triangles a vertex of its own, and leaves the face's as they were", () => {
    const bare = layOutFace(rig, photo, { width: SIZE, height: SIZE }, 0.5, undefined);
    refineMesh(bare, rig, photo);
    const mesh = meshFor(photo, false);
    const head = mesh.head!;
    expect(mesh.triangles.slice(0, head.triangleFrom)).toEqual(bare.triangles);
    const own = mesh.triangles.slice(head.triangleFrom);
    expect(own.length).toBeGreaterThan(head.count);
    for (const t of own) expect(Math.max(...t)).toBeGreaterThanOrEqual(head.first);
    // None of them stands on its head at rest: wound one way, none
    // degenerate.
    const at = (i: number): Point =>
      i < mesh.basePoints.length
        ? mesh.basePoints[i]
        : i >= head.first
          ? head.vertices[i - head.first].base
          : mesh.neckBand[i - mesh.basePoints.length - mesh.derivedParents.length].base;
    for (const [a, b, c] of own) {
      const [p, q, r] = [a, b, c].map(at);
      expect((q.x - p.x) * (r.y - p.y) - (r.x - p.x) * (q.y - p.y)).toBeGreaterThan(0);
    }
  });
});

describe("the engine lays the head's field", () => {
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    vi.stubGlobal("Path2D", NoopPath);
  });

  it("for the turn in depth only: a person's photo has it, the rigid layer and a cartoon do not", () => {
    const canvas = createCanvas(SIZE, SIZE) as unknown as HTMLCanvasElement;
    const person = new AvatarEngine(canvas, structuredClone(rig), photo, { warp: "2d", faceType: "human" });
    expect(engineSeam(person).mesh.head).toBeDefined();
    person.setHeadMotion("2d");
    expect(engineSeam(person).mesh.head).toBeUndefined();
    person.setHeadMotion("3d");
    expect(engineSeam(person).mesh.head).toBeDefined();
    person.destroy();
    const cartoon = new AvatarEngine(canvas, structuredClone(rig), photo, { warp: "2d", faceType: "cartoon" });
    expect(cartoon.headMotion()).toBe("2d");
    expect(engineSeam(cartoon).mesh.head).toBeUndefined();
    cartoon.destroy();
  });
});
