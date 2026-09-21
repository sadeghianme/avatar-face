import type { MouthPoint, MouthSurfaceFrame } from "../mouth-extension";
import type { Rig } from "../types";

export interface OralPhoto { image: HTMLImageElement; rig: Pick<Rig, "points" | "image_size" | "inner_lip_ring" | "outer_lip_ring"> }

export function validateOralRig(value: unknown): OralPhoto["rig"] {
  const rig = value as OralPhoto["rig"] | null;
  if (!rig || !Array.isArray(rig.points) || rig.points.length !== 478 ||
    !rig.points.every(p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite)) ||
    !Array.isArray(rig.image_size) || rig.image_size.length !== 2 || !rig.image_size.every(n => Number.isFinite(n) && n > 0) ||
    ![rig.inner_lip_ring, rig.outer_lip_ring].every(r => Array.isArray(r) && r.length === 20 && new Set(r).size === 20 && r.every(i => Number.isInteger(i) && i >= 0 && i < 478)) ||
    Math.hypot(rig.points[291][0] - rig.points[61][0], rig.points[291][1] - rig.points[61][1]) < 2) {
    throw new Error("Invalid mouth photograph rig");
  }
  return rig;
}

/** One permanent oral photograph, anchored to the skull. The animated lip
 * aperture reveals it; no tooth rows switch, crossfade or stretch with vowels. */
export class PhotographicOralSurface {
  private texture = document.createElement("canvas");
  constructor(photo: OralPhoto) {
    this.texture.width = 768; this.texture.height = 576;
    const ctx = this.texture.getContext("2d")!;
    const { points, image_size, inner_lip_ring } = validateOralRig(photo.rig);
    const a = points[61], b = points[291];
    const width = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (width < 2 || points.length !== 478) throw new Error("Invalid mouth photograph");
    const ux = (b[0] - a[0]) / width, uy = (b[1] - a[1]) / width;
    const cx = (a[0] + b[0]) / 2;
    // Place the upper incisal root just above the neutral seam. This origin
    // is fixed throughout playback, independent of the current aperture.
    const cy = points[13][1] + width * .035;
    const scale = 512 / width;
    ctx.setTransform(ux * scale, -uy * scale, uy * scale, ux * scale,
      384 - (cx * ux + cy * uy) * scale, 192 - (-cx * uy + cy * ux) * scale);
    ctx.beginPath();
    inner_lip_ring.forEach((id, i) => { const p = points[id]; if (!i) ctx.moveTo(p[0], p[1]); else ctx.lineTo(p[0], p[1]); });
    ctx.closePath(); ctx.clip();
    ctx.drawImage(photo.image, 0, 0, image_size[0], image_size[1]);
  }

  draw(ctx: CanvasRenderingContext2D, frame: MouthSurfaceFrame, left: MouthPoint, right: MouthPoint): void {
    const width = Math.hypot(right.x - left.x, right.y - left.y);
    const ux = (right.x - left.x) / width, uy = (right.y - left.y) / width;
    const cx = (left.x + right.x) / 2, cy = (left.y + right.y) / 2;
    ctx.save();
    ctx.translate(cx, cy); ctx.rotate(Math.atan2(uy, ux));
    ctx.drawImage(this.texture, -width * .75, -width * .375, width * 1.5, width * 1.125);
    ctx.restore();
    // Contact shadow is opaque shading, not a second mouth or a tooth fade.
    const upper = frame.rig.inner_lip_ring.slice(10).map(i => frame.points[i]);
    ctx.beginPath(); ctx.moveTo(upper[0].x, upper[0].y);
    upper.slice(1).forEach(p => ctx.lineTo(p.x, p.y));
    ctx.strokeStyle = "rgba(30,8,9,.3)"; ctx.lineWidth = width * .014; ctx.lineJoin = "round"; ctx.stroke();
  }
}
