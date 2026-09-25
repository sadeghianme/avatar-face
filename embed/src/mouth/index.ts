/**
 * The continuous mouth, for real avatars.
 *
 * One loader shared by the dashboard preview, the public share page and the
 * embed widget, so an avatar cannot look one way where its owner fits it and
 * another where visitors see it.
 */
import { ContinuousMouth, type OralPhotoSource } from "./continuous-mouth";
import type { MotionManifest } from "./photographic-performance-model";
import { normalizeProfile, type ReferenceProfile } from "./reference-mouth-model";

export { ContinuousMouth } from "./continuous-mouth";
export type { OralPhotoSource } from "./continuous-mouth";
export { DEFAULT_REFERENCE_PROFILE, PROFILE_LIMITS, normalizeProfile } from "./reference-mouth-model";
export type { ReferenceProfile } from "./reference-mouth-model";

/** What the API serves for an avatar whose mouth is not the classic one. */
export interface AvatarMouthConfig {
  renderer: "continuous";
  profile?: Partial<ReferenceProfile> | null;
  /** The person's own teeth, when they supplied a second photo. */
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
 * no manifest of its own or when that manifest does not load. Rejects on any
 * other failure, the teeth photo's included; the caller keeps the classic
 * mouth, which is always a working fallback.
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
  const oral = config.oral ? await ContinuousMouth.loadOralPhoto(config.oral, signal) : undefined;
  throwIfCancelled(signal);
  // Throws DentalPhotoError for a photo it cannot draw the teeth from.
  const mouth = new ContinuousMouth(template, oral);
  mouth.setProfile(normalizeProfile(config.profile));
  return mouth;
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
