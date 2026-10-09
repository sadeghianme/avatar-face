import { describe, expect, it } from "vitest";

import type { Point } from "../affine";
import { MIN_SOURCE_DET, buildWarpMesh } from "../warp-mesh";

/**
 * The GPU warp's static mesh (warp-mesh.ts): the triangles the 2D path
 * draws, in its order, without the ones it skips. Against a real rig's mesh
 * in warp-gl.test.ts.
 */
describe("the mesh buffers", () => {
  it("keep every triangle the 2D path draws, in its order, and skip the ones it skips", () => {
    const tex: Point[] = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 0, y: 100 },
      { x: 100, y: 100 },
      // Three on a line: a degenerate source triangle.
      { x: 200, y: 200 },
      { x: 210, y: 210 },
      { x: 220, y: 220 },
    ];
    const triangles: [number, number, number][] = [
      [0, 1, 2],
      [4, 5, 6],
      [1, 3, 2],
      [2, 1, 0],
    ];
    const mesh = buildWarpMesh(tex, triangles, 200, 400);
    expect(mesh.count).toBe(3);
    expect(mesh.skipped).toBe(1);
    expect(Array.from(mesh.indices)).toEqual([0, 1, 2, 1, 3, 2, 2, 1, 0]);
    // Texture coordinates over the texture's own size.
    expect(Array.from(mesh.uv.slice(0, 8))).toEqual([0, 0, 0.5, 0, 0, 0.25, 0.5, 0.25]);
    expect(mesh.indices).toBeInstanceOf(Uint16Array);
  });

  it("use the 2D path's own degeneracy threshold", () => {
    const tiny = MIN_SOURCE_DET / 4;
    const tex: Point[] = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: tiny },
    ];
    expect(buildWarpMesh(tex, [[0, 1, 2]], 10, 10).count).toBe(0);
    const okay: Point[] = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: MIN_SOURCE_DET * 4 },
    ];
    expect(buildWarpMesh(okay, [[0, 1, 2]], 10, 10).count).toBe(1);
  });
});
