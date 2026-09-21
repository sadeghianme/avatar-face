import type { MouthExtension, MouthFrame, MouthPoint } from "../mouth-extension";
import type { BlendWeights, Rig } from "../types";
import {
  createDentalArch, createTongue, enamelExposure, normalizeProfile, projectOralPoint, rotateJaw,
  type OralSurface, type ReferenceProfile, type Vec3,
} from "./reference-mouth-model";

/** Software-projected 3D oral surfaces under the photo's existing lip mask.
 * Intentionally lab-only. This is not a reconstructed, person-specific mouth. */
export class ReferenceMouth implements MouthExtension {
  private profile: ReferenceProfile;
  private upper: OralSurface[];
  private lower: OralSurface[];
  private tongueLift = 0;
  private lastDraw = 0;

  constructor(profile: ReferenceProfile) {
    this.profile = normalizeProfile(profile);
    this.upper = createDentalArch(false, this.profile);
    this.lower = createDentalArch(true, this.profile);
  }

  setProfile(profile: ReferenceProfile): void {
    this.profile = normalizeProfile(profile);
    this.upper = createDentalArch(false, this.profile);
    this.lower = createDentalArch(true, this.profile);
  }

  deform(points: MouthPoint[], neutral: readonly MouthPoint[], rig: Rig, w: BlendWeights): void {
    const ring = rig.outer_lip_ring.map(i => neutral[i]).filter(Boolean);
    if (ring.length < 4) return;
    const minX = Math.min(...ring.map(p => p.x)), maxX = Math.max(...ring.map(p => p.x));
    const cx = (minX + maxX) / 2, cy = ring.reduce((sum, p) => sum + p.y, 0) / ring.length;
    const width = maxX - minX;
    if (width < 2) return;
    const rounding = Math.min(1, w.mouthPucker + w.mouthFunnel * 0.6);
    const contact = Math.min(1, w.mouthClose * w.mouthStretch * 5) * (1 - rounding) ** 2;
    const upperLip = new Set([
      ...rig.outer_lip_ring.slice(Math.floor(rig.outer_lip_ring.length / 2) + 1),
      ...rig.inner_lip_ring.slice(Math.floor(rig.inner_lip_ring.length / 2) + 1),
    ]);
    // Project a shallow lip mound toward the camera. This acts continuously
    // on neighbouring skin too; a lip-only offset would tear mesh edges.
    for (let i = 0; i < neutral.length; i++) {
      const dx = neutral[i].x - cx, dy = neutral[i].y - cy;
      const r = (dx / (width * 0.65)) ** 2 + (dy / (width * 0.27)) ** 2;
      if (r >= 1) continue;
      const z = rounding * this.profile.lipProjection * 0.22 * (1 - r) ** 2;
      const gain = 3 / (3 - z) - 1;
      points[i].x += (points[i].x - cx) * gain;
      points[i].y += (points[i].y - cy) * gain;
      // For F/V, retract the upper lip enough to expose the fixed incisal
      // edge. Bilabials have no stretch, so they cannot trigger this field.
      const upperShare = upperLip.has(i) ? 1 : Math.max(0, Math.min(1, -dy / (width * 0.09)));
      points[i].y -= contact * width * 0.035 * upperShare * (1 - r) ** 2;
    }
  }

  draw(ctx: CanvasRenderingContext2D, frame: MouthFrame, enamelAperture?: Path2D): void {
    const { neutralLeft: left, neutralRight: right, weights: w } = frame;
    const width = Math.hypot(right.x - left.x, right.y - left.y);
    if (width < 2) return;
    const cx = (left.x + right.x) / 2, cy = (left.y + right.y) / 2;
    ctx.clip(frame.aperture);
    const [r, g, b] = frame.lipColour;
    const cavity = ctx.createRadialGradient(cx, cy + width * 0.06, 0, cx, cy, width * 0.58);
    cavity.addColorStop(0, `rgb(${r * 0.22},${g * 0.13},${b * 0.14})`);
    cavity.addColorStop(1, `rgb(${r * 0.4},${g * 0.23},${b * 0.25})`);
    ctx.globalAlpha = Math.max(frame.cavityAlpha, frame.teethAlpha * 0.85);
    ctx.fillStyle = cavity;
    ctx.fillRect(cx - width, cy - width, width * 2, width * 2);

    const now = performance.now();
    const targetLift = frame.viseme === "TH" ? 0.95 : frame.viseme === "nn" || frame.viseme === "DD" ? 0.65 : 0;
    this.tongueLift += (targetLift - this.tongueLift) * (1 - Math.exp(-Math.min(100, now - this.lastDraw) / 45));
    this.lastDraw = now;
    const jaw = w.jawOpen * this.profile.jawRange;
    const surfaces = [
      createTongue(this.tongueLift, jaw),
      ...this.upper,
      ...this.lower.map(s => ({ ...s, vertices: s.vertices.map(p => rotateJaw(p, jaw)) })),
    ];
    // The continuous module supplies a moving inner-lip opening. Preserve
    // the previous prototype's behaviour when that optional mask is absent.
    const exposure = enamelAperture ? 1 : enamelExposure(w);
    const enamel: [number, number, number] = [232, 230 - this.profile.warmth * 10, 224 - this.profile.warmth * 18];
    const tongue: [number, number, number] = [r * 0.9, g * 0.72, b * 0.74];
    const faces = surfaces.flatMap(surface => surface.triangles.map(indices => {
      const vertices = indices.map(i => surface.vertices[i]) as [Vec3, Vec3, Vec3];
      return { vertices, material: surface.material, depth: vertices.reduce((sum, p) => sum + p.z, 0) / 3 };
    })).sort((a, b2) => a.depth - b2.depth);
    for (const face of faces) {
      if (face.material === "enamel" && exposure <= 0) continue;
      const [a, b2, c] = face.vertices;
      const ux = b2.x - a.x, uy = b2.y - a.y, uz = b2.z - a.z;
      const vx = c.x - a.x, vy = c.y - a.y, vz = c.z - a.z;
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      if (nz < 0) { nx = -nx; ny = -ny; nz = -nz; }
      const normalLength = Math.hypot(nx, ny, nz);
      if (normalLength < 1e-10) continue;
      const clipped = face.material === "enamel" && enamelAperture;
      if (clipped) { ctx.save(); ctx.clip(enamelAperture); }
      const diffuse = Math.max(0, (nx * -0.2 + ny * -0.5 + nz * 0.84) / normalLength);
      const sideShadow = Math.max(0.28, 1 - Math.abs((a.x + b2.x + c.x) / 3) * 1.7);
      const intensity = (0.74 + diffuse * 0.24) * sideShadow;
      const color = face.material === "enamel" ? enamel : tongue;
      ctx.fillStyle = `rgb(${color.map(channel => Math.round(channel * intensity)).join(",")})`;
      ctx.globalAlpha = face.material === "enamel" ? frame.teethAlpha * exposure : frame.cavityAlpha;
      const projected = face.vertices.map(p => projectOralPoint(p, left, right));
      ctx.beginPath(); ctx.moveTo(projected[0].x, projected[0].y);
      ctx.lineTo(projected[1].x, projected[1].y); ctx.lineTo(projected[2].x, projected[2].y); ctx.closePath();
      ctx.fill();
      // Subpixel overlap prevents background-colored cracks between facets.
      ctx.strokeStyle = ctx.fillStyle; ctx.lineWidth = 0.35; ctx.stroke();
      if (clipped) ctx.restore();
    }
    const rim = (points: MouthPoint[], color: string, thickness: number) => {
      ctx.beginPath(); ctx.moveTo(points[0].x, points[0].y);
      points.slice(1).forEach(p => ctx.lineTo(p.x, p.y));
      ctx.strokeStyle = color; ctx.lineWidth = width * thickness; ctx.lineJoin = "round"; ctx.stroke();
    };
    ctx.globalAlpha = Math.max(frame.cavityAlpha, frame.teethAlpha);
    rim(frame.upper, "rgba(24,8,8,.35)", 0.012);
    rim(frame.lower, "rgba(50,16,18,.35)", 0.016);
    rim(frame.lower, "rgba(240,195,182,.12)", 0.006);
  }
}
