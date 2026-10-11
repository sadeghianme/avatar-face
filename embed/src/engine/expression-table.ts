/**
 * The expressions, as data (docs/emotions.md): their names, how each moves
 * the brows (as rigid strips, expression-brows.ts), the lids, the cheeks
 * and the mouth's corners (regions, expression-rig.ts), which skin cues it
 * shades (expression-shading.ts), and how much of it each line of faces
 * takes.
 *
 * Units are the face's own, never pixels: a region's displacement is in
 * IODs (the distance between the eye centres) in the face's frame, x along
 * the eye line positive OUTWARD from the midline (one number mirrors itself
 * across the face), y down the face; a brow's rise is in its own
 * brow-to-lid distance, as anatomy measures it. So a tilted photo, a small
 * face and a large one read the same table, and an expression is defined
 * once, never per avatar.
 */
import { LOWER_LIDS, UPPER_LIDS } from "./landmarks";

/** The expressions a page or a text may ask for. */
export const EXPRESSION_NAMES = ["neutral", "happy", "surprised", "concerned", "thinking", "serious"] as const;
export type ExpressionName = (typeof EXPRESSION_NAMES)[number];

/** Shapes only the engine's idle motion uses (expression-mixer.ts). */
export type InternalShape = "browFlash";
/** Every shape the mixer can hold a weight for. */
export type ShapeName = ExpressionName | InternalShape;
export const SHAPE_NAMES: readonly ShapeName[] = [...EXPRESSION_NAMES, "browFlash"];

/** Other words a text or a page may use for an expression. */
export const ALIASES: Readonly<Record<string, ExpressionName>> = {
  rest: "neutral",
  smile: "happy",
  joy: "happy",
  wow: "surprised",
  surprise: "surprised",
  sad: "concerned",
  worried: "concerned",
  hmm: "thinking",
  think: "thinking",
  angry: "serious",
  stern: "serious",
};

/** The name or alias `word` stands for (any case), or null. */
export function expressionNamed(word: string): ExpressionName | null {
  const key = word.trim().toLowerCase();
  if ((EXPRESSION_NAMES as readonly string[]).includes(key)) return key as ExpressionName;
  return ALIASES[key] ?? null;
}

// --- The regions (everything but the brows) ---------------------------------------

export const REGIONS = ["upperLid", "lowerLid", "cheek", "mouthCorner", "lipPress"] as const;
export type Region = (typeof REGIONS)[number];
/** The picture's left or right (the viewer's, not the subject's). */
export type Side = "left" | "right";
/** A region on both sides (mirrored) or on one. */
export type RegionKey = Region | `${Region}.${Side}`;

/** What bounds a region's reach besides its distance (expression-weights.ts). */
export type RegionMask =
  /** Above the eye's corner line only, fading toward the corners. */
  | "aboveCorners"
  /** Below the eye's corner line only, fading toward the corners. */
  | "belowCorners"
  /** Nothing above the lower lid. */
  | "belowLids"
  /** The mouth's own field: nothing at the lips' middle, rising smoothly to
   *  the corner and carrying the cheek beyond it (no anchors). */
  | "mouth"
  /** The red of the lips (no anchors): its outer edge, the upper lip's
   *  weighted down and the lower lip's up (a negative weight), nothing at
   *  the inner lips (speech keeps its opening) or the corners: a "down"
   *  displacement presses the lips thin. */
  | "lips";

export interface RegionSpec {
  /** The anchor landmarks, the picture's left side then its right. */
  readonly anchors: readonly [readonly number[], readonly number[]];
  /** How far a displacement reaches from the nearest anchor, IODs. */
  readonly reach: number;
  readonly mask: RegionMask;
}

export const REGION_SPECS: Readonly<Record<Region, RegionSpec>> = {
  upperLid: { anchors: [UPPER_LIDS[0], UPPER_LIDS[1]], reach: 0.14, mask: "aboveCorners" },
  lowerLid: { anchors: [LOWER_LIDS[0], LOWER_LIDS[1]], reach: 0.14, mask: "belowCorners" },
  cheek: {
    anchors: [
      [50, 101, 118, 117, 205, 36],
      [280, 330, 347, 346, 425, 266],
    ],
    reach: 0.32,
    mask: "belowLids",
  },
  mouthCorner: { anchors: [[61], [291]], reach: 0, mask: "mouth" },
  lipPress: { anchors: [[], []], reach: 0, mask: "lips" },
};

/** The most a region moves, IODs, however many expressions sum in it. */
export const REGION_CAP: Readonly<Record<Region, number>> = {
  upperLid: 0.035,
  lowerLid: 0.03,
  cheek: 0.05,
  mouthCorner: 0.1,
  lipPress: 0.03,
};

// --- The brows -------------------------------------------------------------------

/** A displacement: [outward, down]; IODs for a region, and for a brow
 *  [IODs outward, brow-to-lid distances down]. */
export type Vec = readonly [number, number];

/** A brow's move: its inner end, its middle and its outer end, smoothly
 *  interpolated along it (a whole lift, a slant, an arch, a knit). */
export interface BrowPose {
  readonly inner: Vec;
  readonly mid: Vec;
  readonly outer: Vec;
}

/** A brow pose for both brows (mirrored), or for one, which wins. */
export type BrowPoses = Readonly<Partial<Record<"both" | Side, BrowPose>>>;

/** The most a brow's point moves however many expressions sum: its rise in
 *  brow-to-lid distances, its knit in IODs. A shape may ask for more, up to
 *  the cap over BROW_SATURATES, so that it is already clear at a partial
 *  intensity and reaches the cap before full (concern's inner end: at 0.77). */
export const BROW_CAP = { rise: 0.5, knit: 0.05 } as const;
export const BROW_SATURATES = 0.75;

// --- The skin cues ---------------------------------------------------------------

/** The skin's own signs of an expression, shaded over the photo. */
export const SKIN_CUES = ["foreheadLines", "glabellaLines", "nasolabial", "cheekLift", "crowsFeet"] as const;
export type SkinCue = (typeof SKIN_CUES)[number];

// --- The expressions -------------------------------------------------------------

export interface ExpressionShape {
  /** Each region's displacement at intensity 1, IODs. */
  readonly regions: Readonly<Partial<Record<RegionKey, Vec>>>;
  /** The brows' move at intensity 1. */
  readonly brows?: BrowPoses;
  /** How strongly each skin cue is shaded at intensity 1, 0..1. */
  readonly cues?: Readonly<Partial<Record<SkinCue, number>>>;
  /** A jaw opening (the cue blend's jawOpen), while nothing is said. */
  readonly jaw?: number;
  /** Where the eyes go, eye widths ([x, y], y down). */
  readonly gaze?: Vec;
}

/** A brow pose, at a glance: [inner, mid, outer] rises (brow-to-lid
 *  distances, + down) and knits (IODs, + outward). */
const brow = (rise: [number, number, number], knit: [number, number, number] = [0, 0, 0]): BrowPose => ({
  inner: [knit[0], rise[0]],
  mid: [knit[1], rise[1]],
  outer: [knit[2], rise[2]],
});

/**
 * The amplitudes are anatomy's (docs/emotions.md): a surprise lifts the
 * whole brow about 40% of the brow-to-lid distance, arched; concern lifts
 * the inner third about 30%, the outer end level or a little down; anger
 * lowers the inner end about 22% and knits each inner end 3.5% of the IOD.
 * The eyes' opening changes only where an expression means it to: a smile's
 * cheek pushes the lower lid up, a surprise lifts the upper lid.
 */
export const EXPRESSIONS: Readonly<Record<ShapeName, ExpressionShape>> = {
  neutral: { regions: {} },
  // The corners up and out with the cheek mass, the lower lids pushed up a
  // little, the brows hardly; the fold from the nose deepens.
  happy: {
    regions: { mouthCorner: [0.05, -0.075], cheek: [0.02, -0.045], lowerLid: [0, -0.028] },
    brows: { both: brow([-0.03, -0.05, -0.05]) },
    cues: { nasolabial: 1, cheekLift: 1, crowsFeet: 0.8 },
  },
  // The brows up whole and arched, the upper lids up, the jaw dropped a
  // little when silent; the forehead creases.
  surprised: {
    regions: { upperLid: [0, -0.025] },
    brows: { both: brow([-0.4, -0.46, -0.38], [0, 0, 0.005]) },
    cues: { foreheadLines: 1 },
    jaw: 0.16,
  },
  // The oblique "worried" brow: the inner third up (not together, never
  // down: a knit or a lowered inner end reads as anger), the outer end level
  // or a touch down; the corners down; a few creases in the forehead's
  // middle only (not the furrows between the brows: those are anger's, and
  // read as it). The eyes stay open.
  concerned: {
    regions: { mouthCorner: [0, 0.07] },
    brows: { both: brow([-0.66, -0.2, 0.1], [0.008, 0, 0]) },
    cues: { foreheadLines: 0.5 },
  },
  // One brow (the picture's right) up, arched; the other a little down and
  // in; the eyes up and aside; the mouth drawn to one side, one corner
  // pressed down and the other a touch up.
  thinking: {
    regions: { "mouthCorner.left": [0, 0.035], "mouthCorner.right": [0.01, -0.015] },
    brows: { right: brow([-0.22, -0.42, -0.36]), left: brow([0.12, 0.08, 0.04], [-0.01, 0, 0]) },
    gaze: [0.3, -0.2],
  },
  // The inner ends down and knit, the outer level; the upper lids a little
  // lowered (a hard, level look), the lips pressed thin, the corners
  // hardly down (a downturn is concern's); the vertical lines between the
  // brows.
  serious: {
    regions: { mouthCorner: [-0.008, 0.012], upperLid: [0, 0.01], lipPress: [0, 0.022] },
    brows: { both: brow([0.5, 0.24, 0.04], [-0.04, -0.014, 0]) },
    cues: { glabellaLines: 1 },
  },
  // The idle brow flash: the brows alone.
  browFlash: { regions: {}, brows: { both: brow([-0.25, -0.28, -0.22]) } },
};

// --- The lines of faces ------------------------------------------------------------

/** How much of each part a line of faces takes (KindProfile.expression):
 *  each region, the brows, the skin cues' shading, and how much a brow
 *  may press or stretch the skin round it (`slack`, expression-brow-caps.ts:
 *  a drawn face's flat skin shows a stretch less than a photo's), and how
 *  much of an expression's silent jaw drop (surprise's) it takes. */
export type ExpressionGains = Readonly<Record<Region | "brows" | "cues" | "slack" | "jaw", number>>;

export const HUMAN_GAINS: ExpressionGains = {
  upperLid: 1,
  lowerLid: 1,
  cheek: 1,
  mouthCorner: 1,
  lipPress: 1,
  brows: 1,
  cues: 1,
  slack: 1,
  jaw: 1,
};

/** A drawn or rendered character: its drawn eyes widen more in surprise
 *  and its drawn mouth line needs a little more to read as a smile; its
 *  clean, flat skin takes no shaded folds (a fold on it read as a line
 *  drawn across the forehead) and shows a stretch less than a photo's. */
export const TOON_GAINS: ExpressionGains = {
  upperLid: 1.5,
  lowerLid: 1,
  cheek: 0.8,
  mouthCorner: 1.2,
  lipPress: 1,
  brows: 1,
  cues: 0,
  slack: 2,
  jaw: 1,
};

/** An animal: no lip corners to speak of (a muzzle's are a fit's anchors),
 *  fur over the brows, no skin to crease, and a fitted mesh whose eyes and
 *  lids sit inside large drawn eyes: faint by design, and safe. No skin
 *  cues; no silent jaw drop (on a fitted muzzle it pulled the drawn eyes
 *  apart: a cat's surprise cracked its eye's rim); the brows and lids at a
 *  third (a brow strip over a drawn eye moved the eye's own rim). */
export const ANIMAL_GAINS: ExpressionGains = {
  upperLid: 0.35,
  lowerLid: 0.35,
  cheek: 0.5,
  mouthCorner: 0.5,
  lipPress: 0.5,
  brows: 0.35,
  cues: 0,
  slack: 1,
  jaw: 0,
};

/** The region and the sides a key names. */
export function regionOf(key: RegionKey): { region: Region; sides: readonly Side[] } {
  const [region, side] = key.split(".") as [Region, Side | undefined];
  return { region, sides: side ? [side] : ["left", "right"] };
}

/** The brow pose `poses` gives `side`, if any. */
export function browPoseOf(poses: BrowPoses | undefined, side: Side): BrowPose | undefined {
  return poses?.[side] ?? poses?.both;
}
