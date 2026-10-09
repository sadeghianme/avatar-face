/**
 * The mesh ends at the jaw line, and the picture under it is drawn still.
 * A chin that now drops a fifth of a mouth width therefore ended on the
 * neck as a step: the lit chin skin cut off against the shadow it had left
 * behind. Two rings of derived vertices below the jaw line, from pivot to
 * pivot, mend that: the inner ring travels with the jaw (most of its way,
 * so the chin keeps its own shadow), the outer ring stands still where the
 * still picture begins, and the neck skin between them stretches, as skin
 * under a jaw does, instead of being overdrawn. Offsets in mouth widths
 * along the jaw line's outward normal.
 *
 * The band is part of the face mesh (geometry.ts), drawn with it; the
 * deformation places it each frame by its parents (deform.ts).
 */
import { JAW_ARC_LEFT, JAW_ARC_RIGHT, mouthFrame, type Pt } from "./jaw-rig";

/** The rings below the jaw line, in mouth widths, and the share of the
 *  jaw's motion the inner one takes (the outer: none). */
export const NECK_BAND = { inner: 0.3, innerShare: 0.65, outer: 0.8 } as const;

/** The jaw's arc of the oval, left pivot to right pivot through the chin. */
export const JAW_ARC = [...JAW_ARC_LEFT].reverse().concat(JAW_ARC_RIGHT.slice(1));

export interface NeckVertex {
  x: number;
  y: number;
  /** The jaw-line vertex this one hangs from, and the share of its motion
   *  it takes (0: still). */
  parent: number;
  share: number;
}
export interface NeckBand {
  vertices: NeckVertex[];
  triangles: [number, number, number][];
}

/**
 * The band for a rest mesh, its vertices numbered from `firstIndex` on
 * (after the mesh's own and any other derived vertices).
 */
export function buildNeckBand(rest: readonly Pt[], firstIndex: number): NeckBand {
  const f = mouthFrame(rest);
  const arc = JAW_ARC.filter((i) => i < rest.length);
  const n = arc.length;
  const vertices: NeckVertex[] = [];
  const triangles: [number, number, number][] = [];
  if (n < 3) return { vertices, triangles };
  const rings = [
    { offset: NECK_BAND.inner * f.w, share: NECK_BAND.innerShare },
    { offset: NECK_BAND.outer * f.w, share: 0 },
  ];
  for (const ring of rings) {
    for (let k = 0; k < n; k++) {
      const p = rest[arc[k]];
      const prev = rest[arc[Math.max(0, k - 1)]],
        next = rest[arc[Math.min(n - 1, k + 1)]];
      // Outward normal of the jaw line: perpendicular to its direction here,
      // pointing away from the mouth.
      let nx = -(next.y - prev.y),
        ny = next.x - prev.x;
      const len = Math.hypot(nx, ny) || 1;
      nx /= len;
      ny /= len;
      if (nx * (p.x - f.cx) + ny * (p.y - f.cy) < 0) {
        nx = -nx;
        ny = -ny;
      }
      vertices.push({ x: p.x + nx * ring.offset, y: p.y + ny * ring.offset, parent: arc[k], share: ring.share });
    }
  }
  const inner = (k: number) => firstIndex + k,
    outer = (k: number) => firstIndex + n + k;
  for (let k = 0; k + 1 < n; k++) {
    triangles.push([arc[k], arc[k + 1], inner(k + 1)], [arc[k], inner(k + 1), inner(k)]);
    triangles.push([inner(k), inner(k + 1), outer(k + 1)], [inner(k), outer(k + 1), outer(k)]);
  }
  return { vertices, triangles };
}
