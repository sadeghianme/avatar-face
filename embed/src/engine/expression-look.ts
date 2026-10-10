/**
 * Whether a person's picture is a photograph (docs/emotions.md, "Skin
 * cues"): only a photograph takes the shaded skin cues. On a drawn,
 * rendered or airbrushed face (a 3D-styled character laid out as a person,
 * a cartoon uploaded as a human) a shaded fold reads as a line painted
 * across clean skin, so those faces move but are not shaded.
 *
 * Read once per face from two signs, both measured on the 13 production
 * avatars and the 4 development faces:
 *
 * - The eyes' opening, lid to lid, in IODs: a person's at rest is
 *   0.13-0.19; a stylised face's large drawn eyes 0.21-0.27 (and a cat's
 *   0.59). Below APERTURE_DRAWN the face is a photograph's.
 * - The skin's grain: the fine detail of the cheeks' texture (pores,
 *   noise, the camera's own), the spread of each texel's luminance from
 *   its 3x3 neighbourhood's mean, as a share of the skin's light. A
 *   photograph keeps some even when it was smoothed; a render's or a
 *   painting's skin is flat. A face with large eyes is still a photograph
 *   when its skin has grain (a wide-eyed person).
 *
 * Without a readable picture (a cross-origin texture) the eyes decide.
 */
import type { Point } from "./geometry";

/** At or above this opening (IODs) the eyes are a drawn face's. */
export const APERTURE_DRAWN = 0.2;
/** At or above this grain (percent of the skin's light) the skin is a
 *  photograph's. */
export const SKIN_GRAIN = 2;
/** The cheeks' patches the grain is read on, and their half size (IODs). */
const PATCHES = [50, 280, 205, 425] as const;
const PATCH_HALF = 0.07;
/** At most this many texels across a patch are read. */
const PATCH_TEXELS = 36;

export interface LookReading {
  /** The eyes' mean opening at rest, IODs. */
  readonly aperture: number;
  /** The cheeks' grain (percent), or null when the picture was not read. */
  readonly grain: number | null;
  /** True when the face takes the skin cues. */
  readonly photographic: boolean;
}

/**
 * Read the look of the face resting at `local` (face frame, IODs), its
 * picture's luminance at a face-frame point `luma` (NaN off the picture or
 * on a transparent texel; null when unreadable), one texel being `texel`
 * IODs.
 */
export function readLook(local: readonly Point[], luma: ((p: Point) => number) | null, texel: number): LookReading {
  const gap = (a: number, b: number) => Math.hypot(local[a].x - local[b].x, local[a].y - local[b].y);
  const aperture = (gap(159, 145) + gap(386, 374)) / 2;
  const grain = luma && texel > 0 ? skinGrain(local, luma, texel) : null;
  const photographic = aperture < APERTURE_DRAWN || (grain != null && grain >= SKIN_GRAIN);
  return { aperture, grain, photographic };
}

/** The cheeks' grain: the median over the patches read. */
function skinGrain(local: readonly Point[], luma: (p: Point) => number, texel: number): number | null {
  const found: number[] = [];
  const n = Math.min(PATCH_TEXELS, Math.floor((2 * PATCH_HALF) / texel));
  if (n < 6) return null;
  const at = (x: number, y: number) => luma({ x, y });
  for (const i of PATCHES) {
    const c = local[i];
    let sum = 0,
      sum2 = 0,
      light = 0,
      count = 0;
    for (let j = 0; j < n; j++) {
      for (let k = 0; k < n; k++) {
        const x = c.x + (k - n / 2) * texel,
          y = c.y + (j - n / 2) * texel;
        const v = at(x, y);
        let box = 0,
          m = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const u = at(x + dx * texel, y + dy * texel);
            if (Number.isFinite(u)) {
              box += u;
              m++;
            }
          }
        if (!Number.isFinite(v) || m < 9) continue;
        const d = v - box / m;
        sum += d;
        sum2 += d * d;
        light += v;
        count++;
      }
    }
    if (count < (n * n) / 2 || !(light > 0)) continue;
    const mean = sum / count;
    found.push((Math.sqrt(Math.max(0, sum2 / count - mean * mean)) / (light / count)) * 100);
  }
  if (!found.length) return null;
  found.sort((a, b) => a - b);
  return found[Math.floor(found.length / 2)];
}
