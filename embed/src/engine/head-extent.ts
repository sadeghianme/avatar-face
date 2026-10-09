/**
 * How far the head reaches beyond the face, read off the pictures once per
 * picture, for the head's field (head-field.ts): along each of its spokes,
 * where the head's silhouette is and where the field ends.
 *
 * Where the field ends:
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
import type { Point, Rect } from "./geometry";
import type { CanonicalFit } from "./head-depth";
import type { HeadPictures } from "./head-field";

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
/** The pictures are read at most this many pixels a side. */
const RASTER_MAX = 768;
/** The skull's half-axes in the canonical model's cm (canonical-face.ts),
 *  about SKULL_CENTRE_CM: 15.5 cm broad, 21 high, 19.5 long, a little
 *  inflated for the hair. Where the background cannot be told from the
 *  hair, its outline is the head's. */
const SKULL_AXES_CM = { x: 7.75 * 1.05, y: 10.5 * 1.05, z: 9.75 * 1.05 };

/** The skull's outline on the canvas (the canonical skull, through the
 *  photo's fitted camera): its distance from the skull's centre along a
 *  direction. */
export function skullOutline(fit: CanonicalFit): (dir: Point) => number {
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
export function headExtent(
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
