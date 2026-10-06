/**
 * The face's geometry: where the picture lies on the canvas, the mesh's
 * rest positions in canvas and texture pixels, and the refinements the
 * engine adds to the rig's own triangles (the mouth subdivision and the
 * neck band).
 *
 * Texture coords map to the TEXTURE's own naturalWidth/naturalHeight (the
 * thumbnail may be scaled down), never to rig.image_size.
 */
import { buildNeckBand } from "./jaw-rig";
import type { Rig } from "../types";
import { eyeLine, viewportFor } from "./viewport";

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Triangle = [number, number, number];

/** A neck-band vertex: where it rests, and the jaw-line vertex it hangs
 *  from by a share of that vertex's motion. */
export interface NeckVertex {
  base: Point;
  parent: number;
  share: number;
}

/** The face mesh laid on the canvas. Rebuilt whole when the viewport or the
 *  texture changes; never edited in between. */
export interface FaceMesh {
  /** Framing: rig image coords -> canvas coords, x * scale + offsetX. */
  scale: number;
  offsetX: number;
  offsetY: number;
  /** Where the whole picture lies on the canvas, canvas px (viewport.ts);
   *  parts of it may be outside the canvas. */
  picture: Rect;
  /** The rig's points at rest, canvas px. */
  basePoints: Point[];
  /** Texture px: the rig's points, then the subdivision's midpoints, then
   *  the neck band, in vertex order. */
  texPoints: Point[];
  /** Mouth-region subdivision: extra midpoint vertices (numbered after the
   *  rig's points) that follow their two parents. */
  derivedParents: [number, number][];
  /** The neck band (jaw-rig.ts): derived vertices below the jaw line, after
   *  the midpoints, each hanging from a jaw-line vertex by a share of its
   *  motion, so the chin drops over stretching neck skin, not a still one. */
  neckBand: NeckVertex[];
  /** The rig's triangles with the mouth's refined, then the neck band's. */
  triangles: Triangle[];
}

/**
 * Lay the whole picture on the canvas (viewport.ts): the face zoom
 * composes it as a portrait that fills the canvas, the full zoom shows
 * all of it. Nothing is cropped; what falls outside the canvas is
 * outside. The mapping is rig image px -> canvas px.
 *
 * The mesh comes back unrefined (the rig's points only, no triangles):
 * refineMesh adds the rest.
 */
export function layOutFace(
  rig: Rig,
  texture: HTMLImageElement,
  canvas: { width: number; height: number },
  zoom: number,
  pan: { x: number; y: number } | undefined
): FaceMesh {
  const [imageW, imageH] = rig.image_size;
  const view = viewportFor({
    imageW, imageH,
    faceBox: rig.face_box,
    eyeY: eyeLine(rig.points, rig.face_box),
    canvasW: canvas.width,
    canvasH: canvas.height,
    zoom,
    pan,
  });
  const { scale, offsetX, offsetY } = view;
  // Texture coords use the texture's OWN dimensions — the thumbnail may
  // be a scaled copy of the original image.
  const tw = texture.naturalWidth / rig.image_size[0];
  const th = texture.naturalHeight / rig.image_size[1];
  return {
    scale,
    offsetX,
    offsetY,
    picture: { x: offsetX, y: offsetY, w: imageW * scale, h: imageH * scale },
    texPoints: rig.points.map(([x, y]) => ({ x: x * tw, y: y * th })),
    basePoints: rig.points.map(([x, y]) => ({ x: x * scale + offsetX, y: y * scale + offsetY })),
    derivedParents: [],
    neckBand: [],
    triangles: [],
  };
}

/** The mouth subdivision, then the neck band below it, added to `mesh`. */
export function refineMesh(mesh: FaceMesh, rig: Rig, texture: HTMLImageElement): void {
  subdivideMouthRegion(mesh, rig);
  addNeckBand(mesh, rig, texture);
}

/**
 * Refine the mesh around the mouth: 1:4 subdivide every triangle with at
 * least two vertices near the mouth. Big triangles are what make lip
 * deformation look faceted — midpoint vertices (tracked by parent pair)
 * follow the warp smoothly at near-zero cost (~200 extra triangles).
 */
function subdivideMouthRegion(mesh: FaceMesh, rig: Rig): void {
  const { basePoints, texPoints, derivedParents } = mesh;
  const mouth = rig.mouth_indices ?? [];
  if (!mouth.length) {
    mesh.triangles = rig.triangles.map((t) => [...t] as Triangle);
    return;
  }
  let mcx = 0;
  let mcy = 0;
  for (const i of mouth) {
    mcx += basePoints[i].x;
    mcy += basePoints[i].y;
  }
  mcx /= mouth.length;
  mcy /= mouth.length;
  const xs = mouth.map((i) => basePoints[i].x);
  const radius = Math.max((Math.max(...xs) - Math.min(...xs)) * 0.95, 8);
  const near = new Set<number>();
  for (let i = 0; i < basePoints.length; i++) {
    if (Math.hypot(basePoints[i].x - mcx, basePoints[i].y - mcy) < radius) {
      near.add(i);
    }
  }

  const midCache = new Map<string, number>();
  const midpoint = (a: number, b: number): number => {
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    let index = midCache.get(key);
    if (index === undefined) {
      index = basePoints.length + derivedParents.length;
      midCache.set(key, index);
      derivedParents.push([a, b]);
      texPoints.push({
        x: (texPoints[a].x + texPoints[b].x) / 2,
        y: (texPoints[a].y + texPoints[b].y) / 2,
      });
    }
    return index;
  };

  const triangles: Triangle[] = [];
  for (const [a, b, c] of rig.triangles) {
    const inside = Number(near.has(a)) + Number(near.has(b)) + Number(near.has(c));
    if (inside >= 2) {
      const ab = midpoint(a, b);
      const bc = midpoint(b, c);
      const ca = midpoint(c, a);
      triangles.push([a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]);
    } else {
      triangles.push([a, b, c]);
    }
  }
  mesh.triangles = triangles;
}

/**
 * The neck band below the jaw line (jaw-rig.ts buildNeckBand), appended
 * after the mouth subdivision's midpoints: its vertices, their texture
 * positions (the still picture below the chin) and its triangles. Every
 * rig gets one, derived from its own points.
 */
function addNeckBand(mesh: FaceMesh, rig: Rig, texture: HTMLImageElement): void {
  const band = buildNeckBand(mesh.basePoints, mesh.basePoints.length + mesh.derivedParents.length);
  const tw = texture.naturalWidth / rig.image_size[0];
  const th = texture.naturalHeight / rig.image_size[1];
  for (const v of band.vertices) {
    mesh.neckBand.push({ base: { x: v.x, y: v.y }, parent: v.parent, share: v.share });
    mesh.texPoints.push({
      x: ((v.x - mesh.offsetX) / mesh.scale) * tw,
      y: ((v.y - mesh.offsetY) / mesh.scale) * th,
    });
  }
  mesh.triangles.push(...band.triangles);
}

/** How many canvas pixels one texture pixel is, at rest. */
export function pixelScale(mesh: FaceMesh, rig: Rig, texture: HTMLImageElement): number {
  const tw = texture.naturalWidth / Math.max(1, rig.image_size[0]);
  return tw > 0 ? mesh.scale / tw : mesh.scale;
}

/**
 * The inner-lip ring the classic mouth is built on. Guard: if the stored
 * ring's spread is implausible vs the mouth box (bad rig / wrong indices),
 * rebuild a usable ring from mouth_indices.
 */
export function validInnerRing(rig: Rig): number[] {
  const ring = rig.inner_lip_ring ?? [];
  const mouth = rig.mouth_indices ?? [];
  if (ring.length < 6) return ringFromMouth(rig, mouth);
  const pts = ring.map((i) => rig.points[i]);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const ringW = Math.max(...xs) - Math.min(...xs);
  const ringH = Math.max(...ys) - Math.min(...ys);
  const mpts = mouth.map((i) => rig.points[i]);
  const mxs = mpts.map((p) => p[0]);
  const mys = mpts.map((p) => p[1]);
  const mouthW = Math.max(...mxs) - Math.min(...mxs);
  const mouthH = Math.max(...mys) - Math.min(...mys);
  const plausible =
    ringW > mouthW * 0.2 && ringW <= mouthW * 1.05 && ringH <= Math.max(mouthH * 1.05, 1);
  return plausible ? ring : ringFromMouth(rig, mouth);
}

function ringFromMouth(rig: Rig, mouth: number[]): number[] {
  if (!mouth.length) return [];
  // Innermost half of the mouth points (closest to the mouth centroid).
  const cx = mouth.reduce((s, i) => s + rig.points[i][0], 0) / mouth.length;
  const cy = mouth.reduce((s, i) => s + rig.points[i][1], 0) / mouth.length;
  return [...mouth]
    .sort((a, b) => {
      const da = (rig.points[a][0] - cx) ** 2 + (rig.points[a][1] - cy) ** 2;
      const db = (rig.points[b][0] - cx) ** 2 + (rig.points[b][1] - cy) ** 2;
      return da - db;
    })
    .slice(0, Math.max(8, Math.floor(mouth.length / 2)));
}

/** The head as a movable unit: the rectangle of the picture it occupies,
 *  canvas px, where it pivots, and how far it may travel. */
export interface HeadGeom extends Rect {
  pivotX: number;
  pivotY: number;
  yawPx: number;
  pitchPx: number;
  faceH: number;
}

/**
 * Where the head sits and how far it may move: a rectangle around the
 * whole head (hair, ears, skull), from the face landmarks' box, within the
 * picture. Null for a face too small to move.
 *
 * The face mesh spans eyebrows to chin — it knows nothing about hair or
 * ears. Warping it moves the face while the rest of the head stands still,
 * which is exactly the failure the first head-motion attempt shipped. So
 * the unit of motion is this rectangle (render2d.ts cuts it out of a
 * cut-out photo as its own layer).
 */
export function placeHead(basePoints: readonly Point[], picture: Rect): HeadGeom | null {
  const xs = basePoints.map((p) => p.x);
  const ys = basePoints.map((p) => p.y);
  const fx0 = Math.min(...xs), fx1 = Math.max(...xs);
  const fy0 = Math.min(...ys), fy1 = Math.max(...ys);
  const faceW = fx1 - fx0, faceH = fy1 - fy0;
  if (faceW < 4 || faceH < 4) return null;

  // Within the picture, not the canvas: the head may reach past the
  // canvas edge (hair above a face zoom) and still be the unit that moves.
  const pic = picture;
  const x = Math.max(pic.x, fx0 - faceW * 0.42);
  const y = Math.max(pic.y, fy0 - faceH * 0.9);
  const w = Math.min(pic.x + pic.w, fx1 + faceW * 0.42) - x;
  const h = Math.min(pic.y + pic.h, fy1 + faceH * 0.5) - y;
  if (w < 8 || h < 8) return null;

  // The geometry (pivot, travel) serves every picture; the cut-out layer
  // itself only a cut-out, whose head moves over transparency. An opaque
  // picture moves as one instead (render), so it needs no copy.
  return {
    x, y, w, h,
    pivotX: (fx0 + fx1) / 2,
    // A head pivots where it meets the spine, in the upper chest — not
    // about its own middle, which reads as the face rotating in the skull.
    pivotY: fy1 + faceH * 0.85,
    // Peak travel, |pose|=1 extremes the signed-square draw rarely
    // reaches. Kept close to SitePal's measured ~2% drift: anything
    // livelier drags the layer boundary across hair and background
    // detail, which reads as the image tearing, not the head turning.
    yawPx: faceW * 0.03,
    pitchPx: faceH * 0.025,
    faceH,
  };
}
