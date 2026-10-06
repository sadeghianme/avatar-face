/**
 * The continuous mouth's seam: what tests read of a loaded ContinuousMouth
 * without drawing it — which motion it plays and whether its teeth come
 * from a photograph. As the engines' seams (engine/seam.ts): not the
 * embed's API, in no bundle, and read by bracket access so that TypeScript
 * checks every name against the mouth's own private members.
 */
import type { MouthExtension } from "../mouth-extension";
import type { ContinuousMouth } from "./continuous-mouth";
import { DentalOralSurface, type TeethOrigin } from "./dental-oral-surface";
import type { DentalLayer } from "./dental-texture-model";
import type { EnamelSample } from "./enamel-match-model";

/**
 * What a DentalOralSurface knows once it has read its photograph: the two
 * arches (a texture each and the layer it came from), the lower incisal
 * edge, the enamel measured, whose teeth they are. A test that draws a
 * surface sets these directly instead of reading a real photograph.
 */
export interface DentalSurfaceState {
  arches: { canvas: object; layer: Pick<DentalLayer, "count" | "box"> }[];
  lowerIncisal: number;
  enamel: EnamelSample;
  origin: TeethOrigin;
}

/** A DentalOralSurface in `state`, its photograph never read. */
export function dentalSurfaceIn(state: DentalSurfaceState): DentalOralSurface {
  const surface = Object.create(DentalOralSurface.prototype) as DentalOralSurface;
  // Read once by name, so that a member renamed or dropped fails here, at
  // compile time, rather than leaving the test drawing an empty surface.
  void [
    surface["arches"],
    surface["lowerIncisal"],
    surface["enamel"],
    surface["origin"],
    surface["fitted"],
    surface["profile"],
  ];
  return Object.assign(surface, { fitted: null, ...state });
}

export interface ContinuousMouthSeam {
  /** The motion it plays, by its manifest's character: "lab-reference-v1"
   *  for the bundled Reference, "avatar-v1:…" for an avatar's own. */
  readonly character: string;
  /** Whether it draws the teeth from a photograph (the owner's or the
   *  standard teeth) rather than painting them. */
  readonly teethPhoto: boolean;
}

/** The seam of `mouth`. Live: it reads the mouth on every access. */
export function continuousMouthSeam(mouth: ContinuousMouth): ContinuousMouthSeam {
  return {
    get character() {
      return mouth["template"].character;
    },
    get teethPhoto() {
      return mouth["oral"] !== undefined;
    },
  };
}

/** The seam of the continuous mouth an engine draws with, or null when it
 *  draws the classic mouth. `extension` is what the engine holds; a mouth
 *  loaded through another copy of the module (a bundle, a reset module
 *  registry) is the same class by shape, not by identity. */
export function attachedMouthSeam(extension: MouthExtension | undefined): ContinuousMouthSeam | null {
  if (!extension) return null;
  const mouth = extension as ContinuousMouth;
  if (mouth["template"] === undefined) throw new Error("the engine's mouth is not a continuous mouth");
  return continuousMouthSeam(mouth);
}
