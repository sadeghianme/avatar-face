/**
 * The continuous mouth, for real avatars.
 *
 * One loader shared by the dashboard preview, the public share page and the
 * embed widget, so an avatar cannot look one way where its owner fits it and
 * another where visitors see it.
 */
import { ContinuousMouth, standardTeeth, type OralPhotoSource } from "./continuous-mouth";
import type { MotionManifest } from "./photographic-performance-model";
import { normalizeProfile, type ReferenceProfile } from "./reference-mouth-model";

export { ContinuousMouth } from "./continuous-mouth";
export type { OralPhotoSource } from "./continuous-mouth";
export { DEFAULT_REFERENCE_PROFILE, PROFILE_LIMITS, normalizeProfile } from "./reference-mouth-model";
export type { ReferenceProfile } from "./reference-mouth-model";
export type { CharacterSettings, ClassicMouthConfig } from "../character-mouth";

/** What the API serves for an avatar whose mouth is not the classic one. */
export interface AvatarMouthConfig {
  renderer: "continuous";
  profile?: Partial<ReferenceProfile> | null;
  /**
   * The avatar's own teeth photo: the owner's second photo, or made by AI
   * from its picture. Absent or null: the standard teeth, served beside the
   * bundled motion (`standardTeeth`).
   */
  oral?: OralPhotoSource | null;
  /**
   * The avatar's own performance manifest (version 2: its six mouth shapes,
   * made from its photo by the backend's performance kit). Absent or null:
   * the bundled Reference motion, retargeted, as every avatar had before.
   */
  motion_url?: string | null;
}

/**
 * Build the mouth an avatar's config asks for. `motionUrl` is the authored
 * motion template (`<api>/mouth-motion.json`), played when the config names
 * no manifest of its own or when that manifest does not load; the standard
 * teeth are served beside it. Rejects on any other failure, the avatar's
 * own teeth photo's included; the caller keeps the classic mouth, which is
 * always a working fallback.
 *
 * The motion is settled first, then the teeth photo is loaded, once. Only
 * the motion has a fallback: the photo is the same whichever motion plays,
 * so a photo that fails with the avatar's own motion fails with the
 * Reference's too. (When one call loaded both, a refused photo read as "the
 * avatar's motion did not load": the bundled motion and the same photo were
 * downloaded again, only for the photo to be refused again.)
 */
export async function loadAvatarMouth(
  config: AvatarMouthConfig,
  motionUrl: string,
  signal?: AbortSignal
): Promise<ContinuousMouth> {
  const template = await avatarMotion(config.motion_url, motionUrl, signal);
  throwIfCancelled(signal);
  const mouth = config.oral
    ? await withOwnTeeth(template, config.oral, signal)
    : await withStandardTeeth(template, motionUrl, signal);
  mouth.setProfile(normalizeProfile(config.profile));
  return mouth;
}

/** The mouth with the avatar's own teeth photo; rejects when it does not
 *  load, and with DentalPhotoError when it does not show the upper teeth
 *  clearly enough to draw them from. */
async function withOwnTeeth(
  template: MotionManifest,
  source: OralPhotoSource,
  signal?: AbortSignal
): Promise<ContinuousMouth> {
  const oral = await ContinuousMouth.loadOralPhoto(source, signal);
  throwIfCancelled(signal);
  return new ContinuousMouth(template, oral);
}

/**
 * The mouth of an avatar without a teeth photo of its own: the standard
 * teeth, the Reference's own photographed teeth, served beside the bundled
 * motion. Drawn teeth in their place looked like a denture on a real face
 * (flat slabs with a seam down the middle, no gum line); the Reference's
 * photo, on the same face, looked like teeth.
 *
 * Nothing about them can fail the mouth: whatever keeps them from being
 * drawn (the network, a decode, a DentalPhotoError, a server that has none)
 * leaves the drawn teeth, as before they existed, and they are not asked
 * for again. A cancelled load still rejects.
 */
async function withStandardTeeth(
  template: MotionManifest,
  motionUrl: string,
  signal?: AbortSignal
): Promise<ContinuousMouth> {
  try {
    const oral = await ContinuousMouth.loadOralPhoto(standardTeeth(motionUrl), signal);
    throwIfCancelled(signal);
    return new ContinuousMouth(template, oral);
  } catch (error) {
    if (signal?.aborted) throw error;
    return new ContinuousMouth(template);
  }
}

/**
 * The avatar's own motion when its config names one that loads, otherwise
 * the bundled Reference motion. A cancelled load is not a failed one: it
 * rejects rather than trying the next.
 */
async function avatarMotion(
  own: string | null | undefined,
  bundled: string,
  signal?: AbortSignal
): Promise<MotionManifest> {
  if (own) {
    try {
      return await ContinuousMouth.loadMotion(own, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      // The avatar's own motion did not load (an expired link, a network
      // blip, a manifest from a newer backend). The Reference motion fits
      // any face: a continuous mouth that is not quite theirs beats the
      // classic one, and far beats none.
    }
  }
  return ContinuousMouth.loadMotion(bundled, signal);
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
}

/** The slice of the engine this module needs; keeps it free of the class. */
interface MouthHost {
  setMouthExtension(extension: ContinuousMouth | null): void;
  tuning: { mouthOpen: number };
}

export interface AttachedMouth {
  /** Refit live, without reloading anything — what a slider calls. */
  setProfile(profile: Partial<ReferenceProfile> | null | undefined): void;
  /** Back to the classic mouth, with the engine's own tuning restored. */
  detach(): void;
}

/**
 * Load an avatar's mouth and put it on a running engine. The one entry point
 * for the dashboard, the share page and the widget: what the owner fits is,
 * by construction, what visitors get.
 *
 * The jaw range also drives the engine's own opening (the chin and cheeks
 * outside the mouth's region still follow the classic field), exactly as in
 * the lab the fit was tuned in.
 */
export async function attachAvatarMouth(
  engine: MouthHost,
  config: AvatarMouthConfig,
  motionUrl: string,
  signal?: AbortSignal
): Promise<AttachedMouth> {
  const mouth = await loadAvatarMouth(config, motionUrl, signal);
  const previousOpen = engine.tuning.mouthOpen;
  const apply = (profile: Partial<ReferenceProfile> | null | undefined) => {
    const fitted = normalizeProfile(profile);
    mouth.setProfile(fitted);
    engine.tuning.mouthOpen = fitted.jawRange;
  };
  apply(config.profile);
  engine.setMouthExtension(mouth);
  return {
    setProfile: apply,
    detach: () => {
      engine.setMouthExtension(null);
      engine.tuning.mouthOpen = previousOpen;
    },
  };
}
