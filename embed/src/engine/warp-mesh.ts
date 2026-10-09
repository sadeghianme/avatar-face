/**
 * The static half of the GPU warp's mesh (warp-gl.ts): every vertex's
 * texture coordinate and the triangle list, in the order the 2D path draws
 * it and without the triangles it would skip. Built once per geometry;
 * only the positions change per frame.
 */
import type { Point } from "./affine";

/** The 2D path skips a source triangle this degenerate (drawWarpedTriangle). */
export const MIN_SOURCE_DET = 1e-6;

export interface WarpMesh {
  /** Texture coordinates, normalised 0..1, two per vertex. */
  uv: Float32Array;
  /** Triangle corners, three per triangle, in the 2D path's draw order. */
  indices: Uint16Array | Uint32Array;
  /** Triangles drawn. */
  count: number;
  /** Triangles left out for a degenerate source, as the 2D path leaves them. */
  skipped: number;
  /** Triangles drawn before the head's field's (all of them without one). */
  headFrom: number;
}

/**
 * The mesh for `texPoints` (texture px) over a `textureWidth` x
 * `textureHeight` texture. `headFrom`: where the head's field's triangles
 * start in `triangles` (head-field.ts), drawn only when some of it moved.
 */
export function buildWarpMesh(
  texPoints: readonly Point[],
  triangles: readonly (readonly [number, number, number])[],
  textureWidth: number,
  textureHeight: number,
  headFrom = triangles.length
): WarpMesh {
  const n = texPoints.length;
  const uv = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    uv[i * 2] = texPoints[i].x / textureWidth;
    uv[i * 2 + 1] = texPoints[i].y / textureHeight;
  }
  const kept: number[] = [];
  let skipped = 0;
  let before = -1;
  for (let t = 0; t < triangles.length; t++) {
    if (t === headFrom) before = kept.length / 3;
    const [i0, i1, i2] = triangles[t];
    const s0 = texPoints[i0],
      s1 = texPoints[i1],
      s2 = texPoints[i2];
    if (!s0 || !s1 || !s2) {
      skipped++;
      continue;
    }
    const det = s0.x * (s1.y - s2.y) + s1.x * (s2.y - s0.y) + s2.x * (s0.y - s1.y);
    if (Math.abs(det) < MIN_SOURCE_DET) {
      skipped++;
      continue;
    }
    kept.push(i0, i1, i2);
  }
  const indices = n <= 0xffff ? Uint16Array.from(kept) : Uint32Array.from(kept);
  const count = kept.length / 3;
  return { uv, indices, count, skipped, headFrom: before < 0 ? count : before };
}
