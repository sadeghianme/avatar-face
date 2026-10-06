/**
 * Fitting a teeth photo to the face it is drawn into.
 *
 * The standard teeth are the Reference's own photographed teeth, and on
 * another face they looked pasted: whiter and cooler than anything in a
 * warm photo, and cleaner than a soft scan. What a photograph's teeth share
 * with its skin is the light: the same cast, the same exposure, the same
 * lens. So the enamel is tinted toward the face's own light, capped at the
 * picture's own brightest point, and softened to the picture's own edges —
 * once, when the face is known, never per frame. A face's OWN teeth photo
 * (its kit, or the Reference's) already carries its palette and gets the
 * same corrections at a fraction of the strength.
 *
 * The owner's "enamel warmth" slider is unchanged by this: at its middle the
 * teeth are as the face lights them, and it still warms or cools from there
 * (dentalLighting), so nothing an owner fitted moves.
 */
export type RGB = readonly [number, number, number];

/** What the picture says about its own light, sampled once by the engine. */
export interface FaceLook {
  lip: RGB;
  /** Mid-cheek skin: the scene's cast and exposure. Absent on a tainted texture. */
  skin?: RGB;
  /** Luma (0-255) of the picture's brightest skin or sclera: its 97th
   *  percentile over the face, read from a box-filtered copy so a specular
   *  pinpoint does not set it. */
  highlight?: number;
  /** The width of the picture's crispest edges as a share of the mouth's
   *  width (face-sharpness.ts: the strong edges round the mouth and the
   *  eyes, a low percentile of their 10-90% rise). Absent when unknown, and
   *  then the enamel is not softened. */
  sharp?: number;
}

/** What the teeth photo is like, measured once from its extracted upper arch. */
export interface EnamelSample {
  /** Each channel's share of the enamel's mean: its colour cast, 1 = grey. */
  cast: RGB;
  /** Luma of the brightest crowns (95th percentile). */
  bright: number;
  /** Edge width inside the enamel, in texture pixels (ENAMEL_TEXTURE_WIDTH
   *  per mouth width). */
  edge: number;
}

export interface EnamelMatch {
  /** Per-channel multipliers for the enamel texture. */
  gain: [number, number, number];
  /** Gaussian blur, in texture pixels, 0 for none. */
  blur: number;
}

/** The enamel carries this share of the skin's cast. Measured on the
 *  Reference: its teeth photo's cast against its portrait's cheeks is 0.31
 *  of the skin's deviation from grey, channel for channel. */
export const TEETH_CHROMA = 0.31;
/** With no skin sample, the lips stand in: far more saturated than the
 *  light on them, so a smaller share. */
export const LIP_CHROMA = 0.1;
/** The Reference's own lips (its portrait, the mouth ring's median): the
 *  light the standard teeth were photographed in, as its lips carry it. A
 *  lips-only tint is a shift from these, since the enamel's own cast cannot
 *  be told from the share of them it carries. */
export const REFERENCE_LIP: RGB = [144, 89, 66];
/** The enamel's brightest crowns may sit a little above the face's own
 *  highlight: luma × the first, plus the second. */
export const HIGHLIGHT_HEADROOM: readonly [number, number] = [1.04, 6];
/** Never dingy: the cap darkens enamel to this share of itself at most. */
export const LUMA_FLOOR = 0.78;
/** A face's own teeth photo gets this share of every correction. */
export const OWN_TEETH_STRENGTH = 0.4;
/** The extraction canvas maps one mouth width to this many pixels. */
export const ENAMEL_TEXTURE_WIDTH = 512;
/** A Gaussian edge's width is about 2.5 sigma, by contrast over steepest
 *  step (the enamel's own edge, sampleEnamel) and by 10-90% rise (the
 *  picture's, face-sharpness.ts: 2.56) alike. */
export const EDGE_TO_SIGMA = 1 / 2.5;
export const MAX_BLUR = 6;
const CHROMA_GAIN_LIMIT: readonly [number, number] = [0.85, 1.15];

const luma = (c: ArrayLike<number>) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const colour = (c: unknown): RGB | undefined =>
  Array.isArray(c) && c.length === 3 && c.every(finite) ? [c[0], c[1], c[2]] : undefined;

/** Each channel's share of the mean, or grey for a black or failed sample. */
function cast(c: RGB): RGB {
  const mean = (c[0] + c[1] + c[2]) / 3;
  return mean < 8 ? [1, 1, 1] : [c[0] / mean, c[1] / mean, c[2] / mean];
}

/** Part of the way from 1 to `g`. */
const partly = (g: number, share: number) => 1 + (g - 1) * share;

export function enamelMatch(face: FaceLook, enamel: EnamelSample, own = false): EnamelMatch {
  const strength = own ? OWN_TEETH_STRENGTH : 1;
  const enamelCast = colour(enamel.cast) ?? [1, 1, 1];

  // Colour: the enamel's cast moved to what this face's light would give it
  // (from the skin: the enamel's own cast is the share of its face's skin
  // cast it carries, so the move is from one to the other; from the lips
  // only: a shift from the Reference's lips), then renormalised so the tint
  // alone changes no luma.
  const skin = colour(face.skin);
  const lip = colour(face.lip);
  const gain: [number, number, number] = [1, 1, 1];
  const tinted = skin
    ? cast(skin).map((c, i) => (enamelCast[i] > 1e-6 ? partly(c, TEETH_CHROMA) / enamelCast[i] : 1))
    : lip && cast(lip).some((c) => c !== 1)
      ? cast(lip).map((c, i) => partly(c, LIP_CHROMA) / partly(cast(REFERENCE_LIP)[i], LIP_CHROMA))
      : null;
  if (tinted) {
    for (let i = 0; i < 3; i++) {
      gain[i] = partly(Math.max(CHROMA_GAIN_LIMIT[0], Math.min(CHROMA_GAIN_LIMIT[1], tinted[i])), strength);
    }
    const level = luma(gain);
    if (level > 1e-6) for (let i = 0; i < 3; i++) gain[i] /= level;
  }

  // Exposure: within the picture's own highlight range, never brighter than
  // it was, never below the floor. A multiplier keeps the cream: grey teeth
  // come from losing chroma, not light.
  if (finite(face.highlight) && finite(enamel.bright) && enamel.bright > 0) {
    const ceiling = face.highlight * HIGHLIGHT_HEADROOM[0] + HIGHLIGHT_HEADROOM[1];
    const cap = partly(Math.max(LUMA_FLOOR, Math.min(1, ceiling / enamel.bright)), strength);
    for (let i = 0; i < 3; i++) gain[i] *= cap;
  }

  // Sharpness: blur until the enamel's edges are as wide as the picture's
  // crispest. Sigmas add in quadrature; a crisp picture, or teeth already
  // softer than it, get nothing; so does a picture whose sharpness is
  // unknown.
  let blur = 0;
  if (finite(face.sharp) && face.sharp > 0) {
    const faceSigma = face.sharp * ENAMEL_TEXTURE_WIDTH * EDGE_TO_SIGMA;
    const ownSigma = (finite(enamel.edge) ? Math.max(0, enamel.edge) : 0) * EDGE_TO_SIGMA;
    blur = Math.sqrt(Math.max(0, faceSigma ** 2 - ownSigma ** 2)) * strength;
    blur = blur < 0.4 ? 0 : Math.min(MAX_BLUR, blur);
  }
  return { gain, blur };
}

/** The upper arch as extracted (DentalLayer pixels: the photo's own RGB where
 *  kept, alpha elsewhere 0) measured for `enamelMatch`: its cast, its
 *  brightest crowns and how wide its edges are. `source` is the whole
 *  extraction canvas the layer was cut from, for edge profiles that run off
 *  the enamel onto the gap or the gum. */
export function sampleEnamel(
  layer: {
    pixels: { width: number; height: number; data: Uint8ClampedArray };
    box: { x: number; y: number; width: number; height: number };
  },
  source: { width: number; height: number; data: Uint8ClampedArray }
): EnamelSample {
  const { width, height, data } = layer.pixels;
  let r = 0,
    g = 0,
    b = 0,
    n = 0;
  const lumas: number[] = [];
  for (let i = 0; i < width * height; i++) {
    if (data[i * 4 + 3] < 40) continue;
    r += data[i * 4];
    g += data[i * 4 + 1];
    b += data[i * 4 + 2];
    n++;
    lumas.push(luma(data.subarray(i * 4, i * 4 + 3)));
  }
  if (!n) return { cast: [1, 1, 1], bright: 0, edge: 0 };
  lumas.sort((p, q) => p - q);
  const widths: number[] = [];
  const { x: bx, y: by, width: bw, height: bh } = layer.box;
  for (let x = bx; x < bx + bw; x += 3)
    for (let y = Math.max(5, by); y < Math.min(height - 5, by + bh); y += 3) {
      if (data[(y * width + x) * 4 + 3] < 40) continue;
      const profile: number[] = [];
      for (let dy = -5; dy <= 5; dy++) {
        const k = ((y + dy) * source.width + x) * 4;
        profile.push(luma(source.data.subarray(k, k + 3)));
      }
      const contrast = Math.max(...profile) - Math.min(...profile);
      if (contrast < 25) continue;
      let steepest = 0;
      for (let i = 0; i + 1 < profile.length; i++) steepest = Math.max(steepest, Math.abs(profile[i + 1] - profile[i]));
      if (steepest > 0) widths.push(contrast / steepest);
    }
  widths.sort((p, q) => p - q);
  return {
    cast: cast([r / n, g / n, b / n]),
    bright: lumas[Math.min(lumas.length - 1, Math.floor(lumas.length * 0.95))],
    edge: widths.length ? widths[Math.floor(widths.length / 2)] : 0,
  };
}
