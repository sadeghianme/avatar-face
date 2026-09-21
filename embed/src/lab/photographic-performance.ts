import type { MouthExtension, MouthPoint, MouthSurfaceFrame } from "../mouth-extension";
import type { BlendWeights, Rig } from "../types";
import { performanceInfluence, performanceMix, validatePerformanceManifest,
  type PerformanceManifest, type XY } from "../mouth/photographic-performance-model";

interface TextureTriangle { ids: [number, number, number]; inverse: number[]; origin: XY }

function textureTriangle(ids: [number, number, number], uv: XY[], image: HTMLImageElement): TextureTriangle | null {
  const [a, b, c] = ids.map(i => [uv[i][0] * image.naturalWidth, uv[i][1] * image.naturalHeight]);
  const bx = b[0] - a[0], by = b[1] - a[1], cx = c[0] - a[0], cy = c[1] - a[1];
  const det = bx * cy - by * cx;
  if (Math.abs(det) < .005) return null;
  return { ids, origin: a as XY, inverse: [cy / det, -cx / det, -by / det, bx / det] };
}

/** Registered photographic keyframes: lips, mouth cavity and adjacent tissue
 * move together. A common mesh aligns texture before blending, so transitions
 * are not dissolves between two differently positioned mouths.
 *
 * This character-specific path is only selected for the authored reference.
 * It does not pretend to reconstruct unseen anatomy from arbitrary uploads.
 */
export class PhotographicPerformance implements MouthExtension {
  private mix: number[] = [];
  private lastTime = 0;
  private layer = document.createElement("canvas");
  private composite = document.createElement("canvas");
  private interior = document.createElement("canvas");
  private mask = document.createElement("canvas");
  private triangles: TextureTriangle[][];
  private ctx = this.layer.getContext("2d")!;
  private blend = this.composite.getContext("2d")!;
  private maskKey = "";
  private movement = 1;
  readonly diagnostics = { frames: 0, renderMs: 0, maxRenderMs: 0 };

  constructor(readonly manifest: PerformanceManifest, private images: HTMLImageElement[]) {
    this.mix = manifest.poses.map((_, i) => i === 0 ? 1 : 0);
    this.triangles = manifest.poses.map((pose, i) => manifest.triangles
      .map(ids => textureTriangle(ids, pose.source, images[i])).filter((t): t is TextureTriangle => Boolean(t)));
  }

  static async load(url: string, signal?: AbortSignal): Promise<PhotographicPerformance> {
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error("Photographic character could not load");
    const manifest = validatePerformanceManifest(await response.json());
    const base = new URL(url, location.href);
    const images = await Promise.all(manifest.poses.map(async pose => {
      const image = new Image(); image.decoding = "async";
      image.src = new URL(pose.image, base).href;
      await image.decode();
      if (signal?.aborted) throw new DOMException("Character load cancelled", "AbortError");
      return image;
    }));
    return new PhotographicPerformance(manifest, images);
  }

  setMovement(value: number): void { this.movement = Math.max(.65, Math.min(1.15, value)); }

  deform(points: MouthPoint[], neutral: readonly MouthPoint[], rig: Rig, weights: BlendWeights): void {
    const now = performance.now();
    const target = performanceMix(weights);
    // Short, time-based blend prevents jumps when the closest authored edge
    // changes. Closing consonants reach the seal faster than vowel travel.
    const dt = this.lastTime ? Math.min(80, now - this.lastTime) : 80;
    const alpha = 1 - Math.exp(-dt / (weights.mouthClose > .68 ? 9 : 22));
    this.lastTime = now;
    this.mix = this.mix.map((v, i) => v + (target[i] - v) * alpha);
    const base = this.manifest.poses[0].points;
    const [cx, cy] = this.manifest.center, width = this.manifest.mouth_width;
    const sx = (neutral[263].x - neutral[33].x) / (base[263][0] - base[33][0]);
    const sy = sx * rig.image_size[1] / rig.image_size[0];
    for (let i = 0; i < base.length; i++) {
      const [x, y] = base[i];
      if (Math.abs(x - cx) > width * 1.5 || y < cy - width || y > cy + width * 1.5) continue;
      const influence = performanceInfluence(x, y, this.manifest.center, width);
      let dx = 0, dy = 0;
      for (let p = 1; p < this.mix.length; p++) {
        dx += (this.manifest.poses[p].points[i][0] - x) * this.mix[p];
        dy += (this.manifest.poses[p].points[i][1] - y) * this.mix[p];
      }
      points[i].x = neutral[i].x + dx * influence * sx * this.movement;
      points[i].y = neutral[i].y + dy * influence * sy * this.movement;
    }
  }

  paint(output: CanvasRenderingContext2D, frame: MouthSurfaceFrame): boolean {
    const start = performance.now();
    const { width, height } = output.canvas;
    for (const canvas of [this.layer, this.composite, this.mask, this.interior]) {
      if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; this.maskKey = ""; }
    }
    const base = this.manifest.poses[0].points;
    const scale = (frame.neutral[263].x - frame.neutral[33].x) / (base[263][0] - base[33][0]);
    const ox = frame.neutral[33].x - base[33][0] * scale;
    const oy = frame.neutral[33].y - base[33][1] * scale;
    const [mx, my] = this.manifest.center;
    const mw = this.manifest.mouth_width * scale;
    const maskKey = `${width}:${height}:${scale}:${ox}:${oy}`;
    if (maskKey !== this.maskKey) {
      const mask = this.mask.getContext("2d")!;
      mask.clearRect(0, 0, width, height); mask.save();
      // Original skin is warped by the same character geometry. The photo
      // replacement only needs the lip mound and a narrow band of skin.
      mask.translate(ox + mx * scale, oy + my * scale + mw * .1); mask.scale(mw * .78, mw * .7);
      const feather = mask.createRadialGradient(0, 0, .67, 0, 0, 1);
      feather.addColorStop(0, "rgba(255,255,255,1)");
      feather.addColorStop(.45, "rgba(255,255,255,.82)");
      feather.addColorStop(1, "rgba(255,255,255,0)");
      mask.fillStyle = feather; mask.fillRect(-1, -1, 2, 2); mask.restore();
      // Nose registration is not an expression. Keep the source nose fully
      // intact and feather into the philtrum below it.
      mask.save(); mask.globalCompositeOperation = "destination-in";
      const top = oy + my * scale - mw * .4;
      const vertical = mask.createLinearGradient(0, top, 0, top + mw * .22);
      vertical.addColorStop(0, "rgba(255,255,255,0)");
      vertical.addColorStop(1, "rgba(255,255,255,1)");
      mask.fillStyle = vertical; mask.fillRect(0, 0, width, height); mask.restore();
      this.maskKey = maskKey;
    }
    const blend = this.blend;
    blend.clearRect(0, 0, width, height);
    const interior = this.interior.getContext("2d")!;
    interior.clearRect(0, 0, width, height);
    const selected = this.mix.map((weight, i) => ({ weight, i })).filter(p => p.weight > .003);
    const sum = selected.reduce((n, p) => n + p.weight, 0);
    // A closing aperture hides teeth geometrically. Dissolving an open oral
    // photograph into closed-lip pixels makes teeth look translucent instead.
    const gap = Math.hypot(frame.points[13].x - frame.points[14].x, frame.points[13].y - frame.points[14].y);
    const interiorSum = selected.reduce((n, p) => n + (p.i > 0 ? p.weight ** 3 : 0), 0);
    for (const { weight, i } of selected) {
      const ctx = this.ctx;
      ctx.clearRect(0, 0, width, height);
      for (const triangle of this.triangles[i]) {
        const [a, b, c] = triangle.ids.map(id => frame.points[id]);
        const [s0, s1, s2, s3] = triangle.inverse;
        const bx = b.x - a.x, by = b.y - a.y, cx = c.x - a.x, cy = c.y - a.y;
        if (Math.abs(bx * cy - by * cx) < .015) continue;
        const A = bx * s0 + cx * s2, B = by * s0 + cy * s2;
        const C = bx * s1 + cx * s3, D = by * s1 + cy * s3;
        const [u, v] = triangle.origin;
        ctx.save(); ctx.beginPath();
        // Extend each triangle slightly into its neighbours. The full pose is
        // blended once, rather than compounding alpha along triangle edges.
        const centerX = (a.x + b.x + c.x) / 3, centerY = (a.y + b.y + c.y) / 3;
        for (const [k, p] of [a, b, c].entries()) {
          const length = Math.hypot(p.x - centerX, p.y - centerY) || 1;
          const x = p.x + (p.x - centerX) / length * .4, y = p.y + (p.y - centerY) / length * .4;
          if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.closePath(); ctx.clip();
        ctx.transform(A, B, C, D, a.x - A * u - C * v, a.y - B * u - D * v);
        ctx.drawImage(this.images[i], 0, 0); ctx.restore();
      }
      blend.globalCompositeOperation = "lighter"; blend.globalAlpha = weight / sum;
      blend.drawImage(this.layer, 0, 0);
      if (i > 0 && interiorSum > .000001) {
        interior.globalCompositeOperation = "lighter"; interior.globalAlpha = weight ** 3 / interiorSum;
        interior.drawImage(this.layer, 0, 0);
      }
    }
    // Appearance transitions are sharper inside the mouth than in surrounding
    // skin. The shared deformed lip ring is the occluder in both cases.
    if (gap > mw * .014 && interiorSum > .000001) {
      blend.save(); blend.globalAlpha = 1; blend.globalCompositeOperation = "source-over";
      blend.beginPath();
      this.manifest.inner_ring.forEach((id, k) => {
        const p = frame.points[id]; if (k === 0) blend.moveTo(p.x, p.y); else blend.lineTo(p.x, p.y);
      });
      blend.closePath(); blend.clip(); blend.drawImage(this.interior, 0, 0); blend.restore();
    }
    blend.globalAlpha = 1; blend.globalCompositeOperation = "destination-in";
    blend.drawImage(this.mask, 0, 0); blend.globalCompositeOperation = "source-over";
    output.drawImage(this.composite, 0, 0);
    const ms = performance.now() - start;
    this.diagnostics.frames++; this.diagnostics.renderMs = ms;
    this.diagnostics.maxRenderMs = Math.max(ms, this.diagnostics.maxRenderMs);
    return true;
  }

  draw(): void { /* paint owns photographic lips and mouth interior. */ }
}
