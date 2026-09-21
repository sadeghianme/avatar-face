import type { MouthExtension, MouthFrame, MouthPoint } from "../mouth-extension";
import type { BlendWeights, Rig } from "../types";
import {
  createDentalArch, createTongue, enamelExposure, normalizeProfile, projectOralPoint, rotateJaw,
  type OralSurface, type ReferenceProfile, type Vec3,
} from "./reference-mouth-model";

/** Software-projected 3D oral surfaces under the photo's existing lip mask.
 * The fallback for a portrait with no teeth photo: generic geometry, so what
 * makes it belong to a face is entirely how it is LIT — see sceneLight. */
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
    // Never near-black. A mouth is a lit red space; at 0.22 of the lip colour
    // the cavity rendered as a hole punched in the face, the same fault the
    // classic interior had before it was derived from the lips at 0.3-0.62.
    const cavity = ctx.createRadialGradient(cx, cy + width * 0.06, 0, cx, cy, width * 0.58);
    cavity.addColorStop(0, `rgb(${r * 0.32},${g * 0.2},${b * 0.21})`);
    cavity.addColorStop(1, `rgb(${r * 0.5},${g * 0.32},${b * 0.33})`);
    ctx.globalAlpha = Math.max(frame.cavityAlpha, frame.teethAlpha * 0.85);
    ctx.fillStyle = cavity;
    ctx.fillRect(cx - width, cy - width, width * 2, width * 2);

    const now = performance.now();
    const targetLift = frame.viseme === "TH" ? 0.95 : frame.viseme === "nn" || frame.viseme === "DD" ? 0.65 : 0;
    this.tongueLift += (targetLift - this.tongueLift) * (1 - Math.exp(-Math.min(100, now - this.lastDraw) / 45));
    this.lastDraw = now;
    const jaw = w.jawOpen * this.profile.jawRange;
    const surfaces: (OralSurface & { lower?: boolean })[] = [
      createTongue(this.tongueLift, jaw),
      ...this.upper,
      ...this.lower.map(s => ({ ...s, lower: true, vertices: s.vertices.map(p => rotateJaw(p, jaw)) })),
    ];
    // The continuous module supplies a moving inner-lip opening. Preserve
    // the previous prototype's behaviour when that optional mask is absent.
    const exposure = enamelAperture ? 1 : enamelExposure(w);
    const light = sceneLight(frame.skinColour ?? null, frame.lipColour);
    const enamel = litEnamel(this.profile.warmth, frame.skinColour ?? frame.lipColour, light);
    const tongue: [number, number, number] = [r * 0.9, g * 0.72, b * 0.74];
    const faces = surfaces.flatMap(surface => surface.triangles.map(indices => {
      const vertices = indices.map(i => surface.vertices[i]) as [Vec3, Vec3, Vec3];
      return { vertices, material: surface.material, lower: surface.lower === true, depth: vertices.reduce((sum, p) => sum + p.z, 0) / 3 };
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
      // The lower arch sits behind the lower lip and under the upper teeth's
      // shadow; at equal brightness the two rows read as white bars.
      const archShade = face.material === "enamel" && face.lower ? LOWER_ARCH_SHADE : 1;
      // Enamel is glossy and broadly lit: a 0.74 ambient floor multiplied the
      // whole arch down to grey. The tongue keeps the deeper falloff.
      const ambient = face.material === "enamel" ? 0.86 : 0.74;
      const intensity = (ambient + diffuse * (0.98 - ambient)) * sideShadow * archShade;
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
    // The upper lip overhangs the teeth and shadows them. Without this the
    // enamel is evenly lit to its top edge and reads as a sticker behind a
    // cut-out. Wide and soft first, then a tighter core — the same two-pass
    // shadow the classic interior uses, scaled to the opening.
    const ys = [...frame.upper, ...frame.lower].map(p => p.y);
    const opening = Math.max(1, Math.max(...ys) - Math.min(...ys));
    // Widths are a share of the OPENING, not of the mouth: at the first
    // attempt's 0.55 the two passes covered most of a small opening and the
    // enamel went grey-blue. The shadow is warm (it is lip-coloured light
    // that is missing), never neutral black.
    rim(frame.upper, "rgba(46,16,14,.22)", Math.min(0.07, opening / width * 0.34));
    rim(frame.upper, "rgba(34,10,10,.28)", Math.min(0.03, opening / width * 0.14));
    rim(frame.lower, "rgba(60,22,22,.22)", Math.min(0.04, opening / width * 0.2));
    rim(frame.lower, "rgba(240,195,182,.12)", 0.006);
    // Teeth recede into darkness toward the commissures instead of stopping
    // at a hard end against the lip corner.
    const fade = ctx.createLinearGradient(left.x, left.y, right.x, right.y);
    fade.addColorStop(0, "rgba(30,10,10,.8)");
    fade.addColorStop(0.16, "rgba(30,10,10,.3)");
    fade.addColorStop(0.3, "rgba(30,10,10,0)");
    fade.addColorStop(0.7, "rgba(30,10,10,0)");
    fade.addColorStop(0.84, "rgba(30,10,10,.3)");
    fade.addColorStop(1, "rgba(30,10,10,.8)");
    ctx.fillStyle = fade;
    ctx.fillRect(cx - width, cy - width, width * 2, width * 2);
  }
}

/** How much darker the lower arch is drawn than the upper. */
export const LOWER_ARCH_SHADE = 0.78;

/**
 * Scene exposure, 0.62 (dim) to 1.0 (bright), from mid-cheek skin.
 *
 * Generic teeth at a fixed studio white glare out of any portrait that is
 * not itself studio-lit. The first estimate used the lips, the only colour
 * the renderer was given, and it was wrong in the other direction: lips are
 * darker and more saturated than the light on them, so a brightly lit face
 * with dark lips (sample [133,64,48]) got grey teeth. Skin tracks exposure;
 * lips are only the fallback for a tainted texture, read far more leniently.
 */
export function sceneLight(
  skin: readonly [number, number, number] | null,
  lip: readonly [number, number, number]
): number {
  const luma = (c: readonly [number, number, number]) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
  // Lit skin spans roughly 80 (deep tone or dim room) to 190 (pale, bright).
  // Skin TONE must not be read as darkness, so the ramp saturates early.
  const level = skin ? 0.5 + luma(skin) / 260 : 0.62 + luma(lip) / 400;
  return Math.max(0.62, Math.min(1, level));
}

/** Enamel as this scene would light it: exposed like the face, and carrying
 * a little of its colour cast, because nothing in a warm photo is neutral. */
export function litEnamel(
  warmth: number,
  tone: readonly [number, number, number],
  light: number
): [number, number, number] {
  // Cream, not paper: photographed enamel is warm, and a cool white next to
  // skin reads as grey-blue the moment it is shaded.
  const base = [238, 228 - warmth * 10, 208 - warmth * 20];
  const mean = (tone[0] + tone[1] + tone[2]) / 3;
  // A fraction of the lip's deviation from grey: lips are far redder than
  // the light that falls on them, and at 0.18 a warm portrait's teeth came
  // out pink. A failed or black sample carries no cast at all.
  return base.map((channel, i) => {
    const cast = mean < 8 ? 1 : 1 + ((tone[i] / mean) - 1) * 0.1;
    return Math.round(Math.min(255, channel * light * cast));
  }) as [number, number, number];
}
