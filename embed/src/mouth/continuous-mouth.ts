import { centralMouthAnchors, type MouthExtension, type MouthPoint, type MouthSurfaceFrame } from "../mouth-extension";
import type { BlendWeights, Rig } from "../types";
import { MouthMotion, mouthMixWeights } from "./continuous-mouth-model";
import { dentalOpening, openingPath } from "./lip-occlusion-model";
import { performanceInfluence, validateMotionManifest, type AvatarPerformanceManifest, type MotionManifest } from "./photographic-performance-model";
import { validateOralRig, type OralPhoto } from "./photographic-oral-surface";
import { DentalOralSurface } from "./dental-oral-surface";
import { ReferenceMouth } from "./reference-mouth";
import { DEFAULT_REFERENCE_PROFILE, type ReferenceProfile } from "./reference-mouth-model";

/** How much of the corners' inward travel is removed at full rounding. */
export const CORNER_EASE = 0.4;
/** Radial magnification of the lip mound at full rounding. Small: at 0.1 the
 *  lips visibly swelled like a bee sting rather than coming forward. */
export const PROTRUSION = 0.05;

/** Where a teeth photo is: the photo, and its rig (the landmarks on it). */
export interface OralPhotoSource { image_url: string; rig_url: string }

/** A teeth photo served beside a motion file, resolved as the browser
 *  resolved the motion itself (a page-relative URL on the dashboard). */
function besideMotion(motionUrl: string, image: string, rig: string): OralPhotoSource {
  const base = new URL(motionUrl, location.href);
  return { image_url: new URL(image, base).href, rig_url: new URL(rig, base).href };
}

/** The Reference's own teeth photo, served beside its motion (the lab). */
function referenceTeeth(templateUrl: string): OralPhotoSource {
  return besideMotion(templateUrl, "oral-detail-v3.webp", "oral-detail-v3.rig.json");
}

/** The standard teeth, served beside the bundled motion (the API's
 *  mouth-motion.json): the Reference's own teeth photo, cut to its lips
 *  (backend/scripts/build_standard_teeth.py), for an avatar without a
 *  teeth photo of its own. */
export function standardTeeth(motionUrl: string): OralPhotoSource {
  return besideMotion(motionUrl, "mouth-teeth.webp", "mouth-teeth.rig.json");
}

/** A single skin/lip texture plus one stable oral interior. The shared engine
 * warps the user's ORIGINAL photo; this extension never swaps face textures. */
export class ContinuousMouth implements MouthExtension {
  private motion = new MouthMotion();
  private lastTime = 0;
  private movement = 1;
  private rounding = 0;
  private geometric = new ReferenceMouth(DEFAULT_REFERENCE_PROFILE);
  private oral?: DentalOralSurface;
  /** Throws DentalPhotoError for a teeth photo that does not show the upper
   *  teeth clearly enough to draw them from. */
  constructor(private template: MotionManifest, oral?: OralPhoto) {
    if (oral) this.oral = new DentalOralSurface(oral);
  }

  /** `templateUrl` is the bundled Reference motion (mouth-motion.json) or an
   *  avatar's own performance manifest (version 2); both play the same way. */
  static async load(templateUrl: string, oral?: OralPhotoSource | "reference", signal?: AbortSignal): Promise<ContinuousMouth> {
    const template = await ContinuousMouth.loadMotion(templateUrl, signal);
    const photo = oral
      ? await ContinuousMouth.loadOralPhoto(oral === "reference" ? referenceTeeth(templateUrl) : oral, signal)
      : undefined;
    if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
    return new ContinuousMouth(template, photo);
  }

  /** Fetch a motion and check that this mouth can play it: rejects on a
   *  failed request and on a manifest validateMotionManifest refuses. */
  static async loadMotion(url: string, signal?: AbortSignal): Promise<MotionManifest> {
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error("Mouth motion could not load");
    return validateMotionManifest(await response.json());
  }

  /** Decode a teeth photo and fetch its rig. Whether the photo shows the
   *  teeth well enough is decided when the mouth is built, not here. */
  static async loadOralPhoto(source: OralPhotoSource, signal?: AbortSignal): Promise<OralPhoto> {
    const image = new Image(); image.crossOrigin = "anonymous";
    image.src = source.image_url;
    await image.decode();
    const rigResponse = await fetch(source.rig_url, { signal });
    if (!rigResponse.ok) throw new Error("Mouth detail could not load");
    return { image, rig: validateOralRig(await rigResponse.json()) };
  }

  setProfile(profile: ReferenceProfile): void {
    // The jaw range the template's geometry is true at. The Reference's
    // motion was authored for the default 0.85. An avatar's own kit records
    // the range fitted from its own AA, so at that fit its poses play
    // exactly as photographed, and the owner's slider scales from there.
    const measured = this.template.version === 2 ? (this.template as AvatarPerformanceManifest).jaw_range : .85;
    this.movement = Math.max(.65, Math.min(1.3, profile.jawRange / measured));
    this.geometric.setProfile(profile);
    this.oral?.setProfile(profile);
  }

  deform(points: MouthPoint[], neutral: readonly MouthPoint[], _rig: Rig, weights: BlendWeights): void {
    const now = performance.now();
    const mix = this.motion.step(weights, this.lastTime ? (now - this.lastTime) / 1000 : .016);
    this.lastTime = now;
    const base = this.template.poses[0].points;
    const [a, b] = [neutral[61], neutral[291]];
    const width = Math.hypot(b.x - a.x, b.y - a.y);
    if (width < 2 || points.length !== 478 || neutral.length !== 478) return;
    const ux = (b.x - a.x) / width, uy = (b.y - a.y) / width;
    const sourceWidth = this.template.mouth_width;
    const [cx, cy] = this.template.center;
    for (let i = 0; i < base.length; i++) {
      const [x, y] = base[i];
      if (Math.abs(x - cx) > sourceWidth * 1.5 || y < cy - sourceWidth || y > cy + sourceWidth * 1.5) continue;
      const influence = performanceInfluence(x, y, this.template.center, sourceWidth);
      let dx = 0, dy = 0;
      for (let p = 1; p < mix.length; p++) {
        dx += (this.template.poses[p].points[i][0] - x) * mix[p];
        dy += (this.template.poses[p].points[i][1] - y) * mix[p];
      }
      if (this.oral) {
        // The authored F/V photo over-lifts both lips relative to the fixed
        // dental row. Bring their contact back to the incisal edge, with a
        // smooth cheek falloff. The upper teeth themselves never translate.
        const contact = Math.exp(-(((x - cx) / (sourceWidth * .65)) ** 2 + ((y - cy) / (sourceWidth * .35)) ** 2));
        dy += sourceWidth * .05 * mix[5] * contact;
      }
      // Rounded vowels pull the commissures inward by about a quarter of the
      // mouth's width. On a closed-mouth photo that stretches the dark crease
      // at each corner into streaks across the cheek. Roundness reads from
      // the lip shape and the aperture, not from how far the corners travel,
      // so the pull is eased toward the corners and only for rounded poses.
      const lateral = Math.min(1, Math.abs(x - cx) / (sourceWidth * .5));
      dx *= 1 - CORNER_EASE * (mix[3] + mix[4]) * lateral * lateral;
      const scale = width / sourceWidth * influence * this.movement;
      points[i].x = neutral[i].x + (dx * ux - dy * uy) * scale;
      points[i].y = neutral[i].y + (dx * uy + dy * ux) * scale;
    }

    // Protrusion. A rounded vowel pushes the lips toward the camera, and a
    // single photograph has no depth to show it with. What a camera sees of
    // a lip mound is a small radial magnification centred on the mouth,
    // strongest at the lips and gone by the cheeks; the paint pass adds the
    // shadow the mound casts on the skin around it.
    const rounding = Math.min(1, mix[3] + mix[4]);
    if (rounding > 0.01) {
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      for (let i = 0; i < points.length; i++) {
        const dx = points[i].x - mx, dy = points[i].y - my;
        const r = (dx / (width * 0.62)) ** 2 + (dy / (width * 0.42)) ** 2;
        if (r >= 1) continue;
        const gain = PROTRUSION * rounding * (1 - r) ** 2;
        points[i].x += dx * gain;
        points[i].y += dy * gain;
      }
    }
    this.rounding = rounding;
  }

  paint(ctx: CanvasRenderingContext2D, frame: MouthSurfaceFrame): boolean {
    const { points, neutral, rig } = frame;
    const ring = rig.inner_lip_ring.map(i => points[i]);
    const baseRing = rig.inner_lip_ring.map(i => neutral[i]);
    const [left, right] = centralMouthAnchors(baseRing, neutral[61], neutral[291]);
    const width = Math.hypot(right.x - left.x, right.y - left.y);
    const gap = Math.hypot(points[13].x - points[14].x, points[13].y - points[14].y);
    if (width < 2 || gap < width * .008) return true;
    const aperture = openingPath(ring);
    const weights = mouthMixWeights(this.motion.values);
    if (this.rounding > 0.02) this.paintMoundShadow(ctx, left, right, width);
    ctx.save(); ctx.clip(aperture);
    if (this.oral) {
      this.oral.draw(ctx, { ...frame, weights }, left, right);
    } else {
      this.geometric.draw(ctx, { weights, viseme: frame.viseme, aperture,
        upper: ring.slice(10), lower: ring.slice(0, 11), neutralLeft: left, neutralRight: right,
        lipColour: frame.lipColour ?? [150, 90, 84], skinColour: frame.skinColour, cavityAlpha: 1, teethAlpha: 1 },
      openingPath(dentalOpening(ring, left, right, weights)));
    }
    ctx.restore(); return true;
  }
  /** The soft shadow a protruding mouth casts on the skin around it: a ring
   *  just outside the lips, deepest below (light comes from above), fading
   *  to nothing within half a mouth width. Warm, never neutral grey. */
  private paintMoundShadow(ctx: CanvasRenderingContext2D, left: MouthPoint, right: MouthPoint, width: number): void {
    const cx = (left.x + right.x) / 2, cy = (left.y + right.y) / 2 + width * 0.06;
    const alpha = 0.22 * this.rounding;
    const shade = ctx.createRadialGradient(cx, cy, width * 0.3, cx, cy, width * 0.78);
    shade.addColorStop(0, `rgba(70,28,22,${alpha.toFixed(3)})`);
    shade.addColorStop(0.45, `rgba(70,28,22,${(alpha * 0.45).toFixed(3)})`);
    shade.addColorStop(1, "rgba(70,28,22,0)");
    ctx.save();
    ctx.fillStyle = shade;
    ctx.fillRect(cx - width, cy - width, width * 2, width * 2);
    ctx.restore();
  }

  draw(): void { /* paint owns the exact measured lip aperture. */ }
}
