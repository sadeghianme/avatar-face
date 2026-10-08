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
 * Where it ends is read off the picture, once per picture (headExtent):
 *  - a cut-out (the picture's own alpha, a layered avatar's too): a little
 *    past the head's silhouette, the end of the hair, into the clear around
 *    it, so the silhouette itself moves, its alpha with its colour (the
 *    warp replaces what is under a moved triangle, mesh-warp.ts);
 *  - an opaque photo: where the background starts (the colour the picture
 *    shows well away from the head, or a layered avatar's own background
 *    layer), a little past it where the background beside the hair is flat,
 *    and inside the hair where it is not: a busy background is never
 *    stretched, and a flat one only over a few pixels;
 *  - a layered avatar with a background layer: never past where its head and
 *    body layers cover the picture (the background layer stays still);
 *  - always inside the picture, and within REACH_IOD of the outline.
 * A picture that cannot be read (a cross-origin texture) gets no field, and
 * the outline stays where the rigid motion puts it, as before.
 */
import type { FaceMesh, Point, Rect, Triangle } from "./geometry";
import { SKULL_CENTRE_CM, fitCanonical } from "./head-turn";

/** Vertices per spoke beyond the outline landmark; the last is where the
 *  field ends. */
const RINGS = 4;
/** Sampling step along a spoke, and how far out it looks, in IODs. */
const STEP_IOD = 0.02;
const REACH_IOD = 1.6;
/** A cut-out's head ends where its alpha stays clear this far. */
const CLEAR_RUN_IOD = 0.1;
/** How far past a cut-out's silhouette the field ends (into the clear),
 *  and how far short of anything opaque beyond it. */
const CUT_MARGIN_IOD = 0.12;
const OBJECT_GAP_IOD = 0.06;
/** An opaque picture's background starts where this much of it runs on. */
const BG_RUN_IOD = 0.06;
/** Past an opaque silhouette over a flat background, and short of one over
 *  a busy background (or where the background could not be told), IODs. */
const FLAT_MARGIN_IOD = 0.08;
const BUSY_INSET_IOD = 0.05;
/** Never this close to the picture's edge or a layered avatar's uncovered
 *  background, IODs. */
const EDGE_GAP_IOD = 0.03;
/** The narrowest the field may be along a spoke (its triangles need a
 *  shape), IODs. */
const MIN_BAND_IOD = 0.05;
/** The pictures are read at most this many pixels a side. */
const RASTER_MAX = 768;
/** The skull's half-axes in the canonical model's cm (canonical-face.ts),
 *  about SKULL_CENTRE_CM: 15.5 cm broad, 21 high, 19.5 long, a little
 *  inflated for the hair. Where the background cannot be told from the
 *  hair, its outline is the head's. */
const SKULL_AXES_CM = { x: 7.75 * 1.05, y: 10.5 * 1.05, z: 9.75 * 1.05 };
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
  // The neck band's end columns (jaw-rig.ts buildNeckBand: an inner ring
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

/** The skull's outline on the canvas (the canonical skull, through the
 *  photo's fitted camera): its distance from the skull's centre along a
 *  direction. */
function skullOutline(fit: ReturnType<typeof fitCanonical>): (dir: Point) => number {
  // The ellipsoid's silhouette under the affine camera: the image of the
  // unit sphere under M diag(axes), the ellipse with shape Q = (ME)(ME)^T.
  const o = fit.at({ x: 0, y: 0, z: 0 });
  const col = (axis: "x" | "y" | "z") => {
    const u = { x: 0, y: 0, z: 0 };
    u[axis] = SKULL_AXES_CM[axis];
    const p = fit.at(u);
    return [p.x - o.x, p.y - o.y];
  };
  const cols = [col("x"), col("y"), col("z")];
  let q11 = 0,
    q12 = 0,
    q22 = 0;
  for (const [u, v] of cols) {
    q11 += u * u;
    q12 += u * v;
    q22 += v * v;
  }
  const det = q11 * q22 - q12 * q12 || 1e-9;
  const i11 = q22 / det,
    i12 = -q12 / det,
    i22 = q11 / det;
  return (d) => 1 / Math.sqrt(Math.max(1e-12, i11 * d.x * d.x + 2 * i12 * d.x * d.y + i22 * d.y * d.y));
}

/** A picture read back, small. */
interface Raster {
  w: number;
  h: number;
  data: Uint8ClampedArray;
}
const rasters = new WeakMap<object, Raster | null>();

/** The image's pixels at most RASTER_MAX a side, once per image; null when
 *  it cannot be read (a cross-origin picture taints the canvas). */
function rasterOf(img: HTMLImageElement): Raster | null {
  if (rasters.has(img)) return rasters.get(img) ?? null;
  let raster: Raster | null = null;
  try {
    const iw = img.naturalWidth,
      ih = img.naturalHeight;
    if (iw > 0 && ih > 0) {
      const k = Math.min(1, RASTER_MAX / Math.max(iw, ih));
      const w = Math.max(1, Math.round(iw * k)),
        h = Math.max(1, Math.round(ih * k));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (ctx) {
        ctx.drawImage(img, 0, 0, w, h);
        raster = { w, h, data: ctx.getImageData(0, 0, w, h).data };
      }
    }
  } catch {
    raster = null;
  }
  rasters.set(img, raster);
  return raster;
}

/** RGBA at a canvas point of a full-frame image laid over `picture`
 *  (nearest pixel), or null off it. */
function sampler(raster: Raster, picture: Rect): (p: Point) => [number, number, number, number] | null {
  return (p) => {
    const x = Math.floor(((p.x - picture.x) / picture.w) * raster.w),
      y = Math.floor(((p.y - picture.y) / picture.h) * raster.h);
    if (x < 0 || y < 0 || x >= raster.w || y >= raster.h) return null;
    const o = (y * raster.w + x) * 4;
    const d = raster.data;
    return [d[o], d[o + 1], d[o + 2], d[o + 3]];
  };
}

const colourDistance = (a: readonly number[], b: readonly number[]) =>
  Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));

/**
 * How far the head reaches along each spoke, read off the pictures: a
 * function of a spoke's direction and its landmark's distance from the
 * centre giving the head's silhouette and where the field ends (canvas
 * px from the centre). Null when the picture cannot be read.
 */
function headExtent(
  picture: Rect,
  pictures: HeadPictures,
  centre: Point,
  iod: number,
  skull: (dir: Point) => number
): ((dir: Point, r0: number) => { silhouette: number; outer: number }) | null {
  const texture = rasterOf(pictures.texture);
  if (!texture) return null;
  const tex = sampler(texture, picture);
  const layers = pictures.layers;
  const head = layers ? rasterOf(layers.head) : null;
  const body = layers ? rasterOf(layers.body) : null;
  const background = layers?.background ? rasterOf(layers.background) : null;
  if (layers && (!head || !body || (layers.background && !background))) return null;
  const headAt = head ? sampler(head, picture) : null;
  const bodyAt = body ? sampler(body, picture) : null;
  const backAt = background ? sampler(background, picture) : null;
  const step = STEP_IOD * iod;
  const along = (dir: Point, r: number): Point => ({ x: centre.x + dir.x * r, y: centre.y + dir.y * r });
  // Where the ray leaves the picture, less a margin.
  const edge = (dir: Point): number => {
    let t = Infinity;
    const lim = (o: number, d: number, lo: number, hi: number) => {
      if (d > 1e-9) t = Math.min(t, (hi - o) / d);
      else if (d < -1e-9) t = Math.min(t, (lo - o) / d);
    };
    lim(centre.x, dir.x, picture.x, picture.x + picture.w);
    lim(centre.y, dir.y, picture.y, picture.y + picture.h);
    return t - EDGE_GAP_IOD * iod;
  };

  // A cut-out: its own alpha says where the head ends.
  if (pictures.cutOut && !backAt) {
    return (dir, r0) => {
      const limit = Math.min(r0 + REACH_IOD * iod, edge(dir));
      let solid = r0,
        clear = 0,
        end = -1;
      for (let r = r0; r <= limit; r += step) {
        const a = (tex(along(dir, r))?.[3] ?? 0) / 255;
        if (a >= 0.5) solid = r;
        clear = a < 0.1 ? clear + step : 0;
        if (clear >= CLEAR_RUN_IOD * iod) {
          end = r;
          break;
        }
      }
      if (end < 0) return { silhouette: limit, outer: limit };
      const silhouette = solid + step / 2;
      let outer = Math.min(silhouette + CUT_MARGIN_IOD * iod, limit);
      // Short of the next thing beyond (a shoulder, the other hand).
      for (let r = end; r <= outer + OBJECT_GAP_IOD * iod; r += step) {
        if ((tex(along(dir, r))?.[3] ?? 0) / 255 >= 0.1) {
          outer = Math.min(outer, r - OBJECT_GAP_IOD * iod);
          break;
        }
      }
      return { silhouette, outer: Math.max(outer, silhouette) };
    };
  }

  // An opaque picture: where the background starts. A layered avatar's own
  // background layer says what the background is; otherwise the colour the
  // picture shows well away from the head, if it is one colour.
  let isBackground: ((p: Point) => boolean) | null = null;
  if (backAt) {
    isBackground = (p) => {
      const a = tex(p),
        b = backAt(p);
      return !!a && !!b && colourDistance(a, b) < 16;
    };
  } else {
    const samples: number[][] = [];
    for (let k = 0; k < 24; k++) {
      // The upper half, all round: above the shoulders.
      const angle = Math.PI + (Math.PI * (k + 0.5)) / 24;
      const dir = { x: Math.cos(angle), y: Math.sin(angle) };
      const s = skull(dir);
      for (const f of [1.45, 1.6, 1.75]) {
        const r = s * f;
        if (r > edge(dir)) continue;
        const v = tex(along(dir, r));
        if (v) samples.push(v);
      }
    }
    if (samples.length >= 12) {
      const median = [0, 1, 2].map((ch) => {
        const s = samples.map((v) => v[ch]).sort((a, b) => a - b);
        return s[Math.floor(s.length / 2)];
      });
      const spread = samples.map((v) => colourDistance(v, median)).sort((a, b) => a - b);
      const mad = spread[Math.floor(spread.length / 2)];
      // Most of the ring one colour: a plain backdrop.
      if (mad < 10 && spread[Math.floor(spread.length * 0.75)] < 24) {
        const tolerance = Math.max(14, 3 * mad);
        isBackground = (p) => {
          const v = tex(p);
          return !!v && colourDistance(v, median) < tolerance;
        };
      }
    }
  }
  // Where a layered avatar's head and body layers stop covering the
  // picture (its background layer shows there, and does not move).
  const covered = (p: Point): boolean => {
    if (!backAt || !headAt || !bodyAt) return true;
    const h = (headAt(p)?.[3] ?? 0) / 255,
      b = (bodyAt(p)?.[3] ?? 0) / 255;
    return 1 - (1 - h) * (1 - b) >= 0.98;
  };
  return (dir, r0) => {
    let limit = Math.min(r0 + REACH_IOD * iod, edge(dir));
    for (let r = r0; r <= limit; r += step) {
      if (!covered(along(dir, r))) {
        limit = Math.max(r0, r - EDGE_GAP_IOD * iod);
        break;
      }
    }
    if (!isBackground) {
      // No background to tell from the hair: the skull's own outline, and
      // the field fading well inside it.
      const silhouette = Math.min(limit, Math.max(r0, skull(dir)));
      return { silhouette, outer: r0 + 0.85 * (silhouette - r0) };
    }
    let run = 0,
      silhouette = -1;
    for (let r = r0; r <= limit; r += step) {
      run = isBackground(along(dir, r)) ? run + step : 0;
      if (run >= BG_RUN_IOD * iod) {
        silhouette = r - run + step;
        break;
      }
    }
    if (silhouette < 0) return { silhouette: limit, outer: limit - BUSY_INSET_IOD * iod };
    // Flat beyond: the field may stretch the background next to the hair a
    // little; anything else and it ends inside the hair.
    let flat = silhouette + FLAT_MARGIN_IOD * iod <= limit;
    for (let r = silhouette; flat && r <= silhouette + FLAT_MARGIN_IOD * iod; r += step) {
      if (!isBackground(along(dir, r))) flat = false;
    }
    return {
      silhouette,
      outer: flat ? silhouette + FLAT_MARGIN_IOD * iod : silhouette - BUSY_INSET_IOD * iod,
    };
  };
}
