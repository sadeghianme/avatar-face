/**
 * The seam detector, small: does the warped mesh leave a visible boundary
 * where it meets the picture it is drawn over? Along every edge of the
 * mesh's outer boundary (the face's outline, the neck band's bottom), the
 * frame is compared with what was on the canvas just before the mesh was
 * drawn (`under`): outside the edge the frame IS that picture, so a mesh
 * that continues it has no line and no step there.
 *
 *  - SEAM: a thin bright or dark line along the edge that `under` does not
 *    have: the frame's line value (the centre against the mean of both
 *    sides 2.5 px out, less half their difference, so a step is no line)
 *    less `under`'s, averaged over a 12 px run, beyond LINE levels.
 *  - TEAR: the frame off `under` at the edge by more than STEP levels on
 *    average over a run: content shifted across it.
 *
 * The scratchpad detector the engine's seams were hunted with, reduced to
 * the one reference that decides it; pure, so the Skia test (seams.test.ts)
 * and the browser test (browser-tests/) share it.
 *
 * Inside the mesh, where it meets itself (the face's outline, where the
 * head's field takes over, and every edge between two triangles), there is
 * no picture under it to compare with, and a moved texture is no reference
 * for a line: there the mesh is drawn twice more, over two solid backdrops
 * in place of the picture (seam-script.ts), and any pixel inside the drawn
 * triangles where the two differ shows the backdrop through the mesh, a gap
 * between triangles or a pixel drawn twice (probeLeaks).
 */
import type { FaceMesh, Point } from "../engine/geometry";
import type { Affine } from "../engine/affine";

const LINE = 4;
const STEP = 16;
const RUN = 12;
/** A leak: the two backdrops differ there by more than this, levels. */
const LEAK = 2;
/** Pixels this close to the drawn triangles' own boundary are its edge's
 *  anti-aliasing, not a leak. */
const LEAK_EDGE = 2;

export interface Segment {
  a: Point;
  b: Point;
  /** "hull" for the face's outline, "neck" for the band's bottom edge,
   *  "head" for the head's field's outer edge. */
  kind: "hull" | "neck" | "head";
}

export interface LeakReport {
  /** Pixels inside the drawn triangles showing the backdrop, and the most
   *  any of them does, levels: in the head's field's triangles (the face's
   *  outline where it takes over included: the field is drawn after the
   *  face, its seam pads over the outline), and in the face mesh's. */
  px: number;
  worst: number;
  facePx: number;
  faceWorst: number;
}

export interface SeamReport {
  runs: number;
  seams: number;
  tears: number;
  /** The worst run's mean line excess and step, levels. */
  worstLine: number;
  worstStep: number;
}

/**
 * The mesh's outer boundary at `pts` (the frame's vertices), on the canvas
 * through `affine`: every edge of one triangle only, less the halves of an
 * edge the mouth subdivision split (a T-junction is no boundary). With the
 * head's field, the face's outline is inside the mesh and the field's outer
 * edge is the boundary instead.
 */
export function meshBoundary(mesh: FaceMesh, pts: readonly Point[], affine: Affine): Segment[] {
  const count = new Map<string, [number, number, number]>();
  for (const [a, b, c] of mesh.triangles) {
    for (const [i, j] of [
      [a, b],
      [b, c],
      [c, a],
    ]) {
      const k = i < j ? `${i}:${j}` : `${j}:${i}`;
      const e = count.get(k);
      if (e) e[2]++;
      else count.set(k, [i, j, 1]);
    }
  }
  const first = mesh.basePoints.length,
    parents = mesh.derivedParents;
  const split = new Set(parents.map(([a, b]) => (a < b ? `${a}:${b}` : `${b}:${a}`)));
  const half = (i: number, j: number) => {
    const m = i >= first && i < first + parents.length ? i : j >= first && j < first + parents.length ? j : -1;
    if (m < 0) return false;
    const [a, b] = parents[m - first];
    const o = m === i ? j : i;
    return o === a || o === b;
  };
  const firstNeck = first + parents.length;
  const firstHead = mesh.head ? mesh.head.first : Infinity;
  const at = (p: Point) => ({
    x: affine.a * p.x + affine.c * p.y + affine.e,
    y: affine.b * p.x + affine.d * p.y + affine.f,
  });
  const out: Segment[] = [];
  for (const [i, j, n] of count.values()) {
    if (n !== 1 || split.has(i < j ? `${i}:${j}` : `${j}:${i}`) || half(i, j)) continue;
    const kind = i >= firstHead || j >= firstHead ? "head" : i >= firstNeck && j >= firstNeck ? "neck" : "hull";
    out.push({ a: at(pts[i]), b: at(pts[j]), kind });
  }
  return out;
}

/**
 * Which pixels of a `size` x `size` frame the mesh covers as drawn: every
 * triangle laid over the picture (an opaque one), or over a cut-out
 * (`replace`) only those the face moved, and the head's field's only where
 * it moved (mesh-warp.ts). Per pixel whose centre is inside a drawn
 * triangle, through `affine`: 2 for a triangle of the head's field, else 1.
 */
export function drawnMask(
  mesh: FaceMesh,
  pts: readonly Point[],
  rest: readonly Point[],
  affine: Affine,
  size: number,
  replace: boolean
): Uint8Array {
  const mask = new Uint8Array(size * size);
  const moved = (i: number) => Math.abs(pts[i].x - rest[i].x) > 1e-3 || Math.abs(pts[i].y - rest[i].y) > 1e-3;
  const from = mesh.head ? mesh.head.triangleFrom : Infinity;
  const at = (p: Point) => ({
    x: affine.a * p.x + affine.c * p.y + affine.e,
    y: affine.b * p.x + affine.d * p.y + affine.f,
  });
  mesh.triangles.forEach(([a, b, c], t) => {
    if ((replace || t >= from) && !moved(a) && !moved(b) && !moved(c)) return;
    const [p, q, r] = [a, b, c].map((v) => at(pts[v]));
    const d = (q.x - p.x) * (r.y - p.y) - (r.x - p.x) * (q.y - p.y);
    if (Math.abs(d) < 1e-9) return;
    const x0 = Math.max(0, Math.floor(Math.min(p.x, q.x, r.x))),
      x1 = Math.min(size - 1, Math.ceil(Math.max(p.x, q.x, r.x)));
    const y0 = Math.max(0, Math.floor(Math.min(p.y, q.y, r.y))),
      y1 = Math.min(size - 1, Math.ceil(Math.max(p.y, q.y, r.y)));
    const value = t >= from ? 2 : 1;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5,
          py = y + 0.5;
        const u = ((q.x - px) * (r.y - py) - (r.x - px) * (q.y - py)) / d;
        const v = ((r.x - px) * (p.y - py) - (p.x - px) * (r.y - py)) / d;
        if (u >= 0 && v >= 0 && u + v <= 1) mask[y * size + x] = Math.max(mask[y * size + x], value);
      }
    }
  });
  return mask;
}

/**
 * The mesh drawn over two solid backdrops (`overA`, `overB`, RGBA): the
 * pixels inside `mask` (LEAK_EDGE px in from its edge) where they differ,
 * and by how much at most.
 */
export function probeLeaks(
  overA: Uint8ClampedArray,
  overB: Uint8ClampedArray,
  mask: Uint8Array,
  size: number
): LeakReport {
  const report: LeakReport = { px: 0, worst: 0, facePx: 0, faceWorst: 0 };
  const e = LEAK_EDGE;
  for (let y = e; y < size - e; y++) {
    for (let x = e; x < size - e; x++) {
      const here = mask[y * size + x];
      if (!here) continue;
      let inner = true;
      for (let dy = -e; dy <= e && inner; dy++)
        for (let dx = -e; dx <= e && inner; dx++) inner = mask[(y + dy) * size + x + dx] > 0;
      if (!inner) continue;
      const field = here === 2;
      const o = (y * size + x) * 4;
      let d = 0;
      for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(overA[o + k] - overB[o + k]));
      if (d <= LEAK) continue;
      if (field) {
        report.px++;
        report.worst = Math.max(report.worst, d);
      } else {
        report.facePx++;
        report.faceWorst = Math.max(report.faceWorst, d);
      }
    }
  }
  return report;
}

/** Luma of an RGBA frame (size x size) over a mid-grey page, sampled
 *  bilinearly; null off the frame. */
function lumaOf(rgba: Uint8ClampedArray, size: number): (x: number, y: number) => number | null {
  const at = (x: number, y: number) => {
    const o = (y * size + x) * 4;
    const a = rgba[o + 3] / 255;
    const over = (v: number) => v * a + 128 * (1 - a);
    return 0.299 * over(rgba[o]) + 0.587 * over(rgba[o + 1]) + 0.114 * over(rgba[o + 2]);
  };
  return (x, y) => {
    const ix = Math.floor(x),
      iy = Math.floor(y);
    if (ix < 0 || iy < 0 || ix + 1 >= size || iy + 1 >= size) return null;
    const tx = x - ix,
      ty = y - iy;
    return (
      (at(ix, iy) * (1 - tx) + at(ix + 1, iy) * tx) * (1 - ty) +
      (at(ix, iy + 1) * (1 - tx) + at(ix + 1, iy + 1) * tx) * ty
    );
  };
}

/** The frame's seams and tears along `segments`, against `under`. */
export function probeSeams(
  frame: Uint8ClampedArray,
  under: Uint8ClampedArray,
  size: number,
  segments: readonly Segment[]
): SeamReport {
  const F = lumaOf(frame, size),
    U = lumaOf(under, size);
  const lineVal = (L: typeof F, p: Point, n: Point): number | null => {
    const c = L(p.x, p.y),
      u = L(p.x + n.x * 2.5, p.y + n.y * 2.5),
      v = L(p.x - n.x * 2.5, p.y - n.y * 2.5);
    if (c === null || u === null || v === null) return null;
    const m = c - (u + v) / 2;
    return Math.sign(m) * Math.max(0, Math.abs(m) - Math.abs(u - v) / 2);
  };
  const report: SeamReport = { runs: 0, seams: 0, tears: 0, worstLine: 0, worstStep: 0 };
  for (const s of segments) {
    const len = Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y);
    if (len < 4) continue;
    const n = { x: -(s.b.y - s.a.y) / len, y: (s.b.x - s.a.x) / len };
    const line: number[] = [],
      step: number[] = [];
    for (let t = 0.5; t <= len - 0.5; t += 1) {
      const p0 = { x: s.a.x + ((s.b.x - s.a.x) * t) / len, y: s.a.y + ((s.b.y - s.a.y) * t) / len };
      let ex = 0,
        diff = Infinity,
        ok = false;
      for (const o of [-1.5, -0.75, 0, 0.75, 1.5]) {
        const p = { x: p0.x + n.x * o, y: p0.y + n.y * o };
        const lf = lineVal(F, p, n);
        if (lf === null) continue;
        ok = true;
        const e = lf - (lineVal(U, p, n) ?? 0);
        if (Math.abs(e) > Math.abs(ex)) ex = e;
        diff = Math.min(diff, Math.abs(F(p.x, p.y)! - (U(p.x, p.y) ?? F(p.x, p.y)!)));
      }
      if (!ok) continue;
      line.push(ex);
      step.push(diff);
    }
    for (let k = 0; k + RUN <= line.length; k += RUN / 2) {
      report.runs++;
      let sl = 0,
        ss = 0;
      for (let q = k; q < k + RUN; q++) {
        sl += line[q];
        ss += step[q];
      }
      sl /= RUN;
      ss /= RUN;
      if (Math.abs(sl) > LINE) report.seams++;
      if (ss > STEP) report.tears++;
      if (Math.abs(sl) > Math.abs(report.worstLine)) report.worstLine = sl;
      report.worstStep = Math.max(report.worstStep, ss);
    }
  }
  return report;
}
