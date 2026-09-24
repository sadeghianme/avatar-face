import type { Rig } from "./types";

/**
 * What a line of faces changes in the renderer, and nothing more.
 *
 * Published avatars change only when their owner publishes, so a profile is
 * chosen by the RIG — `render_profile`, written by the backend when the
 * owner saves a fit and shipped inside the published rig — never by the
 * face type or by anything the embedding page says. A rig without one, or
 * with a name this build does not know, renders exactly as before profiles
 * existed: HUMAN_PROFILE is today's constants, and the golden render tests
 * pin that.
 *
 * Deliberately narrow. Each field replaces one constant at one place in the
 * classic mouth; a profile is versioned ("animal@1") so that changing what
 * an animal looks like means adding "animal@2", which only rigs saved after
 * it will name.
 */
export interface KindProfile {
  /** Incisor rows in the mouth interior. A muzzle shows none. */
  readonly teeth: boolean;
  /** The cavity's shade at its top, middle and bottom, as multiples of the
   *  face's own lip colour. Lower is darker. */
  readonly cavityShade: readonly [number, number, number];
  /** Opening (aperture height over mouth width) at which the tongue starts
   *  to show; it reaches full strength 0.12 later. */
  readonly tongueFrom: number;
  /** The soft dark line drawn where closed lips meet. */
  readonly contactLine: boolean;
}

export const HUMAN_PROFILE: KindProfile = {
  teeth: true,
  cavityShade: [0.3, 0.46, 0.62],
  tongueFrom: 0.26,
  contactLine: true,
};

const PROFILES: ReadonlyMap<string, KindProfile> = new Map([
  [
    "animal@1",
    {
      // A dog or a cat talking: a dark open jaw with a tongue in it. Human
      // incisors in a muzzle are the giveaway of a pasted-on mouth, and a
      // muzzle has no lips whose meeting line could be shaded.
      teeth: false,
      cavityShade: [0.14, 0.22, 0.34],
      tongueFrom: 0.1,
      contactLine: false,
    },
  ],
]);

export function kindProfile(rig: Pick<Rig, "render_profile">): KindProfile {
  return (rig.render_profile && PROFILES.get(rig.render_profile)) || HUMAN_PROFILE;
}
