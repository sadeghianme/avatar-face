import { centralMouthAnchors, type MouthExtension, type MouthPoint, type MouthSurfaceFrame } from "../mouth-extension";
import type { BlendWeights, Rig } from "../types";
import { MouthMotion, mouthMixWeights } from "./continuous-mouth-model";
import { cavityReveal, contactSeam, dentalOpening, enamelReveal, openingPath } from "./lip-occlusion-model";
import { validateMotionManifest, type AvatarPerformanceManifest, type MotionManifest } from "./photographic-performance-model";
import { validateOralRig, type OralPhoto } from "./photographic-oral-surface";
import { DentalOralSurface, type TeethOrigin } from "./dental-oral-surface";
import { dentalLighting } from "./dental-lighting-model";
import { ReferenceMouth } from "./reference-mouth";
import { DEFAULT_REFERENCE_PROFILE, type ReferenceProfile } from "./reference-mouth-model";
import { buildLowerFaceRig, type LowerFaceRig } from "../jaw-rig";
import { apertureFeather, CORNER_REACH, edgeSoftness, FeatheredLayer } from "./aperture-feather";

const smooth = (t: number) => {
  const s = Math.max(0, Math.min(1, t));
  return s * s * (3 - 2 * s);
};

/** How much of the inner lip's bands show at a lip gap of `gap` on a mouth
 *  `width` wide, with the interior `interior` revealed: nothing below 0.01
 *  of the width (the contact seam owns that), whole from 0.04; 0 when it
 *  would be too faint to paint. */
export function innerLipStrength(gap: number, width: number, interior: number): number {
  const strength = smooth((gap / width - 0.01) / 0.03) * interior;
  return strength < 0.01 ? 0 : strength;
}

/** The contact seam: a line SEAM_WIDTH of the mouth wide at SEAM_ALPHA (at
 *  full strength), as it was, blurred by 0.006 of the width; drawn instead
 *  as SEAM_STROKES, [width share, alpha share] each, one over the other
 *  (the order makes no difference to the alpha they leave), so the profile
 *  across the line is a stair that fits the blurred one: least squares over
 *  the line, RMS 7.4% of the peak, the area 99.2%, the peak 90% (a
 *  filtered stroke on the face's canvas was a whole-canvas filter pass
 *  between words, 8 ms at 1200 px in software raster). */
export const SEAM_WIDTH = 0.018;
export const SEAM_ALPHA = 0.3;
export const SEAM_STROKES: readonly [number, number][] = [[2.3, 0.1], [1.5, 0.323], [0.8, 0.417]];

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
  /** The layer the interior is painted into and feathered through
   *  (aperture-feather.ts); its canvases are made on the first frame. */
  private layer = new FeatheredLayer();
  /**
   * How much of each pose's displacement a landmark takes (jaw-rig.ts): the
   * lips, the chin and the jaw whole, the lower cheeks fading, the eyes and
   * nose nothing. Built on the motion's own rest pose, whose landmarks the
   * poses are differences from. The radial falloff this replaces reached
   * the chin tip at 0.16, so the chin stayed while the lip dropped onto it.
   */
  private readonly lowerFace: LowerFaceRig;
  /** Throws DentalPhotoError for a teeth photo that does not show the upper
   *  teeth clearly enough to draw them from. `teeth` says whose they are:
   *  the face's own are fitted to it gently, the standard ones fully
   *  (enamel-match-model). */
  constructor(private template: MotionManifest, oral?: OralPhoto, teeth: TeethOrigin = "own") {
    if (oral) this.oral = new DentalOralSurface(oral, teeth);
    this.lowerFace = buildLowerFaceRig(template.poses[0].points.map(([x, y]) => ({ x, y })));
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
      // A landmark the poses may not move keeps whatever the engine's own
      // field did to it; the poses' own drift there (registration) never
      // reaches the face.
      const influence = this.lowerFace.weight[i];
      if (!(influence > 0)) continue;
      const [x, y] = base[i];
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
    // Lips only just apart show their own seam under a soft dark line, then
    // the dark of the mouth, then the teeth as the gap grows (the ramps in
    // lip-occlusion-model). A small aperture is a seam, never a white line.
    const reveal = enamelReveal(gap, width);
    const interior = cavityReveal(gap, width);
    // The edge between the lip and the interior is as sharp as the picture's
    // own crispest edges (face-sharpness.ts, in this frame's pixels; unknown
    // on a flat or tainted picture): the interior is painted into a layer
    // and brought through a mask that fades out inside the lip's edge
    // (aperture-feather.ts).
    const sharp = frame.sharpness !== undefined && frame.pixelScale ? frame.sharpness * frame.pixelScale : undefined;
    const feather = apertureFeather(width, sharp);
    if (this.rounding > 0.02) this.paintMoundShadow(ctx, left, right, width);
    // The rim comes with the interior, squared: lips only just apart show a
    // slit, not a halo.
    this.paintRim(ctx, aperture, feather, edgeSoftness(sharp === undefined ? undefined : sharp / width) * interior * interior, frame.lipColour);
    const layer = this.layer.begin(ctx, ring, feather);
    // Without a layer (no document), straight onto the face, clipped.
    const target = layer ?? ctx;
    if (!layer) { ctx.save(); ctx.clip(aperture); }
    target.globalAlpha = interior;
    if (this.oral) {
      this.oral.draw(target, { ...frame, weights }, left, right, reveal);
    } else {
      this.geometric.draw(target, { weights, viseme: frame.viseme, aperture,
        upper: ring.slice(10), lower: ring.slice(0, 11), neutralLeft: left, neutralRight: right,
        lipColour: frame.lipColour ?? [150, 90, 84], skinColour: frame.skinColour, cavityAlpha: interior, teethAlpha: reveal },
      openingPath(dentalOpening(ring, left, right, weights)));
    }
    const innerLip = innerLipStrength(gap, width, interior);
    const paintInnerLip = (c: CanvasRenderingContext2D) => this.paintInnerLip(c, ring, width, gap, feather, innerLip, frame.lipColour);
    if (layer) {
      if (innerLip > 0) this.layer.blurred(paintInnerLip, feather * 0.5);
      // The corners (ring[0], ring[10]) stay crisp: the feather tapers to a
      // cut at the tips of a wide smile.
      this.layer.end(ctx, aperture, feather, { points: [ring[0], ring[10]], reach: width * CORNER_REACH });
    } else {
      if (innerLip > 0) paintInnerLip(ctx);
      ctx.restore();
    }
    this.paintContactSeam(ctx, ring, width, contactSeam(gap, width), frame.lipColour);
    return true;
  }

  /**
   * The inner lip, just inside the edge: a band of the lips' own inner tone
   * fading into the dark of the mouth (the wet vermilion turning the corner),
   * and under the upper lip, which overhangs, the shadow it casts on the top
   * of the teeth, as every photograph of an open mouth shows. Widths with
   * the feather and the opening; stronger above than below (the lower lip
   * is lit from above, and rolls out rather than over); nothing while the
   * lips are only just apart, where the contact seam owns the aperture.
   * Painted into the layer through one blur of half the feather (its
   * steps run together), and the mask feathers its outer half away with
   * the rest of the interior.
   */
  private paintInnerLip(ctx: CanvasRenderingContext2D, ring: readonly MouthPoint[], width: number, gap: number, feather: number, strength: number, lipColour?: [number, number, number]): void {
    if (strength <= 0 || ring.length < 20) return;
    const light = dentalLighting(lipColour);
    const lip = lipColour ?? [150, 90, 84];
    const wet = lip.map((c, i) => c + (light.tissue[i] - c) * 0.5);
    const upper = [...ring.slice(10), ring[0]], lower = ring.slice(0, 11);
    const band = (line: readonly MouthPoint[], depth: number, colour: readonly number[], alphas: readonly number[]) => {
      ctx.beginPath(); ctx.moveTo(line[0].x, line[0].y);
      for (let k = 1; k < line.length; k++) ctx.lineTo(line[k].x, line[k].y);
      // Three strokes centred on the edge, the widest first: a band that
      // fades inward in steps the blur runs together.
      [1, 0.6, 0.3].forEach((share, i) => {
        ctx.lineWidth = Math.max(1, 2 * depth * share);
        ctx.strokeStyle = `rgba(${colour.map(Math.round).join(",")},${(alphas[i] * strength).toFixed(3)})`;
        ctx.stroke();
      });
    };
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.lineJoin = "round"; ctx.lineCap = "round";
    // The upper lip's shadow on the teeth: as deep as the opening allows.
    band(upper, Math.min(width * 0.05, Math.max(feather * 1.5, gap * 0.14)), light.recess, [0.1, 0.12, 0.15]);
    // The lower lip's wet inner edge: narrower, in the lip's own tone.
    band(lower, Math.min(width * 0.025, Math.max(feather * 0.8, gap * 0.06)), wet, [0.1, 0.12, 0.14]);
    ctx.restore();
  }

  /**
   * The rim: on the lip side of the edge, the faint dark halo a soft
   * picture's own edges carry (its blur spreads the dark of the mouth a
   * little onto the lip, as the mask, which only fades inward, cannot).
   * Scaled by how soft the picture is and how far the interior shows:
   * nothing on a crisp photograph, nothing on lips only just apart. Under
   * the interior, so inside the edge it only deepens the feather.
   */
  private paintRim(ctx: CanvasRenderingContext2D, aperture: Path2D, feather: number, amount: number, lipColour?: [number, number, number]): void {
    if (amount < 0.01) return;
    const shade = dentalLighting(lipColour).cavity;
    ctx.save();
    ctx.lineJoin = "round";
    for (const [k, a] of [[5, 0.02], [2.6, 0.04], [1.2, 0.07]] as const) {
      ctx.strokeStyle = `rgba(${shade.join(",")},${(a * amount).toFixed(3)})`;
      ctx.lineWidth = Math.max(1, feather * k);
      ctx.stroke(aperture);
    }
    ctx.restore();
  }

  /**
   * The soft dark line where the lips meet, in the lips' own shadow colour
   * (the engine's contact line, for the classic mouth, is the same idea):
   * strongest while the aperture is a slit the teeth are not yet in, gone
   * as they arrive. Down the middle of the aperture, each lower-lip point
   * paired with the upper-lip point across from it, so a smile's bow or a
   * tilted head keeps the line on the seam. Stacked round-capped strokes
   * (SEAM_STROKES), not a filtered one: no filter pass on the face's canvas.
   */
  private paintContactSeam(ctx: CanvasRenderingContext2D, ring: readonly MouthPoint[], width: number, strength: number, lipColour?: [number, number, number]): void {
    const alpha = SEAM_ALPHA * strength;
    if (alpha < 0.01 || ring.length < 20) return;
    const seam: MouthPoint[] = [];
    for (let k = 0; k <= 10; k++) {
      const a = ring[k], b = ring[(20 - k) % 20];
      seam.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    }
    const shade = dentalLighting(lipColour).cavity;
    ctx.save();
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.beginPath(); ctx.moveTo(seam[0].x, seam[0].y);
    for (let k = 1; k < seam.length; k++) ctx.lineTo(seam[k].x, seam[k].y);
    for (const [share, scale] of SEAM_STROKES) {
      ctx.strokeStyle = `rgba(${shade.join(",")},${(alpha * scale).toFixed(3)})`;
      ctx.lineWidth = Math.max(1, width * SEAM_WIDTH * share);
      ctx.stroke();
    }
    ctx.restore();
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
