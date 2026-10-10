/**
 * The AI expression pictures on a face, each frame (expression-pictures.ts
 * says what they are): the landmarks moved under each picture's mask
 * (`apply`, from deform.ts, in place of the animated expression's own
 * displacement there), and the picture drawn through the moved mesh at its
 * own landmarks (`draw`, right after the warped photo, before the painted
 * eyes and mouth), on the GPU through a warp renderer of its own (one draw
 * per picture shown, its canvas laid over at the expression's weight) and
 * in 2D triangle by triangle where the GPU warp is not running.
 */
import type { Affine } from "./affine";
import type { ExpressionRig, ShapeMix } from "./expression-rig";
import { NONE } from "./expression-rig";
import {
  PauseSmile,
  layPicture,
  pictureUV,
  type LaidPicture,
  type LoadedPicture,
  type PictureName,
} from "./expression-pictures";
import type { MaskField } from "./expression-picture-masks";
import type { FaceMesh, Point } from "./geometry";
import { LANDMARK_COUNT } from "./landmarks";
import { drawWarpedTriangle } from "./mesh-warp";
import { WarpRenderer } from "./warp-gl";
import { buildWarpMesh, type WarpMesh } from "./warp-mesh";

/** Which part of the pictures a draw lays: the face, or the silent smile's mouth. */
export type OverlayPart = "face" | "mouth";

/** How long a picture takes to come in once loaded (it never pops). */
export const ARRIVE_MS = 150;

/** One picture shown this frame: its masked texture and its weight. */
interface Shown {
  texture: HTMLCanvasElement;
  laid: LaidPicture;
  alpha: number;
}

/** The picture with `field` as its alpha, at the picture's own size. */
function masked(picture: LoadedPicture, field: MaskField): HTMLCanvasElement {
  const { width, height } = picture.image;
  const mask = document.createElement("canvas");
  mask.width = field.cols;
  mask.height = field.rows;
  const mctx = mask.getContext("2d")!;
  const data = mctx.createImageData(field.cols, field.rows);
  for (let i = 0; i < field.alpha.length; i++) {
    data.data[4 * i] = data.data[4 * i + 1] = data.data[4 * i + 2] = 255;
    data.data[4 * i + 3] = Math.round(field.alpha[i] * 255);
  }
  mctx.putImageData(data, 0, 0);
  const out = document.createElement("canvas");
  out.width = width;
  out.height = height;
  const ctx = out.getContext("2d")!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  // The field is over the picture's longer side in square cells: drawn at
  // its cells' size, it covers the picture and a little past it.
  const cell = Math.max(width, height) / Math.max(field.cols, field.rows);
  ctx.drawImage(mask, 0, 0, field.cols * cell, field.rows * cell);
  ctx.globalCompositeOperation = "source-in";
  ctx.drawImage(picture.image, 0, 0, width, height);
  return out;
}

export class ExpressionPictureLayer {
  readonly smile = new PauseSmile();
  /** How much of the silent smile shows this frame (PauseSmile). */
  smileLevel = 0;
  private laidFor: FaceMesh | null = null;
  private readonly laid = new Map<PictureName, LaidPicture>();
  private readonly textures = new Map<PictureName, { upper: HTMLCanvasElement; mouth: HTMLCanvasElement | null }>();
  private readonly meshes = new Map<PictureName, { uv: Point[]; gl: WarpMesh }>();
  private triangles: [number, number, number][] = [];
  private readonly scratch: Point[] = Array.from({ length: LANDMARK_COUNT }, () => ({ x: 0, y: 0 }));
  private renderer: WarpRenderer | null | undefined;
  /** The mesh the renderer holds now (setMesh uploads on every call). */
  private rendererMesh: WarpMesh | null = null;
  private readonly arrived: number;

  constructor(
    private readonly pictures: readonly LoadedPicture[],
    private readonly base: readonly Point[],
    now: number,
    private readonly gpu: boolean
  ) {
    this.arrived = now;
  }

  /** The expressions that have a picture. */
  get names(): PictureName[] {
    return this.pictures.map((p) => p.name);
  }

  /** How far in the pictures are, 0..1, since they arrived. */
  presence(now: number): number {
    return Math.min(1, Math.max(0, (now - this.arrived) / ARRIVE_MS));
  }

  /** `mix` without the shapes a picture shows (their skin cues are the picture's). */
  withoutPictures(mix: ShapeMix, now: number): ShapeMix {
    const keep = 1 - this.presence(now);
    if (keep >= 1) return mix;
    const out: Record<string, number> = { ...mix };
    for (const p of this.pictures) out[p.name] = (out[p.name] ?? 0) * keep;
    return out as ShapeMix;
  }

  private lay(mesh: FaceMesh): void {
    if (this.laidFor === mesh) return;
    this.laidFor = mesh;
    this.laid.clear();
    this.meshes.clear();
    for (const p of this.pictures) this.laid.set(p.name, layPicture(p, this.base, mesh));
    const faceVertices = mesh.basePoints.length + mesh.derivedParents.length;
    this.triangles = mesh.triangles.filter(([a, b, c]) => {
      if (a >= faceVertices || b >= faceVertices || c >= faceVertices) return false;
      const weight = (i: number) => {
        const k = i < LANDMARK_COUNT ? i : mesh.derivedParents[i - LANDMARK_COUNT][0];
        let w = 0;
        for (const laid of this.laid.values()) w = Math.max(w, laid.upper[k], laid.mouth?.[k] ?? 0);
        return w;
      };
      return weight(a) > 0.002 || weight(b) > 0.002 || weight(c) > 0.002;
    });
  }

  /** Each picture's weight this frame: its expression's, by the pictures' presence. */
  private weights(mix: ShapeMix, scale: number, now: number): [LaidPicture, number][] {
    const presence = this.presence(now) * Math.max(0, scale);
    const out: [LaidPicture, number][] = [];
    for (const laid of this.laid.values()) {
      const w = Math.min(1, mix[laid.picture.name] ?? 0) * presence;
      if (w > 0.001) out.push([laid, w]);
    }
    return out;
  }

  /**
   * Move `pts` (the frame's landmarks, rest at `mesh.basePoints`) by the
   * expressions in `mix` at `scale`: those without a picture by the rig's
   * own displacement (expression-rig.ts); those with one toward where the
   * picture has the landmark under its mask, by the rig's displacement
   * outside it. False when nothing moved.
   */
  apply(pts: Point[], mesh: FaceMesh, mix: ShapeMix, scale: number, rig: ExpressionRig | null, now: number): boolean {
    this.lay(mesh);
    const on = this.weights(mix, scale, now);
    if (!on.length) return rig?.apply(pts, mix, scale) ?? false;
    const others: Record<string, number> = { ...mix };
    const covered: Record<string, number> = { ...NONE };
    for (const [laid] of on) {
      covered[laid.picture.name] = mix[laid.picture.name];
      others[laid.picture.name] = 0;
    }
    rig?.apply(pts, others as ShapeMix, scale);
    // What the animated expressions with a picture would move, from rest.
    const rest = mesh.basePoints;
    const warped = this.scratch;
    for (let i = 0; i < LANDMARK_COUNT; i++) {
      warped[i].x = rest[i].x;
      warped[i].y = rest[i].y;
    }
    const animated = rig ? rig.apply(warped, covered as ShapeMix, scale) : false;
    let total = 0;
    for (const [, w] of on) total += w;
    for (let i = 0; i < LANDMARK_COUNT; i++) {
      let dx = 0,
        dy = 0,
        mask = 0;
      for (const [laid, w] of on) {
        let m = laid.upper[i];
        if (laid.mouth) m = Math.max(m, laid.mouth[i] * this.smileLevel);
        dx += laid.shift[2 * i] * w * m;
        dy += laid.shift[2 * i + 1] * w * m;
        mask += (w / total) * m;
      }
      if (animated) {
        dx += (warped[i].x - rest[i].x) * (1 - mask);
        dy += (warped[i].y - rest[i].y) * (1 - mask);
      }
      pts[i].x += dx;
      pts[i].y += dy;
    }
    return true;
  }

  private textureOf(laid: LaidPicture) {
    const name = laid.picture.name;
    let textures = this.textures.get(name);
    if (!textures) {
      const { masks } = laid.picture;
      textures = {
        upper: masked(laid.picture, masks.upper),
        mouth: masks.mouth ? masked(laid.picture, masks.mouth) : null,
      };
      this.textures.set(name, textures);
    }
    return textures;
  }

  private meshOf(laid: LaidPicture, mesh: FaceMesh, total: number) {
    const name = laid.picture.name;
    let built = this.meshes.get(name);
    if (!built) {
      const uv = pictureUV(laid.picture.entry, mesh, total);
      const [w, h] = laid.picture.entry.size;
      built = { uv, gl: buildWarpMesh(uv, this.triangles, w, h) };
      this.meshes.set(name, built);
    }
    return built;
  }

  /** The pictures shown this frame: their faces, or the silent smile's mouths. */
  private shown(part: OverlayPart, mix: ShapeMix, scale: number, now: number): Shown[] {
    const out: Shown[] = [];
    for (const [laid, w] of this.weights(mix, scale, now)) {
      const textures = this.textureOf(laid);
      if (part === "face") out.push({ texture: textures.upper, laid, alpha: w });
      else if (textures.mouth && this.smileLevel > 0.001)
        out.push({ texture: textures.mouth, laid, alpha: w * this.smileLevel });
    }
    return out;
  }

  /**
   * Draw the pictures shown into `ctx` through the frame's vertices `pts`
   * (all of them, deform.ts) and `affine` (the head's transform, as the
   * warp's): their faces ("face") after the warped photo and before the
   * painted features; the silent smile's mouth ("mouth") after the painted
   * mouth, so the picture's own lips and teeth show, not the mouth
   * painter's teeth in the picture's opening (a smaller row with dark
   * corners: "pasted on", a blind judge said).
   */
  draw(
    ctx: CanvasRenderingContext2D,
    pts: Point[],
    affine: Affine,
    mesh: FaceMesh,
    mix: ShapeMix,
    scale: number,
    now: number,
    part: OverlayPart = "face"
  ): void {
    this.lay(mesh);
    const shown = this.shown(part, mix, scale, now);
    if (!shown.length || !this.triangles.length) return;
    const gl = this.gpu ? this.gl(ctx.canvas.width, ctx.canvas.height) : null;
    for (const s of shown) {
      const built = this.meshOf(s.laid, mesh, pts.length);
      if (gl && this.drawGL(ctx, gl, s, built.gl, pts, affine)) continue;
      ctx.save();
      ctx.globalAlpha = s.alpha;
      for (const [a, b, c] of this.triangles)
        drawWarpedTriangle(ctx, s.texture as unknown as HTMLImageElement, built.uv, pts, a, b, c);
      ctx.restore();
    }
  }

  private gl(width: number, height: number): WarpRenderer | null {
    if (this.renderer === undefined) this.renderer = WarpRenderer.create(width, height, 2 * this.pictures.length);
    if (this.renderer && !this.renderer.available) return null;
    this.renderer?.resize(width, height);
    return this.renderer ?? null;
  }

  private drawGL(
    ctx: CanvasRenderingContext2D,
    gl: WarpRenderer,
    s: Shown,
    mesh: WarpMesh,
    pts: Point[],
    affine: Affine
  ): boolean {
    if (!gl.setTexture(s.texture)) return false;
    if (this.rendererMesh !== mesh) {
      gl.setMesh(mesh);
      this.rendererMesh = mesh;
    }
    if (!gl.draw(pts, affine)) return false;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = s.alpha;
    ctx.drawImage(gl.canvas, 0, 0);
    ctx.restore();
    return true;
  }

  destroy(): void {
    this.renderer?.destroy();
    this.renderer = null;
  }
}
