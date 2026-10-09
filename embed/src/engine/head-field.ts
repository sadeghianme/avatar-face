/**
 * The head beyond the face: the hair, the ears and the head's outline, as
 * a coarse ring of triangles around the face mesh that turns in depth with
 * it (the "3d" head motion, head-turn.ts). Without it the face turned
 * inside a still head: the forehead's hairline, the temples and the hair
 * above them stayed where they were while the face slid under them.
 *
 * The field is part of the face mesh, not a second warp: its inner edge is
 * the face's own outline (the rig's boundary from one cheek, 234, over the
 * top to the other, 454; its ends are the neck band's end columns), so the
 * face and the head share every vertex they meet at and are drawn in the
 * same pass, on the GPU in the same draw. There is nothing to seam and
 * nothing moved twice. From the outline it reaches out along spokes from the
 * skull's centre (one per outline landmark, RINGS vertices each) to where
 * the field ends, and is 0 from there out: the picture beyond (the
 * background, the shoulders, the rest of a cut-out) moves only as it did,
 * with the head's rigid motion or the body.
 *
 * Where it ends is read off the picture, once per picture (head-extent.ts).
 * A picture that cannot be read (a cross-origin texture) gets no field, and
 * the outline stays where the rigid motion puts it, as before.
 */
import type { FaceMesh, Point, Triangle } from "./geometry";
import { SKULL_CENTRE_CM, fitCanonical } from "./head-depth";
import { headExtent, skullOutline } from "./head-extent";

/** Vertices per spoke beyond the outline landmark; the last is where the
 *  field ends. */
const RINGS = 4;
/** The narrowest the field may be along a spoke (its triangles need a
 *  shape), IODs. */
const MIN_BAND_IOD = 0.05;
/** The outline's ends: the neck band hangs from them. */
const ARC_START = 234,
  ARC_END = 454,
  CHIN = 152;

/** One spoke: from an outline landmark straight away from the skull's
 *  centre. */
export interface HeadSpoke {
  /** The outline landmark it starts at. */
  landmark: number;
  /** Unit direction from the centre, canvas px. */
  dir: Point;
  /** From the centre, at rest, canvas px: the landmark; where the head
   *  ends (the hair's or the skin's silhouette, or the best guess of it);
   *  where the field ends. */
  r0: number;
  silhouette: number;
  outer: number;
  /** Its mesh vertices from the landmark out (the ends: the neck band's
   *  end column). */
  vertices: number[];
}

/** The field laid on a mesh (FaceMesh.head). */
export interface HeadField {
  /** Its own vertices: `count` of them from `first` (after the neck band). */
  first: number;
  count: number;
  /** Its triangles: mesh.triangles from here to the end. */
  triangleFrom: number;
  /** The skull's centre on the canvas, and the eye distance, canvas px. */
  centre: Point;
  iod: number;
  /** One per outline landmark, 234 over the top to 454. */
  spokes: HeadSpoke[];
  /** Per own vertex: where it rests, its spoke, its distance from the
   *  centre. */
  vertices: { base: Point; spoke: number; r: number }[];
}

/** What the field is laid over: the picture, and a layered avatar's
 *  layers. */
export interface HeadPictures {
  texture: HTMLImageElement;
  cutOut: boolean;
  layers: { background?: HTMLImageElement; body: HTMLImageElement; head: HTMLImageElement } | null;
}

/**
 * The outline's arc: the rig's boundary from 234 to 454 the way that does
 * not pass the chin. Null when either end is not on the boundary.
 */
export function outlineArc(
  triangles: readonly (readonly [number, number, number])[],
  pointCount: number
): number[] | null {
  const key = (i: number, j: number) => Math.min(i, j) * 65536 + Math.max(i, j);
  const count = new Map<number, number>();
  for (const [a, b, c] of triangles) {
    if (a >= pointCount || b >= pointCount || c >= pointCount) continue;
    for (const k of [key(a, b), key(b, c), key(c, a)]) count.set(k, (count.get(k) ?? 0) + 1);
  }
  const next = new Map<number, number[]>();
  const link = (i: number, j: number) => {
    const l = next.get(i);
    if (l) l.push(j);
    else next.set(i, [j]);
  };
  for (const [k, c] of count) {
    if (c !== 1) continue;
    const i = Math.floor(k / 65536),
      j = k % 65536;
    link(i, j);
    link(j, i);
  }
  const from = next.get(ARC_START);
  if (!from || !next.has(ARC_END)) return null;
  for (const first of from) {
    const path = [ARC_START, first];
    while (path[path.length - 1] !== ARC_END && path.length <= pointCount) {
      const here = path[path.length - 1],
        prev = path[path.length - 2];
      const onward = (next.get(here) ?? []).filter((v) => v !== prev);
      if (onward.length !== 1) break;
      path.push(onward[0]);
    }
    if (path[path.length - 1] === ARC_END && !path.includes(CHIN)) return path;
  }
  return null;
}

/**
 * Lay the field on `mesh` (refined, the neck band in place): its vertices
 * after the band's, its texture positions and its triangles, and
 * `mesh.head`. Nothing when the outline, the neck band or the picture
 * cannot be had.
 */
export function addHeadField(
  mesh: FaceMesh,
  rigTriangles: readonly (readonly [number, number, number])[],
  textureScale: { x: number; y: number },
  pictures: HeadPictures
): void {
  const base = mesh.basePoints;
  if (base.length < 468 || !mesh.neckBand.length) return;
  const arc = outlineArc(rigTriangles, base.length);
  if (!arc || arc.length < 5) return;
  // The neck band's end columns (neck-band.ts buildNeckBand: an inner ring
  // and an outer ring along the jaw arc, which starts at 234 and ends at 454).
  const bandFirst = base.length + mesh.derivedParents.length;
  const n = mesh.neckBand.length / 2;
  if (!Number.isInteger(n) || mesh.neckBand[0].parent !== ARC_START || mesh.neckBand[n - 1].parent !== ARC_END) return;
  const startColumn = [ARC_START, bandFirst, bandFirst + n];
  const endColumn = [ARC_END, bandFirst + n - 1, bandFirst + 2 * n - 1];

  const iod = Math.hypot(base[33].x - base[263].x, base[33].y - base[263].y);
  if (iod < 4) return;
  const fit = fitCanonical(base);
  const c = fit.at(SKULL_CENTRE_CM);
  const centre = { x: c.x, y: c.y };
  const skull = skullOutline(fit);

  const read = headExtent(mesh.picture, pictures, centre, iod, skull);
  if (!read) return;

  const spokes: HeadSpoke[] = arc.map((landmark) => {
    const p = base[landmark];
    const r0 = Math.hypot(p.x - centre.x, p.y - centre.y);
    const dir = r0 > 0 ? { x: (p.x - centre.x) / r0, y: (p.y - centre.y) / r0 } : { x: 0, y: -1 };
    const { silhouette, outer } = read(dir, r0);
    return { landmark, dir, r0, silhouette, outer: Math.max(outer, r0 + MIN_BAND_IOD * iod), vertices: [] };
  });
  // Neighbouring spokes' outer ends no more than a band's width apart in
  // reach, so no triangle between them is a sliver standing on its end.
  for (let pass = 0; pass < 2; pass++) {
    for (let k = 1; k + 1 < spokes.length; k++) {
      const s = spokes[k];
      const band = s.outer - s.r0;
      const nb = Math.max(spokes[k - 1].outer - spokes[k - 1].r0, spokes[k + 1].outer - spokes[k + 1].r0);
      if (band > 3 * nb + MIN_BAND_IOD * iod) s.outer = s.r0 + 3 * nb + MIN_BAND_IOD * iod;
    }
  }

  const first = bandFirst + mesh.neckBand.length;
  const vertices: HeadField["vertices"] = [];
  spokes.forEach((s, k) => {
    if (k === 0) s.vertices = startColumn;
    else if (k === spokes.length - 1) s.vertices = endColumn;
    else {
      s.vertices = [s.landmark];
      for (let m = 1; m <= RINGS; m++) {
        const r = s.r0 + ((s.outer - s.r0) * m) / RINGS;
        s.vertices.push(first + vertices.length);
        vertices.push({ base: { x: centre.x + s.dir.x * r, y: centre.y + s.dir.y * r }, spoke: k, r });
      }
    }
  });
  // The rest positions of every vertex a strip uses, for its triangles'
  // winding.
  const at = (i: number): Point =>
    i < base.length ? base[i] : i < first ? mesh.neckBand[i - bandFirst].base : vertices[i - first].base;
  const triangles: Triangle[] = [];
  for (let k = 0; k + 1 < spokes.length; k++) {
    zip(spokes[k].vertices, spokes[k + 1].vertices, k === 0, triangles, at);
  }

  const tex = (p: Point): Point => ({
    x: ((p.x - mesh.offsetX) / mesh.scale) * textureScale.x,
    y: ((p.y - mesh.offsetY) / mesh.scale) * textureScale.y,
  });
  for (const v of vertices) mesh.texPoints.push(tex(v.base));
  const triangleFrom = mesh.triangles.length;
  mesh.triangles.push(...triangles);
  mesh.head = { first, count: vertices.length, triangleFrom, centre, iod, spokes, vertices };
}

/**
 * Triangles between two spokes' vertex lists, from the outline out: the
 * first one always takes the second vertex of a spoke of the field's own
 * (`firstFromB`: of `b`, the other spoke being the neck band's column), so
 * that every triangle of the field has a vertex of its own (mesh-warp.ts
 * tells the field's triangles by it); then the side whose next vertex lies
 * nearer the outline, in proportion, advances. Wound as the first.
 */
function zip(a: number[], b: number[], firstFromB: boolean, out: Triangle[], at: (i: number) => Point): void {
  let i = 0,
    j = 0;
  const push = (t: Triangle) => {
    const [p, q, r] = t.map(at);
    const s = (q.x - p.x) * (r.y - p.y) - (r.x - p.x) * (q.y - p.y);
    out.push(s >= 0 ? t : [t[0], t[2], t[1]]);
  };
  if (firstFromB) {
    push([a[0], b[0], b[1]]);
    j = 1;
  } else {
    push([a[0], b[0], a[1]]);
    i = 1;
  }
  while (i < a.length - 1 || j < b.length - 1) {
    const ta = i < a.length - 1 ? (i + 1) / (a.length - 1) : Infinity;
    const tb = j < b.length - 1 ? (j + 1) / (b.length - 1) : Infinity;
    if (ta <= tb) {
      push([a[i], b[j], a[i + 1]]);
      i++;
    } else {
      push([a[i], b[j], b[j + 1]]);
      j++;
    }
  }
}
