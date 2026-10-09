/**
 * The face mesh's outline, for the turn in depth (head-turn.ts). Without
 * the head's field the mesh's outer edge borders pixels that do not turn
 * (the hair, the ears, the background, the rigid layer around it), so it
 * must stay where the rigid motion puts it, and the face inside must meet
 * it without a step. A real turn moves the outline too: at 7 degrees of yaw
 * the forehead's top, well in front of the pivot, travels a tenth of an eye
 * distance, the temples a quarter of that. The prototype faded every
 * landmark's turn to nothing over a band 0.42 eye distances wide, so all of
 * that travel was undone inside the band: the forehead and the temples
 * sheared and stretched at the larger turns. The turn takes out only the
 * outline's own travel, and smoothly: the correction is the harmonic
 * extension of the outline's displacement over the mesh (each interior
 * landmark the weighted mean of its neighbours', the outline's held), so
 * the face keeps every difference of the turn between its parts (the nose
 * sweeping across the cheeks, the far cheek widening, the near one
 * narrowing), and loses only the share of the whole face's travel that the
 * outline could not take, spread over the whole face instead of a band. The
 * rigid motion carries that travel where it can.
 *
 * The jaw line is not outline: the neck band (neck-band.ts) hangs below it
 * and is drawn with the mesh, so the chin turns and nods with the face and
 * the band's neck skin takes up the difference down to its still bottom
 * edge. (Held, the jaw squeezed the lower face on every nod.) Only the jaw
 * line's two landmarks below each ear, where the band meets the hair, are
 * outline.
 */
import type { Point } from "./geometry";
import { JAW_ARC } from "./neck-band";

/** The jaw line from one jaw angle to the other, through the chin: inside
 *  the drawn mesh (the neck band hangs from it), so free to turn. Its two
 *  landmarks below each ear stay outline: the band meets the hair there,
 *  and a jaw point turned against the ear's held one crushed the cheek's
 *  last triangles. */
const FREE_JAW = new Set(JAW_ARC.slice(2, -2));

/**
 * The harmonic extension over a mesh's landmarks: per free landmark, its
 * weights over the outline's (they sum to 1), so that a value given on the
 * outline extends inside as smoothly as the mesh allows (the discrete
 * Laplace equation, each edge weighted by its inverse length). Depends on
 * the triangles and on the landmarks only up to a similarity, so one serves
 * every viewport of a rig.
 */
export interface OutlineBasis {
  /** The outline's landmarks. */
  readonly outline: Int32Array;
  /** The free landmarks (on an edge, not outline). */
  readonly free: Int32Array;
  /** free.length x outline.length, row by row. */
  readonly weights: Float64Array;
}

/**
 * The outline (the rig's triangles' boundary, less the jaw line the neck
 * band hangs from: its ends below the ears are kept) and the harmonic
 * weights of every other landmark on an edge over it. The Laplacian of the
 * free landmarks is factored once (Cholesky, its envelope after a reverse
 * Cuthill-McKee ordering: a few milliseconds) and solved for each outline
 * landmark's column. Built once per rig (the weights do not change with
 * the viewport).
 */
export function outlineBasis(
  base: readonly Point[],
  tris: readonly (readonly [number, number, number])[]
): OutlineBasis {
  const n = base.length;
  const edgeCount = new Map<number, number>();
  const key = (i: number, j: number) => Math.min(i, j) * 65536 + Math.max(i, j);
  const nb: Map<number, number>[] = Array.from({ length: n }, () => new Map());
  for (const [a, b, c] of tris) {
    for (const [i, j] of [
      [a, b],
      [b, c],
      [c, a],
    ]) {
      const k = key(i, j);
      edgeCount.set(k, (edgeCount.get(k) ?? 0) + 1);
      const w = 1 / Math.max(1e-6, Math.hypot(base[i].x - base[j].x, base[i].y - base[j].y));
      nb[i].set(j, w);
      nb[j].set(i, w);
    }
  }
  const onOutline = new Uint8Array(n);
  for (const [k, count] of edgeCount) {
    if (count !== 1) continue;
    const i = Math.floor(k / 65536),
      j = k % 65536;
    if (!FREE_JAW.has(i)) onOutline[i] = 1;
    if (!FREE_JAW.has(j)) onOutline[j] = 1;
  }
  const outline: number[] = [],
    free: number[] = [];
  for (let i = 0; i < n; i++) {
    if (onOutline[i]) outline.push(i);
    else if (nb[i].size) free.push(i);
  }
  const h = outline.length,
    m = free.length;
  // Reverse Cuthill-McKee over the free landmarks: a narrow envelope.
  const isFree = new Uint8Array(n);
  for (const i of free) isFree[i] = 1;
  const degree = (i: number) => {
    let d = 0;
    for (const j of nb[i].keys()) if (isFree[j]) d++;
    return d;
  };
  const order: number[] = [];
  const seen = new Uint8Array(n);
  const byDegree = [...free].sort((a, b) => degree(a) - degree(b));
  for (const start of byDegree) {
    if (seen[start]) continue;
    seen[start] = 1;
    const queue = [start];
    for (let q = 0; q < queue.length; q++) {
      const i = queue[q];
      order.push(i);
      const next = [...nb[i].keys()].filter((j) => isFree[j] && !seen[j]).sort((a, b) => degree(a) - degree(b));
      for (const j of next) {
        seen[j] = 1;
        queue.push(j);
      }
    }
  }
  order.reverse();
  const pos = new Int32Array(n).fill(-1);
  order.forEach((i, r) => (pos[i] = r));
  // The envelope: row r holds columns first[r] .. r.
  const first = new Int32Array(m);
  const start = new Int32Array(m + 1);
  for (let r = 0; r < m; r++) {
    let f = r;
    for (const j of nb[order[r]].keys()) if (isFree[j]) f = Math.min(f, pos[j]);
    first[r] = f;
    start[r + 1] = start[r] + (r - f + 1);
  }
  const L = new Float64Array(start[m]);
  const at = (r: number, c: number) => start[r] + (c - first[r]);
  for (let r = 0; r < m; r++) {
    const i = order[r];
    let total = 0;
    for (const [j, w] of nb[i]) {
      total += w;
      if (isFree[j] && pos[j] < r) L[at(r, pos[j])] = -w;
    }
    // A free landmark with no path to the outline still solves (to 0).
    L[at(r, r)] = total * (1 + 1e-13) + 1e-300;
  }
  for (let r = 0; r < m; r++) {
    for (let c = first[r]; c <= r; c++) {
      let sum = L[at(r, c)];
      const k0 = Math.max(first[r], first[c]);
      for (let k = k0; k < c; k++) sum -= L[at(r, k)] * L[at(c, k)];
      L[at(r, c)] = c === r ? Math.sqrt(Math.max(sum, 1e-300)) : sum / L[at(c, c)];
    }
  }
  // Each outline landmark's column: its free neighbours' right-hand side.
  const weights = new Float64Array(m * h);
  const x = new Float64Array(m);
  for (let k = 0; k < h; k++) {
    x.fill(0);
    for (const [j, w] of nb[outline[k]]) if (isFree[j]) x[pos[j]] += w;
    for (let r = 0; r < m; r++) {
      let sum = x[r];
      for (let c = first[r]; c < r; c++) sum -= L[at(r, c)] * x[c];
      x[r] = sum / L[at(r, r)];
    }
    for (let r = m - 1; r >= 0; r--) {
      x[r] /= L[at(r, r)];
      for (let c = first[r]; c < r; c++) x[c] -= L[at(r, c)] * x[r];
    }
    for (let r = 0; r < m; r++) weights[r * h + k] = x[r];
  }
  // Rows in `order`: the free landmarks listed in that order.
  return { outline: Int32Array.from(outline), free: Int32Array.from(order), weights };
}

/** 0 on the outline's landmarks, rising smoothly to 1 at `fade` px from
 *  the nearest of them. */
export function outlineFade(base: readonly Point[], outline: Int32Array, fade: number): Float64Array {
  const w = new Float64Array(base.length);
  for (let i = 0; i < base.length; i++) {
    let d = Infinity;
    for (const j of outline) d = Math.min(d, Math.hypot(base[i].x - base[j].x, base[i].y - base[j].y));
    const t = Math.max(0, Math.min(1, d / fade));
    w[i] = t * t * (3 - 2 * t);
  }
  return w;
}
