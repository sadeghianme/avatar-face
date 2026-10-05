import type { MouthPoint, MouthSurfaceFrame } from "../mouth-extension";
import { dentalCrownCoverage, dentalPlacement, extractDentalLayers, type DentalLayer } from "./dental-texture-model";
import { validateOralRig, type OralPhoto } from "./photographic-oral-surface";
import { DEFAULT_REFERENCE_PROFILE, normalizeProfile, type ReferenceProfile } from "./reference-mouth-model";
import { dentalLighting, ENAMEL_EDGE_STOPS, ORAL_CORNER_STOPS } from "./dental-lighting-model";
import { dentalOpening, openingPath } from "./lip-occlusion-model";
import { enamelMatch, sampleEnamel, type EnamelMatch, type EnamelSample, type FaceLook } from "./enamel-match-model";

export class DentalPhotoError extends Error {
  constructor() { super("The mouth photo needs a clearer view of the upper teeth."); this.name = "DentalPhotoError"; }
}

/** Whose teeth a photo shows: the face's own (its kit, or the Reference's
 *  own photo in the lab) or the standard teeth borrowed from the Reference. */
export type TeethOrigin = "own" | "standard";

interface Arch { canvas: HTMLCanvasElement; layer: DentalLayer }

/** One photo-derived enamel surface per arch. No source lips or frozen
 * mouth-opening texture are drawn into the animated mouth. */
export class DentalOralSurface {
  /** The arches as extracted from the photo, lit as the photo lit them. */
  private arches: Arch[];
  private lowerIncisal = 0;
  private profile = { ...DEFAULT_REFERENCE_PROFILE };
  /** The upper arch measured for the match (enamel-match-model). */
  readonly enamel: EnamelSample;
  /** The arches fitted to one face, built on the first frame that face is
   *  known and kept while its sampled values hold (the texture upgrading
   *  from the thumbnail changes them once). */
  private fitted: { key: string; match: EnamelMatch; arches: Arch[] } | null = null;
  constructor(photo: OralPhoto, private readonly origin: TeethOrigin = "own") {
    const canvas = document.createElement("canvas"); canvas.width = 640; canvas.height = 480;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    const { points, image_size, inner_lip_ring } = validateOralRig(photo.rig);
    const a = points[61], b = points[291], width = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const ux = (b[0] - a[0]) / width, uy = (b[1] - a[1]) / width;
    const cx = points[13][0], cy = points[13][1], scale = 512 / width;
    const point = (id: number) => ({ x: 320 + ((points[id][0] - cx) * ux + (points[id][1] - cy) * uy) * scale,
      y: 120 + (-(points[id][0] - cx) * uy + (points[id][1] - cy) * ux) * scale });
    ctx.setTransform(ux * scale, -uy * scale, uy * scale, ux * scale,
      320 - (cx * ux + cy * uy) * scale, 120 - (-cx * uy + cy * ux) * scale);
    ctx.beginPath();
    inner_lip_ring.forEach((id, i) => { const p = points[id]; if (!i) ctx.moveTo(p[0], p[1]); else ctx.lineTo(p[0], p[1]); });
    ctx.closePath(); ctx.clip(); ctx.drawImage(photo.image, 0, 0, image_size[0], image_size[1]);
    const ring = inner_lip_ring.map(point);
    const source = ctx.getImageData(0, 0, 640, 480);
    const layers = extractDentalLayers(source, [...ring.slice(10), ring[0]], ring.slice(0, 11));
    if (layers[0].box.width < 110 || layers[0].count < 180 || dentalCrownCoverage(layers[0], 320, 512) < .10) throw new DentalPhotoError();
    this.enamel = sampleEnamel(layers[0], source);
    const edges: number[] = [];
    for (let x = 308; x <= 332; x++) for (let y = 0; y < 480; y++) {
      if (layers[1].pixels.data[(y * 640 + x) * 4 + 3] < 150) continue;
      edges.push(y); break;
    }
    if (edges.length) this.lowerIncisal = edges.sort((a, b) => a - b)[Math.floor(edges.length / 2)] - layers[1].box.y;
    this.arches = layers.map(layer => {
      const texture = document.createElement("canvas"); texture.width = 640; texture.height = 480;
      const target = texture.getContext("2d")!;
      const pixels = target.createImageData(640, 480);
      pixels.data.set(layer.pixels.data);
      target.putImageData(pixels, 0, 0);
      target.save(); target.globalCompositeOperation = "source-atop";
      const edgeLight = target.createLinearGradient(64, 0, 576, 0);
      for (const [position, alpha] of ENAMEL_EDGE_STOPS) edgeLight.addColorStop(position, `rgba(54,42,44,${alpha})`);
      target.fillStyle = edgeLight; target.fillRect(0, 0, 640, 480); target.restore();
      return { canvas: texture, layer };
    });
  }
  setProfile(profile: ReferenceProfile): void { this.profile = normalizeProfile(profile); }

  /** How the enamel was fitted to the face it is drawn into; null before
   *  the first frame. */
  get match(): EnamelMatch | null { return this.fitted?.match ?? null; }

  /** The arches as this face lights them (enamel-match-model), fitted once
   *  per face and reused every frame after. `width` is the mouth's, in the
   *  frame's pixels: the picture's sharpness is taken as a share of it. */
  private fit(frame: MouthSurfaceFrame, width: number): Arch[] {
    const sharp = frame.sharpness !== undefined && frame.pixelScale && width > 0 ? (frame.sharpness * frame.pixelScale) / width : undefined;
    const face: FaceLook = { lip: frame.lipColour ?? [150, 90, 84], skin: frame.skinColour, highlight: frame.faceHighlight, sharp };
    const key = [face.lip, face.skin ?? "-", face.highlight ?? "-", sharp === undefined ? "-" : sharp.toFixed(5)].join("/");
    if (this.fitted?.key === key) return this.fitted.arches;
    const match = enamelMatch(face, this.enamel, this.origin === "own");
    this.fitted = { key, match, arches: this.arches.map(arch => ({ layer: arch.layer, canvas: fitTexture(arch.canvas, match) })) };
    return this.fitted.arches;
  }

  /** `teethAlpha` is how much of the teeth shows through the lips (the
   *  enamel reveal); the cavity behind them is always whole. */
  draw(ctx: CanvasRenderingContext2D, frame: MouthSurfaceFrame, left: MouthPoint, right: MouthPoint, teethAlpha = 1): void {
    const width = Math.hypot(right.x - left.x, right.y - left.y);
    const angle = Math.atan2(right.y - left.y, right.x - left.x);
    const cx = (left.x + right.x) / 2, cy = (left.y + right.y) / 2;
    // Lower incisal edge follows the chin/lower-lip displacement, not the
    // opening between two lips (upper-lip retraction is not jaw movement).
    const lower = frame.points[14];
    const descent = (-(lower.x - cx) * Math.sin(angle) + (lower.y - cy) * Math.cos(angle)) / width;
    const jaw = Math.max(0, Math.min(1, descent / .32));
    const light = dentalLighting(frame.lipColour, this.profile.warmth);
    const opening = dentalOpening(frame.rig.inner_lip_ring.map(i => frame.points[i]), left, right, frame.weights);
    // Construct in local mouth coordinates because the cavity and dental pass
    // below run under one rigid translate/rotate/scale transform.
    const enamelClip = openingPath(opening.map(p => ({
      x: ((p.x - cx) * Math.cos(angle) + (p.y - cy) * Math.sin(angle)) / width,
      y: (-(p.x - cx) * Math.sin(angle) + (p.y - cy) * Math.cos(angle)) / width,
    })));
    const rgb = (colour: readonly number[]) => `rgb(${colour.join(",")})`;
    const arches = this.fit(frame, width);
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(angle); ctx.scale(width, width);
    const cavity = ctx.createRadialGradient(0, .04, .01, 0, .12, .49);
    cavity.addColorStop(0, rgb(light.recess));
    cavity.addColorStop(.65, rgb(light.cavity));
    cavity.addColorStop(1, rgb(light.tissue));
    ctx.fillStyle = cavity; ctx.fillRect(-.8, -.5, 1.6, 1.3);
    const tongueY = .11 + jaw * .1;
    const tongue = ctx.createRadialGradient(0, tongueY, .008, 0, tongueY + .06, .29);
    tongue.addColorStop(0, `rgba(${light.floor.join(",")},.88)`);
    tongue.addColorStop(.7, `rgba(${light.cavity.join(",")},.52)`);
    tongue.addColorStop(1, `rgba(${light.cavity.join(",")},0)`);
    ctx.fillStyle = tongue; ctx.fillRect(-.4, .05, .8, .5);
    // Oral corners recede, but their shadow must not blacken the outer crowns.
    // The source teeth already have natural depth shading. Composite the
    // cavity falloff before the dental arches instead of over the whole mouth.
    const sides = ctx.createLinearGradient(-.5, 0, .5, 0);
    for (const [position, alpha] of ORAL_CORNER_STOPS) {
      sides.addColorStop(position, `rgba(${light.recess.join(",")},${alpha})`);
    }
    ctx.fillStyle = sides; ctx.fillRect(-.7, -.4, 1.4, 1.1);
    if (teethAlpha > .004) for (const i of [1, 0]) {
      const arch = arches[i];
      const box = arch.layer.box;
      if (!box.width || !box.height || arch.layer.count < 100) continue;
      const p = dentalPlacement(i === 1, box.width, box.height, this.profile.teethScale, this.profile.teethY, jaw, this.lowerIncisal);
      p.x = (box.x - 320) / 512 * this.profile.teethScale;
      ctx.save();
      ctx.clip(enamelClip);
      if (i === 1) {
        // Reveal the lower arch spatially below the upper incisal edge. A
        // shallow opening must not dissolve the entire lower row or let it
        // intersect the fixed upper crowns.
        ctx.beginPath(); ctx.rect(-.8, .055 + this.profile.teethY + .045, 1.6, 1.3); ctx.clip();
      }
      ctx.globalAlpha = Math.min(1, teethAlpha);
      ctx.filter = `brightness(${light.enamelBrightness}) sepia(${light.enamelSepia})`;
      ctx.drawImage(arch.canvas, box.x, box.y, box.width, box.height, p.x, p.y, p.width, p.height);
      ctx.restore();
    }
    ctx.restore();
    const upper = frame.rig.inner_lip_ring.slice(10).map(i => frame.points[i]);
    ctx.save(); ctx.beginPath(); ctx.moveTo(upper[0].x, upper[0].y);
    upper.slice(1).forEach(p => ctx.lineTo(p.x, p.y));
    // A narrow contact shadow, not a dark band painted across the crowns.
    ctx.filter = `blur(${width * .008}px)`;
    ctx.strokeStyle = `rgba(${light.recess.join(",")},.22)`; ctx.lineWidth = width * .014; ctx.lineJoin = "round"; ctx.stroke(); ctx.restore();
  }
}

/** `source` softened and tinted as `match` says, on a canvas of its own.
 *  The blur is the canvas's; the per-channel gain is applied to the pixels,
 *  since no canvas filter scales channels apart. */
function fitTexture(source: HTMLCanvasElement, match: EnamelMatch): HTMLCanvasElement {
  const plain = match.blur <= 0 && match.gain.every(g => Math.abs(g - 1) < 1e-3);
  if (plain) return source;
  const texture = document.createElement("canvas"); texture.width = source.width; texture.height = source.height;
  const ctx = texture.getContext("2d", { willReadFrequently: true })!;
  if (match.blur > 0) ctx.filter = `blur(${match.blur.toFixed(2)}px)`;
  ctx.drawImage(source, 0, 0);
  ctx.filter = "none";
  if (match.gain.some(g => Math.abs(g - 1) >= 1e-3)) {
    const pixels = ctx.getImageData(0, 0, texture.width, texture.height);
    const data = pixels.data;
    const [r, g, b] = match.gain;
    for (let i = 0; i < data.length; i += 4) {
      if (!data[i + 3]) continue;
      data[i] = data[i] * r; data[i + 1] = data[i + 1] * g; data[i + 2] = data[i + 2] * b;
    }
    ctx.putImageData(pixels, 0, 0);
  }
  return texture;
}
