import type { CharacterTraits } from "./character-mouth";
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
 * it will name. The rigs saved before keep their profile, and so their look,
 * until their owner fits them again.
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
  /** Who moves and paints the mouth: the classic one, made for a photograph
   *  of a person's lips, or the character mouth (character-mouth.ts). */
  readonly mouth: "classic" | "character";
  /** How the lids close: by the mesh alone, or with a lid painted over the
   *  eye (blink-lid.ts). */
  readonly blink: "mesh" | "lid";
  /** The character mouth's own defaults, under the owner's mouth settings.
   *  Unused by the classic mouth. */
  readonly traits: CharacterTraits;
}

export const HUMAN_PROFILE: KindProfile = {
  teeth: true,
  cavityShade: [0.3, 0.46, 0.62],
  tongueFrom: 0.26,
  contactLine: true,
  mouth: "classic",
  blink: "mesh",
  traits: { teeth: "upper", tongue: true, jaw: 1 },
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
      mouth: "classic",
      blink: "mesh",
      traits: { teeth: "none", tongue: true, jaw: 1 },
    },
  ],
  [
    // A drawn or rendered character (the Animation and Cartoon looks): the
    // character mouth, painted flat on cel art and shaded on a render, with
    // the upper teeth a toon wears, and a painted lid on its blinks.
    "toon@1",
    {
      teeth: false,
      cavityShade: [0.3, 0.46, 0.62],
      tongueFrom: 0.1,
      contactLine: false,
      mouth: "character",
      blink: "lid",
      traits: { teeth: "upper", tongue: true, jaw: 1 },
    },
  ],
  [
    // A photographed or rendered animal: the character mouth with a dark open
    // jaw and a tongue, a wider jaw drop and no incisors, and the lid blink.
    "animal@2",
    {
      teeth: false,
      cavityShade: [0.2, 0.3, 0.44],
      tongueFrom: 0.1,
      contactLine: false,
      mouth: "character",
      blink: "lid",
      traits: { teeth: "none", tongue: true, jaw: 1.15 },
    },
  ],
]);

export function kindProfile(rig: Pick<Rig, "render_profile">): KindProfile {
  return (rig.render_profile && PROFILES.get(rig.render_profile)) || HUMAN_PROFILE;
}

/** The profile names this build knows; the backend writes only these. */
export const KNOWN_PROFILES: readonly string[] = [...PROFILES.keys()];
