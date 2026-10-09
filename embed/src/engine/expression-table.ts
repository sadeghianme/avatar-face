/**
 * The expressions, as data (docs/emotions.md): their names, the regions of
 * the face they move, how far, and how much of it each line of faces takes.
 *
 * A region is a group of the 478 landmarks on each side of the face. A
 * displacement is in IODs (the distance between the eye centres) in the
 * face's own frame: x along the eye line, positive OUTWARD from the face's
 * midline (one number mirrors itself across the face), y down the face. So
 * a tilted photo, a small face and a large one read the same table, and an
 * expression is defined once, never per avatar. expression-rig.ts lays the
 * regions on a face; nothing here knows about one.
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

// --- The regions ---------------------------------------------------------------

export const REGIONS = ["browInner", "browOuter", "upperLid", "lowerLid", "cheek", "mouthCorner"] as const;
export type Region = (typeof REGIONS)[number];
/** The picture's left or right (the viewer's, not the subject's). */
export type Side = "left" | "right";
/** A region on both sides (mirrored) or on one. */
export type RegionKey = Region | `${Region}.${Side}`;

/** What bounds a region's reach besides its distance (expression-rig.ts). */
export type RegionMask =
  /** Nothing at or below the upper lid's top: the forehead follows the
   *  brows, the eye does not. */
  | "aboveLids"
  /** Above the eye's corner line only: the corners stay. */
  | "aboveCorners"
  /** Below the eye's corner line only. */
  | "belowCorners"
  /** Nothing above the lower lid. */
  | "belowLids"
  /** Nothing above the nose's base. */
  | "belowNose";

export interface RegionSpec {
  /** The anchor landmarks, the picture's left side then its right. */
  readonly anchors: readonly [readonly number[], readonly number[]];
  /** How far a displacement reaches from the nearest anchor, IODs. */
  readonly reach: number;
  /** The reach's scale upward and downward (1: round). */
  readonly up: number;
  readonly down: number;
  readonly mask: RegionMask;
}

export const REGION_SPECS: Readonly<Record<Region, RegionSpec>> = {
  // The brows' upper and lower rows, inner and outer halves; the forehead
  // above them follows a long way up, the lid crease below hardly at all.
  browInner: {
    anchors: [
      [107, 66, 55, 65],
      [336, 296, 285, 295],
    ],
    reach: 0.3,
    up: 1.7,
    down: 0.6,
    mask: "aboveLids",
  },
  browOuter: {
    anchors: [
      [70, 63, 46, 53],
      [300, 293, 276, 283],
    ],
    reach: 0.3,
    up: 1.7,
    down: 0.6,
    mask: "aboveLids",
  },
  upperLid: { anchors: [UPPER_LIDS[0], UPPER_LIDS[1]], reach: 0.14, up: 1, down: 1, mask: "aboveCorners" },
  lowerLid: { anchors: [LOWER_LIDS[0], LOWER_LIDS[1]], reach: 0.14, up: 1, down: 1, mask: "belowCorners" },
  cheek: {
    anchors: [
      [50, 101, 118, 117, 205, 36],
      [280, 330, 347, 346, 425, 266],
    ],
    reach: 0.32,
    up: 1,
    down: 1,
    mask: "belowLids",
  },
  mouthCorner: {
    anchors: [
      [61, 78, 76, 62],
      [291, 308, 306, 292],
    ],
    reach: 0.28,
    up: 1,
    down: 1.2,
    mask: "belowNose",
  },
};

/**
 * The most a region moves, IODs, however many expressions sum in it: what a
 * photo takes before it reads as distorted (docs/emotions.md, calibrated on
 * three published people at the dashboard's 960 px).
 */
export const REGION_CAP: Readonly<Record<Region, number>> = {
  browInner: 0.11,
  browOuter: 0.11,
  upperLid: 0.04,
  lowerLid: 0.035,
  cheek: 0.06,
  mouthCorner: 0.11,
};

// --- The expressions -------------------------------------------------------------

/** A displacement, IODs: [outward, down]. */
export type Vec = readonly [number, number];

export interface ExpressionShape {
  /** Each region's displacement at intensity 1. */
  readonly regions: Readonly<Partial<Record<RegionKey, Vec>>>;
  /** A jaw opening (the cue blend's jawOpen), while nothing is said. */
  readonly jaw?: number;
  /** Where the eyes go, eye widths ([x, y], y down). */
  readonly gaze?: Vec;
}

export const EXPRESSIONS: Readonly<Record<ShapeName, ExpressionShape>> = {
  neutral: { regions: {} },
  // The corners up and back, the cheeks lifted, the lower lids up: a smile
  // that reaches the eyes (a mouth-only smile reads as polite).
  happy: {
    regions: { mouthCorner: [0.06, -0.08], cheek: [0.02, -0.035], lowerLid: [0, -0.03], browOuter: [0, -0.012] },
  },
  // Brows up whole, the eyes opened, the jaw dropped a little when silent.
  surprised: {
    regions: { browInner: [0, -0.1], browOuter: [0.006, -0.09], upperLid: [0, -0.035], lowerLid: [0, 0.008] },
    jaw: 0.16,
  },
  // The inner brows up and together (the "grief" brow), the outer ends
  // down, the corners down, the lids a little heavy.
  concerned: {
    regions: {
      browInner: [-0.02, -0.08],
      browOuter: [0, 0.02],
      upperLid: [0, 0.012],
      mouthCorner: [0, 0.06],
    },
  },
  // One brow up, the other a little down, the eyes up and aside, one
  // corner pressed down: asymmetric on purpose.
  thinking: {
    regions: {
      "browOuter.right": [0, -0.09],
      "browInner.right": [0, -0.04],
      "browInner.left": [-0.012, 0.03],
      "mouthCorner.left": [0, 0.025],
      lowerLid: [0, -0.012],
    },
    gaze: [0.22, -0.16],
  },
  // Brows down and together, lids narrowed, the corners pressed down (not
  // in: with a rounded vowel's own narrowing that crushed the corner).
  serious: {
    regions: {
      browInner: [-0.04, 0.06],
      browOuter: [0, 0.025],
      upperLid: [0, 0.015],
      lowerLid: [0, -0.025],
      mouthCorner: [0, 0.025],
    },
  },
  // The idle brow flash: the brows alone.
  browFlash: { regions: { browInner: [0, -0.06], browOuter: [0, -0.045] } },
};

// --- The lines of faces ------------------------------------------------------------

/** How much of each region a line of faces takes (KindProfile.expression). */
export type ExpressionGains = Readonly<Record<Region, number>>;

export const HUMAN_GAINS: ExpressionGains = {
  browInner: 1,
  browOuter: 1,
  upperLid: 1,
  lowerLid: 1,
  cheek: 1,
  mouthCorner: 1,
};

/** A drawn or rendered character: its drawn mouth line needs a little more
 *  to read as a smile; flat cheeks have little to show. */
export const TOON_GAINS: ExpressionGains = {
  browInner: 1.1,
  browOuter: 1.1,
  upperLid: 1,
  lowerLid: 1,
  cheek: 0.8,
  mouthCorner: 1.2,
};

/** An animal: no lip corners to speak of (a muzzle's are a fit's anchors),
 *  fur over the brows. Faint by design. */
export const ANIMAL_GAINS: ExpressionGains = {
  browInner: 0.6,
  browOuter: 0.6,
  upperLid: 0.7,
  lowerLid: 0.7,
  cheek: 0.5,
  mouthCorner: 0.5,
};

/** The region and the sides a key names. */
export function regionOf(key: RegionKey): { region: Region; sides: readonly Side[] } {
  const [region, side] = key.split(".") as [Region, Side | undefined];
  return { region, sides: side ? [side] : ["left", "right"] };
}
