import type { CharacterTraits } from "./character-mouth";
import { ANIMAL_GAINS, HUMAN_GAINS, TOON_GAINS, type ExpressionGains } from "./expression-table";
import type { FaceType, Rig } from "../types";

/**
 * What a line of faces changes in the renderer, and nothing more.
 *
 * Published avatars change only when their owner publishes, so a profile is
 * chosen by the RIG — `render_profile`, written by the backend when the
 * owner saves a fit and shipped inside the published rig — never by the
 * face type or by anything the embedding page says. A rig without one, or
 * with a name this build does not know, renders as a person's photograph:
 * HUMAN_PROFILE is the classic mouth's constants (the golden render tests
 * pin them) and, since 2026-10-08, the head's turn in depth. The head's
 * motion alone is the published face type's to choose when the host passes
 * it (defaultHeadMotion): a rig without a profile is not always a person.
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
  /**
   * How the head moves when neither the page nor the avatar's face type
   * says (defaultHeadMotion): "3d", turning in depth inside the face mesh
   * (head-turn.ts), for a person's photograph, whether opaque, layered or a
   * cut-out; "2d", the rigid layer's shift and roll, for a character or an
   * animal, whose drawn eyes and muzzle the canonical human face does not
   * fit.
   */
  readonly headMotion: "2d" | "3d";
  /** How much of each region of an expression the line takes
   *  (expression-table.ts): a drawn mouth line needs more to read as a
   *  smile, a muzzle has no lip corners to speak of. */
  readonly expression: ExpressionGains;
}

export const HUMAN_PROFILE: KindProfile = {
  teeth: true,
  cavityShade: [0.3, 0.46, 0.62],
  tongueFrom: 0.26,
  contactLine: true,
  mouth: "classic",
  blink: "mesh",
  traits: { teeth: "upper", tongue: true, jaw: 1 },
  headMotion: "3d",
  expression: HUMAN_GAINS,
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
      headMotion: "2d",
      expression: ANIMAL_GAINS,
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
      headMotion: "2d",
      expression: TOON_GAINS,
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
      headMotion: "2d",
      expression: ANIMAL_GAINS,
    },
  ],
]);

export function kindProfile(rig: Pick<Rig, "render_profile">): KindProfile {
  return (rig.render_profile && PROFILES.get(rig.render_profile)) || HUMAN_PROFILE;
}

/**
 * How the head moves unless the page says (EngineOptions.headMotion).
 *
 * The avatar's face type first, when the host passes it (the widget, the
 * share page and the dashboard do; EngineOptions.faceType): the turn in
 * depth for a person, the rigid layer for an animal or a cartoon, whatever
 * its rig. The rig alone cannot tell: one fitted before profiles existed,
 * and a cartoon's with the classic mouth, names none, and would read as a
 * person's photograph. Without a face type (a host from before it was
 * passed), the rig's profile's: "3d" for none or a name this build does not
 * know, "2d" for toon@1, animal@1 and animal@2.
 */
export function defaultHeadMotion(
  profile: Pick<KindProfile, "headMotion">,
  faceType?: FaceType | null
): KindProfile["headMotion"] {
  if (faceType == null) return profile.headMotion;
  return faceType === "human" ? "3d" : "2d";
}

/**
 * How much of an expression this avatar takes (docs/emotions.md,
 * "Characters and animals"): its rig profile's gains, unless the avatar's
 * face type (EngineOptions.faceType) says more. An animal takes the
 * animal's faint, safe amplitudes and no skin cues whatever its rig (a
 * cat fitted with the human profile got a smile that cracked its drawn
 * eyes); a cartoon takes no skin cues (on drawn skin a shaded fold reads as
 * a line drawn across it). Whether a person's picture is a photograph,
 * which alone takes the cues, is read from the picture itself
 * (expression-look.ts).
 */
export function expressionGains(profile: Pick<KindProfile, "expression">, faceType?: FaceType | null): ExpressionGains {
  if (faceType === "animal") return ANIMAL_GAINS;
  if (faceType === "cartoon") return { ...profile.expression, cues: 0 };
  return profile.expression;
}

/** The profile names this build knows; the backend writes only these. */
export const KNOWN_PROFILES: readonly string[] = [...PROFILES.keys()];
