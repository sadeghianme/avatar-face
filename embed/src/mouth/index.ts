/**
 * The continuous mouth, for real avatars.
 *
 * One loader shared by the dashboard preview, the public share page and the
 * embed widget, so an avatar cannot look one way where its owner fits it and
 * another where visitors see it.
 */
import { ContinuousMouth } from "./continuous-mouth";
import { normalizeProfile, type ReferenceProfile } from "./reference-mouth-model";

export { ContinuousMouth } from "./continuous-mouth";
export { DEFAULT_REFERENCE_PROFILE, PROFILE_LIMITS, normalizeProfile } from "./reference-mouth-model";
export type { ReferenceProfile } from "./reference-mouth-model";

/** What the API serves for an avatar whose mouth is not the classic one. */
export interface AvatarMouthConfig {
  renderer: "continuous";
  profile?: Partial<ReferenceProfile> | null;
  /** The person's own teeth, when they supplied a second photo. */
  oral?: { image_url: string; rig_url: string } | null;
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
 * no manifest of its own. Rejects on any failure; the caller keeps the
 * classic mouth, which is always a working fallback.
 */
export async function loadAvatarMouth(
  config: AvatarMouthConfig,
  motionUrl: string,
  signal?: AbortSignal
): Promise<ContinuousMouth> {
  const oral = config.oral ?? undefined;
  let mouth: ContinuousMouth;
  if (config.motion_url) {
    try {
      mouth = await ContinuousMouth.load(config.motion_url, oral, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      // The avatar's own motion did not load (an expired link, a network
      // blip, a manifest from a newer backend). The Reference motion fits
      // any face: a continuous mouth that is not quite theirs beats the
      // classic one, and far beats none.
      mouth = await ContinuousMouth.load(motionUrl, oral, signal);
    }
  } else {
    mouth = await ContinuousMouth.load(motionUrl, oral, signal);
  }
  mouth.setProfile(normalizeProfile(config.profile));
  return mouth;
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
