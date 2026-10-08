/**
 * The warped mesh: the texture drawn through the deformed triangles, on the
 * GPU as one draw (warp-gl.ts) where WebGL works, and on the 2D canvas as a
 * clipped drawImage per triangle everywhere else.
 *
 * The 2D path solves each triangle's source->dest affine with CRAMER'S
 * RULE; the naive derivation is degenerate and draws nothing. |det| < 1e-6
 * is skipped.
 */
import type { LowerFaceRig } from "./jaw-rig";
import { padTriangle } from "./seam-pad";
import { WarpRenderer, buildWarpMesh, type Affine } from "./warp-gl";
import type { FaceMesh, Point, Rect } from "./geometry";
import { LANDMARK_COUNT } from "./landmarks";

/** How the mesh is warped: "auto" on the GPU wherever WebGL works, "2d"
 *  always on the Canvas 2D path. See EngineOptions.warp. */
export type WarpMode = "auto" | "2d";

/** A vertex within this of where it rests, px, has not moved (MeshWarp.draw
 *  skips a still triangle over a picture with transparency). */
const STILL_PX = 1e-3;

/** What the warp draws from this frame. The texture and the mesh are
 *  replaced, never edited, so a cache keyed on them by reference sees
 *  every change. */
export interface WarpSource {
  texture: HTMLImageElement;
  mesh: FaceMesh;
  /** Pad every triangle's seams: a character profile, or flat art. */
  padEverywhere: boolean;
  /** The lower-face rig: where the mesh moves over the still picture. */
  lowerFace: LowerFaceRig | null;
  /** The picture has transparency (a cut-out): the mesh REPLACES what is
   *  under it instead of being laid over it (MeshWarp.draw). */
  replace: boolean;
  /** Leave the mesh's outer boundary unpadded (the head's turn in depth):
   *  its edges meet the picture around the mesh, not a neighbour. */
  unpadOutline?: boolean;
}

export class MeshWarp {
  /** The GPU warp (warp-gl.ts): null where WebGL is unavailable or the page
   *  asked for 2D. What it holds is checked against the source's texture
   *  and triangle list by reference each frame, so a new texture or a
   *  rebuilt mesh is uploaded once, the frame it first draws. */
  renderer: WarpRenderer | null = null;
  private mode: WarpMode;
  private textureFor: HTMLImageElement | null = null;
  private textureOk = false;
  private meshFor: unknown = null;
  private padsFor: unknown = null;
  private padsOutline = false;
  private pads: Float32Array | null = null;
  /** Per triangle, its three edges' pads, where some edge is on the
   *  outline and the outline is left unpadded; null elsewhere. */
  private edgePads: ([number, number, number] | null)[] | null = null;
  private restFor: unknown = null;
  private rest: Point[] | null = null;
  private readonly mouth: ReadonlySet<number>;

  /** `source` is read whenever the warp draws or checks its path. */
  constructor(
    private readonly canvas: HTMLCanvasElement,
    mode: WarpMode,
    mouthIndices: readonly number[] | undefined,
    private readonly source: () => WarpSource
  ) {
    this.mode = mode;
    if (mode !== "2d") this.renderer = WarpRenderer.create(canvas.width, canvas.height);
    this.mouth = new Set(mouthIndices ?? []);
  }

  /** Switch path; false when already on it. */
  setMode(mode: WarpMode): boolean {
    if (mode === this.mode) return false;
    this.mode = mode;
    if (mode === "2d") {
      this.renderer?.destroy();
      this.renderer = null;
    } else {
      this.renderer = WarpRenderer.create(this.canvas.width, this.canvas.height);
    }
    this.textureFor = null;
    this.meshFor = null;
    return true;
  }

  destroy(): void {
    this.renderer?.destroy();
    this.renderer = null;
  }

  /** Which path the next frame takes: "gl" when the GPU warp is ready. */
  path(): "gl" | "2d" {
    return this.ready() ? "gl" : "2d";
  }

  /**
   * The warped mesh at `pts`, drawn into `ctx` through `affine` (the
   * context's own transform): on the GPU as one draw when the renderer is
   * ready, and in 2D, a clipped drawImage per triangle, otherwise (no
   * WebGL, a lost context, a texture it cannot take, `warp: "2d"`).
   *
   * The GPU canvas is already in canvas pixels (it was drawn through
   * `affine`), so it is drawn under the identity: the picture is resampled
   * once either way.
   *
   * The mesh at rest is the picture under it, pixel for pixel, and its
   * outer edge never moves (the deformation leaves the hull where it is),
   * so the warp must leave the canvas exactly as it found it there. Laid
   * over the picture it does wherever the picture is opaque: the edge's
   * anti-aliased share c gives mesh x c + picture x (1 - c), the picture
   * again. Where the picture is half transparent (a cut-out's hair strands
   * and matte fringe, which the neck band reaches at the sides) a pixel
   * laid over itself comes out alpha x (2 - alpha): the band's corners
   * showed as a brighter patch of the hair's edge, a step at the temples,
   * and every overlapping seam pad as a lattice. So over a picture with
   * transparency the mesh REPLACES what is under it, and only where the
   * face moved it. A triangle whose corners all rest where they rest is
   * the picture already under it, pixel for pixel: drawing it could only
   * add the rim twice (and resample what the picture's own draw already
   * drew), so it is not drawn, and at rest nothing is. What moved is drawn
   * on the GPU through its own coverage, which erases the canvas before
   * the mesh is added back (picture x (1 - c) + mesh x c, along a still
   * triangle's edge the picture again), and in 2D the same, triangle by
   * triangle, each through its own (padded) clip: the clip's coverage
   * erased ("destination-out"), the triangle added ("lighter"). No
   * composite operation replaces portably in 2D (a "copy" into an
   * anti-aliased clip blends its edge on one rasterizer and drops what was
   * under it on another: Chromium on Linux drew every triangle's outline
   * as a dark wire), and these two draws share one clip, so they share its
   * coverage exactly. Laid over instead, the neck band, stretched by the
   * jaw while speaking, drew a light line down a cut-out's hair fringe
   * where it crosses it. Erasing the whole moved region first and ADDING
   * the triangles unpadded does not work in 2D: two triangles' coverages
   * along their shared edge need not sum to one (Chrome's came to 1.2), a
   * bright wire along every edge.
   */
  draw(ctx: CanvasRenderingContext2D, pts: Point[], affine: Affine): void {
    const { texture, mesh, replace } = this.source();
    const rest = replace ? this.restPoints() : null;
    const moved = (i: number) => {
      const p = pts[i],
        r = rest![i];
      return !r || Math.abs(p.x - r.x) > STILL_PX || Math.abs(p.y - r.y) > STILL_PX;
    };
    const still = (a: number, b: number, c: number) => !moved(a) && !moved(b) && !moved(c);
    const gl = this.ready();
    if (gl && this.drawGL(ctx, gl, pts, affine, rest ? (a, b, c) => !still(a, b, c) : null)) return;
    const pads = this.trianglePads();
    const edges = this.edgePads;
    let t = 0;
    for (const [a, b, c] of mesh.triangles) {
      const k = t++;
      const pad = pads ? pads[k] : 0;
      if (rest && still(a, b, c)) continue;
      drawWarpedTriangle(ctx, texture, mesh.texPoints, pts, a, b, c, edges?.[k] ?? pad, !!rest);
    }
  }

  /** Does `keep` pass any of the mesh's triangles? */
  private anyTriangle(keep: (a: number, b: number, c: number) => boolean): boolean {
    return this.source().mesh.triangles.some(([a, b, c]) => keep(a, b, c));
  }

  /** Every vertex where it rests, canvas px, in the order the deformation
   *  gives them (the landmarks, the midpoints, the neck band); once per
   *  mesh. */
  private restPoints(): Point[] {
    const { mesh } = this.source();
    if (this.restFor !== mesh.triangles || !this.rest) {
      this.restFor = mesh.triangles;
      const base = mesh.basePoints;
      this.rest = [
        ...base,
        ...mesh.derivedParents.map(([a, b]) => ({ x: (base[a].x + base[b].x) / 2, y: (base[a].y + base[b].y) / 2 })),
        ...mesh.neckBand.map((v) => v.base),
      ];
    }
    return this.rest;
  }

  /**
   * The mesh on the GPU, composited into `ctx`: all of it laid over, or,
   * with `only`, the triangles it passes, replacing what is under them.
   * False when it did not draw, and then `ctx` is as it was, or erased
   * under exactly the triangles the 2D path then draws.
   */
  private drawGL(
    ctx: CanvasRenderingContext2D,
    gl: WarpRenderer,
    pts: Point[],
    affine: Affine,
    only: ((a: number, b: number, c: number) => boolean) | null
  ): boolean {
    // Only the mesh's box is copied: outside it the GPU canvas is clear,
    // so the drawing is the same, and the copy is the one GPU-path cost
    // that grows with the canvas rather than with the mesh. Two pixels
    // of margin for the anti-aliased hull.
    const box = this.box(pts, affine, 2);
    const copy = (op: GlobalCompositeOperation) => {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = op;
      ctx.drawImage(gl.canvas, box.x, box.y, box.w, box.h, box.x, box.y, box.w, box.h);
      ctx.restore();
    };
    if (only) {
      // Nothing moved: nothing to draw (and nothing selected for any other
      // reason: the 2D path draws it).
      if (!gl.select(only)) return !this.anyTriangle(only);
      if (!gl.drawCoverage(pts, affine, true)) return false;
      copy("destination-out");
      if (!gl.draw(pts, affine, true)) return false;
      copy("lighter");
      return true;
    }
    if (!gl.draw(pts, affine)) return false;
    copy("source-over");
    return true;
  }

  /**
   * Each triangle's overlap with its neighbours, px. Worked out once per
   * mesh. A pixel everywhere for a character profile and for any flat
   * picture, whose drawn lines thread through every seam; for a photograph,
   * a pixel wherever the lower-face rig can move the mesh over the still
   * picture (the jaw, the chin, the cheeks, the neck band: the lit neck
   * showed through the seams of the dropped chin as a faint lattice), and
   * none about the eyes and forehead, which draw exactly as they always
   * did. Half a pixel where the lips' own drawn line crosses the mesh.
   */
  trianglePads(): Float32Array | null {
    const { mesh, padEverywhere, lowerFace, unpadOutline } = this.source();
    if (this.padsFor !== mesh.triangles || !this.pads || this.padsOutline !== !!unpadOutline) {
      this.padsFor = mesh.triangles;
      this.padsOutline = !!unpadOutline;
      const rig = lowerFace;
      const moves = (i: number) =>
        i >= LANDMARK_COUNT || (!!rig && (rig.jaw[i] > 0 || rig.weight[i] > 0 || rig.cheek[i] > 0));
      this.pads = Float32Array.from(mesh.triangles, ([a, b, c]) =>
        this.touchesMouth(mesh, a, b, c) ? 0.45 : padEverywhere || moves(a) || moves(b) || moves(c) ? 1 : 0
      );
      // With the head turning in depth, the outline's edges unpadded: a
      // pad there drew the triangle a pixel past the picture it meets,
      // extrapolated, and on a layered avatar's collar, where the picture
      // around the neck band is the layers through their own warp, that
      // pixel stepped the lapel's edge (a 4-level line, 2D path only).
      this.edgePads = unpadOutline ? outlineEdgePads(mesh.triangles, this.pads) : null;
    }
    return this.pads;
  }

  /** Does a triangle touch the lips (the rig's mouth points, or a vertex the
   *  mouth subdivision added)? */
  private touchesMouth(mesh: FaceMesh, a: number, b: number, c: number): boolean {
    const set = this.mouth;
    const mouthy = (i: number): boolean => {
      if (i < LANDMARK_COUNT) return set.has(i);
      const parents = mesh.derivedParents[i - LANDMARK_COUNT];
      return !!parents && (set.has(parents[0]) || set.has(parents[1]));
    };
    return mouthy(a) || mouthy(b) || mouthy(c);
  }

  /**
   * The GPU warp, brought up to date with the source (canvas size, the
   * texture, the mesh), or null when the frame must be drawn in 2D.
   */
  private ready(): WarpRenderer | null {
    const gl = this.renderer;
    if (!gl || !gl.available) return null;
    gl.resize(this.canvas.width, this.canvas.height);
    const { texture, mesh } = this.source();
    if (this.textureFor !== texture) {
      this.textureFor = texture;
      this.textureOk = gl.setTexture(texture);
      // The mesh's texture coordinates are over this texture's size.
      this.meshFor = null;
    }
    if (!this.textureOk) return null;
    if (this.meshFor !== mesh.triangles) {
      this.meshFor = mesh.triangles;
      gl.setMesh(buildWarpMesh(mesh.texPoints, mesh.triangles, texture.naturalWidth, texture.naturalHeight));
    }
    return gl;
  }

  /** The mesh's bounding box on the canvas, through `affine`, grown by
   *  `margin` px and clipped to the canvas; whole pixels. */
  private box(pts: Point[], affine: Affine, margin: number): Rect {
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (const p of pts) {
      const x = affine.a * p.x + affine.c * p.y + affine.e;
      const y = affine.b * p.x + affine.d * p.y + affine.f;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    const cw = this.canvas.width,
      ch = this.canvas.height;
    const x = Math.max(0, Math.floor(x0 - margin)),
      y = Math.max(0, Math.floor(y0 - margin));
    const w = Math.min(cw, Math.ceil(x1 + margin)) - x,
      h = Math.min(ch, Math.ceil(y1 + margin)) - y;
    return w > 0 && h > 0 ? { x, y, w, h } : { x: 0, y: 0, w: cw, h: ch };
  }
}

/** Per triangle, its edges' pads with the mesh's outer boundary's at 0,
 *  for the triangles with such an edge (null for the rest). */
function outlineEdgePads(
  triangles: readonly (readonly [number, number, number])[],
  pads: Float32Array
): ([number, number, number] | null)[] {
  const key = (i: number, j: number) => (i < j ? i * 1048576 + j : j * 1048576 + i);
  const count = new Map<number, number>();
  for (const [a, b, c] of triangles)
    for (const k of [key(a, b), key(b, c), key(c, a)]) count.set(k, (count.get(k) ?? 0) + 1);
  return triangles.map(([a, b, c], t) => {
    const outer = [key(a, b), key(b, c), key(c, a)].map((k) => count.get(k) === 1);
    if (!outer.some(Boolean)) return null;
    const p = pads[t];
    return [outer[0] ? 0 : p, outer[1] ? 0 : p, outer[2] ? 0 : p];
  });
}

/**
 * Draw one texture triangle warped to its deformed destination.
 * Affine solved with Cramer's rule; degenerate triangles are skipped.
 * `replace`: the triangle replaces what is under it instead of being laid
 * over it.
 */
export function drawWarpedTriangle(
  ctx: CanvasRenderingContext2D,
  texture: HTMLImageElement,
  texPoints: readonly Point[],
  pts: Point[],
  i0: number,
  i1: number,
  i2: number,
  pad: number | readonly [number, number, number] = 0,
  replace = false
): void {
  const s0 = texPoints[i0],
    s1 = texPoints[i1],
    s2 = texPoints[i2];
  const d0 = pts[i0],
    d1 = pts[i1],
    d2 = pts[i2];

  const det = s0.x * (s1.y - s2.y) + s1.x * (s2.y - s0.y) + s2.x * (s0.y - s1.y);
  if (Math.abs(det) < 1e-6) return;

  const a = (d0.x * (s1.y - s2.y) + d1.x * (s2.y - s0.y) + d2.x * (s0.y - s1.y)) / det;
  const c = (d0.x * (s2.x - s1.x) + d1.x * (s0.x - s2.x) + d2.x * (s1.x - s0.x)) / det;
  const e =
    (d0.x * (s1.x * s2.y - s2.x * s1.y) + d1.x * (s2.x * s0.y - s0.x * s2.y) + d2.x * (s0.x * s1.y - s1.x * s0.y)) /
    det;
  const b = (d0.y * (s1.y - s2.y) + d1.y * (s2.y - s0.y) + d2.y * (s0.y - s1.y)) / det;
  const d = (d0.y * (s2.x - s1.x) + d1.y * (s0.x - s2.x) + d2.y * (s1.x - s0.x)) / det;
  const f =
    (d0.y * (s1.x * s2.y - s2.x * s1.y) + d1.y * (s2.x * s0.y - s0.x * s2.y) + d2.y * (s0.x * s1.y - s1.x * s0.y)) /
    det;

  ctx.save();
  ctx.beginPath();
  // Inflate the clip triangle to hide the seams between triangles: a
  // little in proportion on every triangle, plus `pad` px of edge offset
  // where the mesh moves over the still picture (seam-pad.ts). Less where
  // a thin drawn line crosses the triangles, as the lips do: a wide
  // overlap would redraw a pixel of it from the wrong triangle.
  const [g0, g1, g2] = typeof pad === "number" ? padTriangle(d0, d1, d2, pad) : padTriangle(d0, d1, d2, 0, 0.015, pad);
  ctx.moveTo(g0.x, g0.y);
  ctx.lineTo(g1.x, g1.y);
  ctx.lineTo(g2.x, g2.y);
  ctx.closePath();
  ctx.clip();
  if (replace) {
    // What is under the triangle out by the clip's coverage c, the
    // triangle added at c: canvas x (1 - c) + triangle x c, the "copy" a
    // composite operation cannot do portably (MeshWarp.draw). The two
    // draws share the clip, so they share its coverage, pixel for pixel.
    // The fill is the clip's own box, a pixel round: a rectangle of a
    // million pixels a side erased whole boxes round the face on Linux
    // Chromium's software canvas, clip or no clip.
    ctx.globalCompositeOperation = "destination-out";
    ctx.fillStyle = "#fff";
    const x0 = Math.min(g0.x, g1.x, g2.x) - 1,
      y0 = Math.min(g0.y, g1.y, g2.y) - 1;
    ctx.fillRect(x0, y0, Math.max(g0.x, g1.x, g2.x) + 1 - x0, Math.max(g0.y, g1.y, g2.y) + 1 - y0);
    ctx.globalCompositeOperation = "lighter";
  }
  ctx.transform(a, b, c, d, e, f);
  ctx.drawImage(texture, 0, 0);
  ctx.restore();
}
