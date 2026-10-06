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
  private pads: Float32Array | null = null;
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
   */
  draw(ctx: CanvasRenderingContext2D, pts: Point[], affine: Affine): void {
    const gl = this.ready();
    if (gl && gl.draw(pts, affine)) {
      // Only the mesh's box is copied: outside it the GPU canvas is clear,
      // so the drawing is the same, and the copy is the one GPU-path cost
      // that grows with the canvas rather than with the mesh. Two pixels
      // of margin for the anti-aliased hull.
      const box = this.box(pts, affine, 2);
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(gl.canvas, box.x, box.y, box.w, box.h, box.x, box.y, box.w, box.h);
      ctx.restore();
      return;
    }
    const { texture, mesh } = this.source();
    const pads = this.trianglePads();
    let t = 0;
    for (const [a, b, c] of mesh.triangles) {
      drawWarpedTriangle(ctx, texture, mesh.texPoints, pts, a, b, c, pads ? pads[t++] : 0);
    }
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
    const { mesh, padEverywhere, lowerFace } = this.source();
    if (this.padsFor !== mesh.triangles || !this.pads) {
      this.padsFor = mesh.triangles;
      const rig = lowerFace;
      const moves = (i: number) =>
        i >= LANDMARK_COUNT || (!!rig && (rig.jaw[i] > 0 || rig.weight[i] > 0 || rig.cheek[i] > 0));
      this.pads = Float32Array.from(mesh.triangles, ([a, b, c]) =>
        this.touchesMouth(mesh, a, b, c) ? 0.45 : padEverywhere || moves(a) || moves(b) || moves(c) ? 1 : 0
      );
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

/**
 * Draw one texture triangle warped to its deformed destination.
 * Affine solved with Cramer's rule; degenerate triangles are skipped.
 */
function drawWarpedTriangle(
  ctx: CanvasRenderingContext2D,
  texture: HTMLImageElement,
  texPoints: readonly Point[],
  pts: Point[],
  i0: number,
  i1: number,
  i2: number,
  pad = 0
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
  const [g0, g1, g2] = padTriangle(d0, d1, d2, pad);
  ctx.moveTo(g0.x, g0.y);
  ctx.lineTo(g1.x, g1.y);
  ctx.lineTo(g2.x, g2.y);
  ctx.closePath();
  ctx.clip();
  ctx.transform(a, b, c, d, e, f);
  ctx.drawImage(texture, 0, 0);
  ctx.restore();
}
