/**
 * Liveface canvas engine: textured triangle-mesh warp + cue-driven lip-sync.
 *
 * Hard-won implementation notes (do not "simplify" these away):
 * - Triangle warps solve the source->dest affine with CRAMER'S RULE; the
 *   naive derivation is degenerate and draws nothing. |det| < 1e-6 is skipped.
 * - Texture coords map to the TEXTURE's own naturalWidth/naturalHeight (the
 *   thumbnail may be scaled down), never to rig.image_size.
 * - The inner-lip ring is ANGLE-SORTED around its centroid before building
 *   the mouth-cavity clip; raw index order self-intersects and the clip
 *   leaks across the face.
 * - Teeth are anatomically fixed-size and hang from the lips; jawOpen grows
 *   the dark gap, NOT the teeth.
 * - A `destroyed` flag makes mount -> unmount -> mount safe under React
 *   StrictMode.
 */
import { BlinkScheduler, blinkEase } from "./blink";
import { eyeExtent, lidAmount, lidSamplePoints, medianColour, paintLid, type Blit, type LidTone } from "./blink-lid";
import { BodyMotion, BREATH_RISE, SWAY_TRAVEL } from "./bodymotion";
import { FACE_OVAL, faceHighlight } from "./face-light";
import { faceSharpness, lumaField, sharpnessBoxes } from "./face-sharpness";
import {
  CharacterField,
  DEFAULT_LOOK,
  INNER_UPPER,
  characterOpening,
  mergeTraits,
  openingPath,
  sampleLook,
  type CharacterLook,
  type CharacterTraits,
  type Rgb,
} from "./character-mouth";
import { TONGUE_RAISE, paintCharacter } from "./character-paint";
import { HeadMotion } from "./headmotion";
import { applyLowerFace, buildLowerFaceRig, buildNeckBand, UPPER_FACE, type LowerFaceRig } from "./jaw-rig";
import { kindProfile, type KindProfile } from "./kind-profile";
import { padTriangle } from "./seam-pad";
import { eyeLine, viewportFor } from "./viewport";
import { MediaClock } from "./media-clock";
import type { MouthExtension, MouthPose } from "./mouth-extension";
import { centralMouthAnchors } from "./mouth-extension";
import { BlendWeights, Cue, DEFAULT_TUNING, EngineTuning, Rig, ZERO_WEIGHTS } from "./types";

// Canonical MediaPipe brow rows, inner -> outer.
const LEFT_BROW = [55, 65, 52, 53, 46];
const RIGHT_BROW = [285, 295, 282, 283, 276];
// Eyes split into lids: a blink is the UPPER lid sweeping down over the
// eyeball (skin from above stretches down to cover it) — NOT the whole ring
// squashing, which compresses the eyeball texture and looks alien.
const UPPER_LIDS = [
  [246, 161, 160, 159, 158, 157, 173],
  [466, 388, 387, 386, 385, 384, 398],
];
const LOWER_LIDS = [
  [7, 163, 144, 145, 153, 154, 155],
  [249, 390, 373, 374, 380, 381, 382],
];
const EYE_CORNERS: [number, number][] = [
  [33, 133],
  [263, 362],
];
// The second eye detector: MediaPipe's iris ring — a center plus four rim
// points per eye. Gives the pupil's position and radius directly, so the
// gaze shift can be confined to a circle around the iris instead of the
// whole eye opening.
// Mid-cheek, both sides: clear of beard, brow shadow, nose highlight.
const CHEEK_LANDMARKS = [50, 280, 205, 425, 101, 330];
const IRISES: [number, number[]][] = [
  [468, [469, 470, 471, 472]],
  [473, [474, 475, 476, 477]],
];

export interface Sample {
  lum: number;
  rgb: [number, number, number];
}

export function luma(rgb: [number, number, number]): number {
  return 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
}

function chroma(rgb: [number, number, number]): number {
  return Math.max(...rgb) - Math.min(...rgb);
}

/**
 * Pick the sclera colour out of samples taken beside the iris, or null if none
 * of them is plausibly an eye white.
 *
 * Getting this wrong is what made the eyes change when the avatar looked
 * around: the old version took the 85th brightness percentile of everything
 * inside the eye-opening polygon, which on a real avatar returned
 * rgb(174,156,142) — beige skin — and then painted it inside the eye.
 *
 * A sclera is the brightest NEUTRAL thing in an eye. Both halves matter and
 * neither works alone: skin is bright but strongly chromatic, while lash,
 * liner and pupil are neutral but dark. So the test is relative to the skin
 * just below the eye, which also handles exposure and skin tone — on a dark
 * face the sclera is far brighter than the cheek, on a pale one it is about
 * equal, but in both the sclera is markedly less chromatic.
 *
 * The thresholds are deliberately biased toward rejection. A false negative
 * costs gaze on one eye, which nobody notices. A false positive paints skin
 * colour inside an eyeball, which is the bug this replaces.
 */
export function pickScleraColour(candidates: Sample[], skin: Sample | null): string | null {
  if (!candidates.length) return null;
  const brightestFirst = [...candidates].sort((a, b) => b.lum - a.lum);
  const skinChroma = skin ? chroma(skin.rgb) : 40;
  const maxChroma = Math.max(6, skinChroma * MAX_SCLERA_CHROMA_VS_SKIN);
  const minLum = skin ? skin.lum * MIN_SCLERA_LUMA_VS_SKIN : 120;
  const found = brightestFirst.find(
    (s) => chroma(s.rgb) <= maxChroma && s.lum >= minLum
  );
  return found ? `rgb(${found.rgb.join(", ")})` : null;
}

// Durations for the involuntary motions, in real milliseconds. These used to
// be per-frame increments, which made every one of them run at a speed that
// depended on the frame rate — a blink took 440ms on a 30fps device.
// The blink's own timing lives in blink.ts.

/**
 * How far the upper lids lower when the gaze goes down, as a fraction of
 * the blink sweep. Eyes that look down with the lids fixed open show more
 * white above the iris, which is the startled look; real lids follow the
 * eye. Small: a glance down is a narrowing, not a half-blink.
 */
const LID_FOLLOW = 0.35;

/**
 * Per-shape inertia, as a multiple of the shared time constant.
 *
 * The jaw and the lips are not the same instrument. The jaw is a bone hung
 * on heavy muscle and it arrives at a vowel; the lips and their ring muscle
 * are light and they snap — which is exactly why /p/ /b/ /m/ read as
 * closures rather than as pauses. Driving both at one rate forced a choice
 * between a jaw that jitters through every consonant and lips too sluggish
 * to shut between two vowels.
 *
 * Kept close to 1 on purpose. The smoothing sits on top of a blend that
 * already reaches each shape in the middle of its own span, so slowing the
 * jaw much further costs peak opening on fast speech, which is a worse
 * fault than the one being fixed.
 */
const INERTIA: Record<keyof BlendWeights, number> = {
  jawOpen: 1.3,
  mouthClose: 0.7,
  mouthPucker: 0.85,
  mouthFunnel: 0.85,
  mouthStretch: 0.8,
  mouthSmile: 0.9,
};

/**
 * Jaw drop at full jawOpen, as a fraction of resting mouth height, for
 * every point below the seam. 0.74 is what the old gradient delivered at
 * the lip's bottom edge, so the chin travels the same distance as before;
 * what changes is that the whole lower lip now travels with it.
 */
const JAW_DROP = 0.74;
/**
 * How much of the jaw drop a vertex takes, 0..1.
 *
 * One lateral taper shared by lip and skin alike: the mouth corners are
 * anchored to the cheeks, so the drop fades from full at the centre to
 * nothing just past the corners, and every vertex at the same x agrees —
 * the first version tapered the lip by x but ramped the skin by y, so a
 * lip vertex and the skin vertex beside it disagreed by 30px across one
 * triangle, which rendered as a row of spikes along each side of the lip.
 *
 * - Lower lip: the taper, fully.
 * - Corners: half. A commissure descends about half the jaw drop when the
 *   mouth opens wide; anchoring it completely made the lip come to a
 *   torn point.
 * - Upper lip: still, except a small droop toward the corners, where it
 *   is pulled by the descending commissure.
 * - Skin: nothing above the seam; below it, the taper, once a short ramp
 *   past the lip line has ruled out the mid-lip region.
 */
export function hingeShare(index: number, nx: number, ny: number, lensWidth: number): number {
  // A LENS, not a plateau: an open mouth's lower edge is deepest at the
  // centre and curves up to meet the corners. A flat-topped taper left the
  // lip beside each corner dropping three quarters of the way while the
  // corner itself stayed, and that step is what rendered as spikes.
  // `lensWidth` narrows the lens for rounded shapes: an "oh" opens the
  // middle of the mouth, not the corners.
  const lateral = Math.max(0, 1 - Math.pow(Math.abs(nx) / lensWidth, 2.2));
  if (LOWER_LIP.has(index)) return lateral;
  if (MOUTH_CORNERS.has(index)) return 0.5 * lateral;
  if (UPPER_LIP.has(index)) {
    return 0.3 * Math.max(0, Math.min(1, (Math.abs(nx) - 0.4) / 0.6)) * lateral;
  }
  if (ny <= 0) return 0;
  const t = Math.min(1, ny / 0.35);
  return t * t * (3 - 2 * t) * lateral;
}

const MOUTH_CORNERS = new Set([61, 291, 78, 308, 76, 306, 62, 292]);

// MediaPipe lip landmarks, outer and inner rows. Membership decides which
// side of the hinge a vertex is on.
const LOWER_LIP = new Set([
  146, 91, 181, 84, 17, 314, 405, 321, 375, // outer
  95, 88, 178, 87, 14, 317, 402, 318, 324, // inner
]);
const UPPER_LIP = new Set([
  185, 40, 39, 37, 0, 267, 269, 270, 409, // outer
  191, 80, 81, 82, 13, 312, 311, 310, 415, // inner
]);

/**
 * How far the upper lid travels, as a fraction of the way to the lower lid.
 *
 * There is no drawn lid any more. Every attempt to synthesise one from a
 * single photo added an artifact: sliding a band of skin down duplicates
 * whatever is above the eye (on a face with drawn eyeliner, that is a second
 * eyelash), and painting a filled shape reads as a sticker. Both put an extra
 * layer over a face that never had one.
 *
 * So the blink is the mesh alone, and the only thing that makes that work is
 * NOT closing all the way. A full sweep crushes the eyeball texture into a
 * band and smears it. A short one reads as the quick narrowing a blink
 * actually is at this size, moves the real lashes (they are part of the lid
 * texture, so they travel with it), and never reaches the range where the
 * squash becomes visible.
 */
const LID_VERTEX_SWEEP = 1.0;


/** Pivot depth for body sway, as a multiple of canvas height. Below the
 *  frame: a standing body turns about its feet, not its middle. */
const BODY_PIVOT_DEPTH = 1.75;

/** A head is wider than the face landmarks that sit inside it. Used only to
 *  express the sway target in the same units it was measured in. */
const FACE_TO_HEAD_WIDTH = 1.4;

/** Silence inside speech longer than this is a pause, and a pause gets a
 *  catch-breath. Shorter gaps are the space between words. */
const PAUSE_BREATH_MS = 260;

/** How long a cue track runs, for pacing the speech exhale. The last cue is
 *  normally the closing silence, so its time is the utterance length. */
function utteranceMs(cues: Cue[]): number {
  let last = 0;
  for (const cue of cues) if (cue.t > last) last = cue.t;
  return last;
}

/** Sway is scaled down when the photo still has its background: moving the
 *  whole picture then reads as a wobbling camera rather than a moving person,
 *  and it drags the photo's own edge into frame. */
const OPAQUE_BACKGROUND_SCALE = 0.3;
const SACCADE_MS = 35;

// A sclera's colour cast is a fraction of the surrounding skin's, and it is
// never much darker than that skin. Tuned so a cartoon eye with no white at
// all is rejected while real sclera under warm light still passes.
const MAX_SCLERA_CHROMA_VS_SKIN = 0.45;
const MIN_SCLERA_LUMA_VS_SKIN = 0.75;

const VOWEL_VISEMES = new Set(["aa", "E", "ih", "oh", "ou"]);

/** A beat gesture is quick — a dip and back, not a slow ambient nod. */
const BEAT_NOD_MS = 420;
/** Ambient nods, when a cue track carries no usable emphasis. */
const AMBIENT_NOD_MS = 1050;
/**
 * The head's downward motion starts a little before the syllable is heard:
 * the gesture accompanies the accent rather than reacting to it.
 */
const BEAT_LEAD_MS = 80;
/** No two beats closer than this. People accent phrases, not syllables; a
 *  nod per stressed vowel is a bobblehead. */
const BEAT_MIN_GAP_MS = 900;
/** How prominent a vowel must be, relative to the track's own loudest, to
 *  earn a beat. Relative because a quiet sentence still has accents. */
const BEAT_THRESHOLD = 0.72;

export interface Beat {
  t: number;
  strength: number;
}

/**
 * Where in an utterance the head should mark the beat.
 *
 * Speakers move their heads down on accented syllables — it is one of the
 * most reliable pairings in conversation, and its absence is part of why a
 * talking head reads as a puppet with a moving mouth. The information is
 * already in the cue track: after the server measures the rendered audio,
 * a vowel's amplitude is how loud that syllable actually was, so the
 * accents are the prominent vowels.
 *
 * A beat needs to be a LOCAL peak, not merely loud — in a uniformly
 * emphatic sentence every vowel clears an absolute threshold and the head
 * nods continuously. Comparing each vowel to its neighbours finds the
 * syllable the speaker leaned on.
 */
export function emphasisBeats(cues: Cue[]): Beat[] {
  const vowels: { t: number; a: number }[] = [];
  for (const cue of cues) {
    if (VOWEL_VISEMES.has(cue.viseme)) vowels.push({ t: cue.t, a: cue.a ?? 1 });
  }
  if (vowels.length < 2) return [];
  const loudest = Math.max(...vowels.map((v) => v.a));
  if (loudest <= 0) return [];

  const beats: Beat[] = [];
  for (let i = 0; i < vowels.length; i++) {
    const here = vowels[i];
    if (here.a < loudest * BEAT_THRESHOLD) continue;
    const before = vowels[i - 1]?.a ?? 0;
    const after = vowels[i + 1]?.a ?? 0;
    // A peak, or level with a neighbour at the top of the track (a long
    // accented vowel can span two cues at the same amplitude).
    if (here.a < before || here.a < after) continue;
    const at = Math.max(0, here.t - BEAT_LEAD_MS);
    if (beats.length && at - beats[beats.length - 1].t < BEAT_MIN_GAP_MS) continue;
    beats.push({ t: at, strength: Math.min(1.3, 0.7 + (here.a / loudest) * 0.6) });
  }
  return beats;
}

export interface Point {
  x: number;
  y: number;
}

/**
 * Downsample a cue track to articulation rate. Per-character tracks (one
 * cue every ~75ms) make the mouth wobble through noise; real speech reads
 * as ~4-6 mouth keyframes per second, dominated by vowels (jaw) with
 * consonants as brief shaping. Cues closer than MIN_CUE_MS are folded into
 * their predecessor, preferring vowels when they collide.
 */
/** Span assumed for the final cue, which has no successor to measure against. */
const DEFAULT_CUE_SPAN_MS = 90;

/**
 * Shape of each cue's dominance bell: exp(-0.5 * |z|^BELL_EXPONENT).
 *
 * A plain Gaussian (exponent 2) is pointy, so neighbouring cues are still
 * contributing at the moment a segment should be at its own target — measured,
 * that clipped peak jaw opening from 0.70 to 0.59, visibly flattening wide
 * vowels. Exponent 4 gives a FLAT TOP with steep shoulders: a segment reaches
 * its full shape in the middle of its own span, then hands over smoothly.
 * Measured against the previous linear blend on a news sentence, this is
 * better on every axis at once — peak 0.702 -> 0.716, lip closure 0.69 ->
 * 0.84, mean |jaw acceleration| 0.0131 -> 0.0089.
 */
const BELL_EXPONENT = 4;
/** Floor on dominance width: below this the bells stop overlapping and the
 * blend degenerates back into snapping from viseme to viseme. */
const MIN_DOMINANCE_MS = 42;

/**
 * Visemes whose shape is an articulatory CONSTRAINT, not a suggestion.
 *
 * A blend is an average, so it can never reach any single viseme's peak —
 * measured, plain coarticulation let /p/ closure fall to 0.37 of its target,
 * i.e. the mouth simply never shut on "m", "p" or "b". No amount of extra
 * weight fixes that; the shapes have to be re-asserted after blending. The
 * value is how fully the constraint is enforced at its own instant.
 */
const IMPERATIVE: Record<string, number> = {
  PP: 1.0,  // p, b, m — full lip closure; the most legible shape there is
  FF: 0.85, // f, v — lower lip tucked to the upper teeth
  // The tongue consonants, now that they survive to be drawn at all. Same
  // argument, weaker claim: a 45-60ms segment cannot reach its own shape
  // through an average dominated by the neighbouring vowel's much wider
  // bell. Held well below PP/FF because a /d/ is a smaller, less legible
  // gesture than a lip closure and should not fight the vowel for the jaw.
  nn: 0.35, // n, l, ng
  DD: 0.3,  // t, d
};

/** Constraint bells are narrower than the blend's own (which uses 0.62× span
 * with a 42ms floor). Measured on a news-reading sentence, 0.7× here is the
 * knee: closure comes back to 0.885 of target while mean |acceleration| stays
 * at half the old linear blend's. Narrower restores the last 1.5% of closure
 * but starts pushing the jerk back up. */
const IMPERATIVE_WIDTH = 0.7;
const MIN_IMPERATIVE_MS = 30;

const MIN_CUE_MS = 85;

/**
 * Shapes that are transients, not dwells — a closure or a tongue contact that
 * happens and is gone. Folding them at the dwell rate deleted them: measured
 * over a /l/-heavy paragraph, of 37 tongue consonants only 2 survived to be
 * drawn, so "the little girl said" was mimed as one unbroken vowel smear.
 * The planner already exempts these from its own dwell floor for the same
 * reason; this is the client half of the same argument.
 */
const TRANSIENT_VISEMES = new Set(["PP", "FF", "TH", "DD", "nn"]);
const MIN_TRANSIENT_CUE_MS = 40;

export function prepareCues(cues: Cue[]): Cue[] {
  if (cues.length <= 2) return cues;
  const out: Cue[] = [];
  for (const cue of cues) {
    const last = out[out.length - 1];
    // A transient on EITHER side relaxes the floor: a /d/ followed 50ms later
    // by its vowel has to keep both, or the consonant is swallowed by the
    // vowel that follows it exactly as often as by the one before.
    const floorMs =
      TRANSIENT_VISEMES.has(cue.viseme) || (last && TRANSIENT_VISEMES.has(last.viseme))
        ? MIN_TRANSIENT_CUE_MS
        : MIN_CUE_MS;
    if (last && cue.t - last.t < floorMs) {
      // Collides with the previous keyframe: vowels win (they carry the
      // jaw motion); otherwise keep the existing one. Replace the WHOLE cue
      // rather than just its viseme — the old in-place `last.viseme = ...`
      // left the deleted cue's other fields behind, so a vowel could inherit
      // a consonant's stress amplitude.
      if (VOWEL_VISEMES.has(cue.viseme) && !VOWEL_VISEMES.has(last.viseme)) {
        out[out.length - 1] = { ...cue, t: last.t };
      }
      continue;
    }
    if (last && last.viseme === cue.viseme) continue;
    out.push({ ...cue });
  }
  // Always end closed, at the track's true end time.
  const end = cues[cues.length - 1];
  const lastOut = out[out.length - 1];
  if (!lastOut || lastOut.viseme !== "sil" || lastOut.t < end.t) {
    out.push({ t: Math.max(end.t, (lastOut?.t ?? 0) + 1), viseme: "sil", a: 1 });
  }
  return out;
}

/**
 * Smooth closed curve through an ordered loop of points (Catmull-Rom
 * converted to cubic beziers). Straight segments between landmarks make a
 * mouth outline look faceted; this keeps it continuous.
 */
function smoothClosedPath(points: { x: number; y: number }[]): Path2D {
  const path = new Path2D();
  const n = points.length;
  if (n < 3) return path;
  path.moveTo(points[0].x, points[0].y);
  for (let i = 0; i < n; i++) {
    const p0 = points[(i - 1 + n) % n];
    const p1 = points[i];
    const p2 = points[(i + 1) % n];
    const p3 = points[(i + 2) % n];
    path.bezierCurveTo(
      p1.x + (p2.x - p0.x) / 6,
      p1.y + (p2.y - p0.y) / 6,
      p2.x - (p3.x - p1.x) / 6,
      p2.y - (p3.y - p1.y) / 6,
      p2.x,
      p2.y
    );
  }
  path.closePath();
  return path;
}

export interface EngineOptions {
  debugMesh?: boolean;
  /** Optional mouth renderer (see mouth/). Omitted means the classic mouth. */
  mouthExtension?: MouthExtension;
  pose?: () => MouthPose | null;
  /** Opt-in lab clock, in audio milliseconds. Omitted by all existing pages. */
  cueClock?: () => number;
  /**
   * The "full" framing: the whole picture, contained and centred. Without
   * it (or with `zoom` 1) the "face" framing: the picture composed as a
   * portrait that fills the canvas. Either way the whole picture is drawn;
   * the two are zoom levels of one viewport (viewport.ts).
   */
  fullPhoto?: boolean;
  /** The zoom directly: 1 the face, 0 the whole picture, between in
   *  proportion, up to 1.3 closer in. Wins over `scene.zoom` and `fullPhoto`. */
  zoom?: number;
  /** The scene the avatar is shown in (zoom, pan, background): what the
   *  owner set and published. `setScene` changes it live. */
  scene?: Scene | null;
}

/** What is behind a cut-out: nothing, a colour, or a picture (cover-fitted
 *  to the canvas). An opaque picture covers it, so it is not drawn then. */
export interface SceneBackground {
  kind: "transparent" | "color" | "image";
  color?: string;
  image_url?: string;
}

/** The scene (the owner's framing editor): zoom 1 is the face view, 0 the
 *  whole picture, up to 1.3 closer in; pan moves the view as fractions of
 *  the canvas; the background sits behind a cut-out. */
export interface Scene {
  zoom?: number;
  pan?: { x: number; y: number };
  background?: SceneBackground | null;
}

export class AvatarEngine {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private rig: Rig;
  /** What the rig's line changes in the mouth; today's human renderer
   *  unless the rig names a profile. */
  private readonly profile: KindProfile;
  /** The character mouth (character-mouth.ts), only for a profile that asks
   *  for it: the jaw field, what the picture looks like, the owner's traits
   *  and how high the tongue is now. Null for every classic rig. */
  private field: CharacterField | null = null;
  /** The jaw, chin and cheeks for every mouth driver (jaw-rig.ts), built
   *  from the rest mesh with the framing. */
  private lowerFace: LowerFaceRig | null = null;
  private look: CharacterLook = DEFAULT_LOOK;
  private traits: CharacterTraits;
  private tongue = 0;
  private texture: HTMLImageElement;
  /** StrictMode guard: render loop and async callbacks bail once destroyed. */
  private destroyed = false;

  // Framing: rig image coords -> canvas coords.
  private scale = 1;
  private offsetX = 0;
  private offsetY = 0;

  private basePoints: Point[] = []; // canvas space, neutral pose
  private texPoints: Point[] = []; // texture space (naturalWidth/Height)
  // Mouth-region subdivision: extra midpoint vertices (index >= 478) that
  // follow their two parents, and the refined triangle list using them.
  private derivedParents: [number, number][] = [];
  // The neck band (jaw-rig.ts): derived vertices below the jaw line, after
  // the midpoints, each hanging from a jaw-line vertex by a share of its
  // motion, so the chin drops over stretching neck skin, not a still one.
  private neckBand: { base: Point; parent: number; share: number }[] = [];
  private triangles: [number, number, number][] = [];
  private innerRing: number[] = [];

  // Animation state
  private cues: Cue[] = [];
  private cueStart = 0;
  private readonly cueClock?: () => number;
  private mouthExtension?: MouthExtension;
  private readonly pose?: () => MouthPose | null;
  private speaking = false;
  /** When the current run of silence inside speech began, for catch-breaths;
   *  null while a viseme is active. */
  private silenceSince: number | null = null;
  private weights: BlendWeights = { ...ZERO_WEIGHTS };
  private targetWeights: BlendWeights = { ...ZERO_WEIGHTS };
  private energy = 0; // smoothed speech energy, drives head motion
  private blink = 0;
  private readonly blinks = new BlinkScheduler();
  private nextNodAt = 0;
  private nodPhase = 1; // 1 = finished
  private nodMs = AMBIENT_NOD_MS;
  private nodStrength = 1;
  /** Emphasis beats for the utterance in flight, and how far through them
   *  the cue clock has walked. */
  private beats: Beat[] = [];
  private nextBeat = 0;
  private body = new BodyMotion();
  // The head as a movable unit. The layer is the head REGION of the photo —
  // hair, ears, skull — cut out once with feathered edges; the geometry is
  // where it sits and how far it may travel. The first attempt moved face
  // vertices instead, and the face slid around inside a stationary head.
  private headDrive = new HeadMotion();
  private headLayer: HTMLCanvasElement | null = null;
  private headGeom: {
    x: number; y: number; w: number; h: number;
    pivotX: number; pivotY: number;
    yawPx: number; pitchPx: number; faceH: number;
  } | null = null;
  private bodyPivot = { x: 0, y: 0 };
  private swayAngle = 0;   // radians at full deflection
  private breathRise = 0;  // pixels at the top of an inhale
  /** Whether the photo is a cut-out. Decides how far the body may move. */
  private cutOut = false;
  // Gaze: current and target offsets in eye-widths, plus saccade timing.
  private gaze = { x: 0, y: 0 };
  private gazeTarget = { x: 0, y: 0 };
  private nextSaccadeAt = 0;
  // Separate iris layer: sclera colour sampled per eye, iris radius in
  // texture pixels, and the texture->canvas scale factor.
  /** Mid-cheek skin, sampled with the lips: the scene's exposure and colour
   *  cast, which a mouth renderer needs to light anything it draws. */
  private skinColour: [number, number, number] | null = null;
  /** Luma of the picture's brightest skin or sclera (face-light.ts): the
   *  ceiling for the teeth a mouth renderer draws into it. */
  private faceHighlight: number | null = null;
  /** The width of the picture's crispest edges, texture px (face-sharpness.ts);
   *  null on a flat or tainted picture. */
  private faceSharpness: number | null = null;
  /** The face's own lip colour, sampled at load. The mouth interior is
   * derived from it rather than hardcoded. */
  private lipColour: [number, number, number] = [150, 90, 84];
  /** Each eye's own lash colour. Not every face has black lashes — a fair or
   * stylized one can have brown, auburn or near-white, and drawing black on
   * those puts a stranger's eyelash on the face. */
  private lashColour: string[] = ["rgba(60, 42, 38, 0.75)", "rgba(60, 42, 38, 0.75)"];
  /** The same, as numbers, and each eye's lid colour: for the painted lid
   *  of a profile that blinks that way (blink-lid.ts). */
  private lashRgb: Rgb[] = [[60, 42, 38], [60, 42, 38]];
  /** Each eye's real reach in texture pixels (blink-lid.ts eyeExtent), and
   *  whether the skin below it is plain enough to copy for a lid. */
  private lidExtent: (Point[] | null)[] = [null, null];
  private lidCloneOk: boolean[] = [false, false];
  private lidTone: LidTone[] = [
    { above: [200, 150, 130], below: [200, 150, 130] },
    { above: [200, 150, 130], below: [200, 150, 130] },
  ];
  private raf = 0;
  private startTime = 0;
  private lastTickAt = 0;

  // Audio
  private audioCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private analyserData: Uint8Array | null = null;
  private currentAudio: HTMLAudioElement | null = null;
  /** Cue time of the audio playing now, when no external cueClock is given. */
  private audioClock: MediaClock | null = null;
  private onAudioEnd: (() => void) | null = null;

  debugMesh: boolean;
  /** Live animation parameters — mutate freely, applied next frame. */
  tuning: EngineTuning = { ...DEFAULT_TUNING };
  /** The scene: the zoom the viewport is at (1 the face, 0 the whole
   *  picture), the pan, and what is behind a cut-out. */
  private scene: Scene;
  /** The scene's background picture once it has loaded; null until then,
   *  and null for good when it fails (the avatar never waits for it). */
  private backgroundImage: HTMLImageElement | null = null;
  private backgroundUrl: string | null = null;
  /** Where the whole picture lies on the canvas, canvas px (viewport.ts);
   *  parts of it may be outside the canvas. */
  private picture = { x: 0, y: 0, w: 0, h: 0 };

  // Layered render path (see setLayers). Null means single-photo.
  private layers: {
    background?: HTMLImageElement;
    body: HTMLImageElement;
    head: HTMLImageElement;
  } | null = null;


  constructor(canvas: HTMLCanvasElement, rig: Rig, texture: HTMLImageElement, opts: EngineOptions = {}) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2d canvas context unavailable");
    this.ctx = ctx;
    this.rig = rig;
    this.profile = kindProfile(rig);
    this.traits = this.profile.traits;
    this.texture = texture;
    this.cueClock = opts.cueClock;
    this.mouthExtension = opts.mouthExtension;
    this.pose = opts.pose;
    this.debugMesh = opts.debugMesh ?? false;
    // The zoom: the option, else the scene's, else the framing.
    this.scene = {
      ...(opts.scene ?? {}),
      zoom: opts.zoom ?? opts.scene?.zoom ?? (opts.fullPhoto ? 0 : 1),
    };
    this.loadBackground();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    this.innerRing = this.validInnerRing();
    this.computeFraming();
    this.sampleLipColour();
    this.sampleLashColour();
    this.sampleCharacterLook();
    this.sampleLidColours();
    this.subdivideMouthRegion();
    this.buildNeckBand();
    this.startTime = performance.now();
    this.blinks.reset(this.startTime);
    this.nextNodAt = this.startTime + 2500;
    this.nextSaccadeAt = this.startTime + 600 + Math.random() * 1200;
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
    // Debug handle (last engine wins): lets a console force blinks/visemes.
    (globalThis as { __liveface?: AvatarEngine }).__liveface = this;
  }

  /**
   * Switch to the layered render path: real content behind the head.
   *
   * The layers are full-frame images aligned to the original photo's pixels
   * (background may be absent — a cut-out has nothing behind it). With them,
   * the head moves over the body's own pixels and the body sways over a
   * still background, so nothing is ever revealed that does not exist —
   * the punch-out and feathered-cutout machinery of the single-photo path
   * becomes unnecessary and is simply not used.
   */
  setLayers(layers: {
    background?: HTMLImageElement;
    body: HTMLImageElement;
    head: HTMLImageElement;
  }): void {
    if (this.destroyed) return;
    this.layers = layers;
  }


  /**
   * Swap in a sharper copy of the same photo, mid-flight.
   *
   * The widget boots on the 256px thumbnail so a face appears immediately,
   * then upgrades to the full-resolution image when it lands. Everything
   * sampled or derived from the texture is redone: texPoints and the mouth
   * subdivision (derivedParents cleared first — the subdivision APPENDS
   * derived points, so re-running it without the reset doubles them), the
   * lip/lash colours, the cut-out probe and the head layer.
   */
  setTexture(texture: HTMLImageElement): void {
    if (this.destroyed) return;
    this.texture = texture;
    this.sampleLipColour();
    this.sampleLashColour();
    this.sampleCharacterLook();
    this.sampleLidColours();
    this.rebuildGeometry();
  }

  /**
   * Lay the picture on the canvas again (the viewport changed): the base
   * points, the mouth subdivision and the neck band are derived from it,
   * and the subdivision APPENDS vertices, so it starts from a clean list.
   */
  private rebuildGeometry(): void {
    this.derivedParents = [];
    this.computeFraming();
    this.subdivideMouthRegion();
    this.buildNeckBand();
  }

  /**
   * Change the scene live: the zoom and the pan move the viewport (the
   * owner dragging the preview, a slider), the background swaps what is
   * behind a cut-out. A background picture loads in the background and is
   * drawn once it has; one that fails to load leaves the scene transparent
   * and never holds the avatar up.
   */
  setScene(scene: Scene | null | undefined): void {
    if (this.destroyed) return;
    const next: Scene = { ...(scene ?? {}), zoom: scene?.zoom ?? this.scene.zoom ?? 1 };
    const moved =
      next.zoom !== this.scene.zoom ||
      (next.pan?.x ?? 0) !== (this.scene.pan?.x ?? 0) ||
      (next.pan?.y ?? 0) !== (this.scene.pan?.y ?? 0);
    this.scene = next;
    if (moved) this.rebuildGeometry();
    this.loadBackground();
  }

  /** Start loading the scene's background picture, if it changed. */
  private loadBackground(): void {
    const background = this.scene.background;
    const url = background?.kind === "image" && background.image_url ? background.image_url : null;
    if (url === this.backgroundUrl) return;
    this.backgroundUrl = url;
    this.backgroundImage = null;
    if (!url) return;
    try {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        if (!this.destroyed && this.backgroundUrl === url) this.backgroundImage = img;
      };
      img.onerror = () => undefined; // transparent it stays
      img.src = url;
    } catch {
      // No Image in this environment (tests): transparent.
    }
  }

  /**
   * What is behind a cut-out, drawn first and still: a colour, or a
   * picture cover-fitted to the canvas. An opaque picture covers the whole
   * canvas wherever it reaches, so nothing is drawn for it.
   */
  private drawSceneBackground(): void {
    const background = this.scene.background;
    if (!background || background.kind === "transparent" || !this.cutOut) return;
    const ctx = this.ctx;
    const cw = this.canvas.width, ch = this.canvas.height;
    if (background.kind === "color" && background.color) {
      ctx.save();
      ctx.fillStyle = background.color;
      ctx.fillRect(0, 0, cw, ch);
      ctx.restore();
      return;
    }
    const img = this.backgroundImage;
    if (background.kind !== "image" || !img) return;
    const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
    if (!iw || !ih) return;
    const scale = Math.max(cw / iw, ch / ih);
    const w = iw * scale, h = ih * scale;
    ctx.drawImage(img, 0, 0, iw, ih, (cw - w) / 2, (ch - h) / 2, w, h);
  }

  /**
   * The owner's mouth settings for a character mouth (jaw, teeth, tongue),
   * over the profile's own. Ignored by a classic mouth.
   */
  setCharacterTraits(own: Partial<CharacterTraits> | null | undefined): void {
    this.traits = mergeTraits(this.profile.traits, own);
  }

  /**
   * Stop or restart drawing, e.g. when the avatar scrolls out of view.
   *
   * Browsers already stop animation frames in hidden tabs; this covers a
   * visible tab where the canvas is simply off-screen, which otherwise costs
   * a full render every frame for nothing. Time does not jump on resume: the
   * tick clamps its step, so the motion carries on rather than lurching.
   */
  setActive(active: boolean): void {
    if (this.destroyed) return;
    if (!active) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    } else if (!this.raf) {
      this.raf = requestAnimationFrame(this.loop);
    }
  }

  /**
   * The 478 face landmarks at rest, in canvas pixels. Read-only, for
   * overlays drawn in step with the face (a scan effect, a debug view).
   */
  landmarks(): ReadonlyArray<Readonly<Point>> {
    return this.basePoints.slice(0, 478);
  }

  destroy(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    this.stopAudio();
    if (this.audioCtx) void this.audioCtx.close().catch(() => undefined);
    this.audioCtx = null;
  }

  // --- Framing -------------------------------------------------------------

  /**
   * Lay the whole picture on the canvas (viewport.ts): the face zoom
   * composes it as a portrait that fills the canvas, the full zoom shows
   * all of it. Nothing is cropped; what falls outside the canvas is
   * outside. The mapping is rig image px -> canvas px.
   */
  private computeFraming(): void {
    const [imageW, imageH] = this.rig.image_size;
    const view = viewportFor({
      imageW, imageH,
      faceBox: this.rig.face_box,
      eyeY: eyeLine(this.rig.points, this.rig.face_box),
      canvasW: this.canvas.width,
      canvasH: this.canvas.height,
      zoom: this.scene.zoom ?? 1,
      pan: this.scene.pan,
    });
    this.scale = view.scale;
    this.offsetX = view.offsetX;
    this.offsetY = view.offsetY;
    this.picture = { x: view.offsetX, y: view.offsetY, w: imageW * view.scale, h: imageH * view.scale };

    // Texture coords use the texture's OWN dimensions — the thumbnail may
    // be a scaled copy of the original image.
    const tw = this.texture.naturalWidth / this.rig.image_size[0];
    const th = this.texture.naturalHeight / this.rig.image_size[1];
    this.texPoints = this.rig.points.map(([x, y]) => ({ x: x * tw, y: y * th }));
    this.basePoints = this.rig.points.map(([x, y]) => ({
      x: x * this.scale + this.offsetX,
      y: y * this.scale + this.offsetY,
    }));
    this.detectCutOut();
    this.measureBody();
    this.buildHeadLayer();
    this.field = this.profile.mouth === "character" ? new CharacterField(this.basePoints) : null;
    this.lowerFace = buildLowerFaceRig(this.basePoints);
  }

  /**
   * Cut the head out of the photo, once, as its own layer.
   *
   * The face mesh spans eyebrows to chin — it knows nothing about hair or
   * ears. Warping it moves the face while the rest of the head stands still,
   * which is exactly the failure the first head-motion attempt shipped. So
   * the unit of motion is a rectangle around the whole head, sampled from
   * the texture with feathered edges: soft at the sides and top so a moved
   * layer blends into the still background, and a deep fade at the neck,
   * where a seam lands on a collar instead of across a chin.
   */
  private buildHeadLayer(): void {
    this.headLayer = null;
    this.headGeom = null;
    const xs = this.basePoints.map((p) => p.x);
    const ys = this.basePoints.map((p) => p.y);
    const fx0 = Math.min(...xs), fx1 = Math.max(...xs);
    const fy0 = Math.min(...ys), fy1 = Math.max(...ys);
    const faceW = fx1 - fx0, faceH = fy1 - fy0;
    if (faceW < 4 || faceH < 4) return;

    // Within the picture, not the canvas: the head may reach past the
    // canvas edge (hair above a face zoom) and still be the unit that moves.
    const pic = this.picture;
    const x = Math.max(pic.x, fx0 - faceW * 0.42);
    const y = Math.max(pic.y, fy0 - faceH * 0.9);
    const w = Math.min(pic.x + pic.w, fx1 + faceW * 0.42) - x;
    const h = Math.min(pic.y + pic.h, fy1 + faceH * 0.5) - y;
    if (w < 8 || h < 8) return;

    // The geometry (pivot, travel) serves every picture; the cut-out layer
    // itself only a cut-out, whose head moves over transparency. An opaque
    // picture moves as one instead (render), so it needs no copy.
    this.headGeom = {
      x, y, w, h,
      pivotX: (fx0 + fx1) / 2,
      // A head pivots where it meets the spine, in the upper chest — not
      // about its own middle, which reads as the face rotating in the skull.
      pivotY: fy1 + faceH * 0.85,
      // Peak travel, |pose|=1 extremes the signed-square draw rarely
      // reaches. Kept close to SitePal's measured ~2% drift: anything
      // livelier drags the layer boundary across hair and background
      // detail, which reads as the image tearing, not the head turning.
      yawPx: faceW * 0.03,
      pitchPx: faceH * 0.025,
      faceH,
    };
    if (!this.cutOut) return;

    const layer = document.createElement("canvas");
    layer.width = Math.round(w);
    layer.height = Math.round(h);
    const lctx = layer.getContext("2d");
    if (!lctx) return;

    // The same canvas<->texture mapping the base draw uses.
    const tw = this.texture.naturalWidth / this.rig.image_size[0];
    const th = this.texture.naturalHeight / this.rig.image_size[1];
    lctx.drawImage(
      this.texture,
      ((x - this.offsetX) / this.scale) * tw,
      ((y - this.offsetY) / this.scale) * th,
      (w / this.scale) * tw,
      (h / this.scale) * th,
      0, 0, w, h
    );

    // Feather. destination-out with gradients, one per edge; the bottom one
    // is much deeper because that is the neck seam.
    // Each gradient runs from the interior boundary OUT to the canvas edge.
    // destination-out erases where the fill is opaque, so the interior stop
    // must be transparent — and crucially, points beyond a gradient's start
    // clamp to the first stop, which is what keeps the whole interior at
    // "erase nothing". With the stops reversed, the interior clamps to
    // full-erase and the layer comes out blank; that shipped briefly and
    // made this entire feature a silent no-op.
    const fade = (x0: number, y0: number, x1: number, y1: number) => {
      const g = lctx.createLinearGradient(x0, y0, x1, y1);
      g.addColorStop(0, "rgba(0,0,0,0)");
      g.addColorStop(1, "rgba(0,0,0,1)");
      lctx.fillStyle = g;
      lctx.fillRect(0, 0, w, h);
    };
    lctx.globalCompositeOperation = "destination-out";
    // Wide side/top bands: hair routinely crosses this boundary (long or
    // voluminous hair extends well past the face-derived rect), and a narrow
    // feather there turns every head shift into a visible slice through it.
    const side = w * 0.16, top = h * 0.13, neck = h * 0.26;
    fade(side, 0, 0, 0);
    fade(w - side, 0, w, 0);
    fade(0, top, 0, 0);
    fade(0, h - neck, 0, h);
    lctx.globalCompositeOperation = "source-over";

    this.headLayer = layer;
  }

  /** Current head displacement in canvas px, plus the face's parallax share. */
  private headOffsets(): { dx: number; dy: number; roll: number; fdx: number; fdy: number } {
    const g = this.headGeom;
    if (!g) return { dx: 0, dy: 0, roll: 0, fdx: 0, fdy: 0 };
    // Ghosting: a moved layer over an intact photo leaves a sliver of the
    // original behind it. A cut-out has its head punched out of the base, so
    // it can travel further.
    // Layered heads move at full strength: there is real content behind
    // them, so wider travel reveals pixels instead of tearing them.
    const s = (this.layers || this.cutOut ? 1 : 0.5) * this.tuning.headMotion;
    // sin² envelope, not sin: sin starts at its steepest, which read as the
    // head being yanked downward at every nod onset. sin² starts and ends
    // with zero velocity, so the dip eases in and out.
    const p = this.nodPhase;
    const nod = p < 1 ? Math.sin(p * Math.PI) ** 2 : 0;
    const dx = this.headDrive.yaw * g.yawPx * s;
    const dy =
      (this.headDrive.pitch * g.pitchPx +
        nod * this.nodStrength * this.energy * g.faceH * 0.013) *
      s;
    const roll = this.headDrive.roll * 0.02 * s;
    // NO face parallax. The face mesh redrawn at its own offset over the
    // head layer duplicates whatever crosses the mesh hull — bangs over a
    // forehead become two sets of bangs a few px apart, which reads as cuts
    // through the face. One rigid unit, one offset, nothing to mismatch.
    return { dx, dy, roll, fdx: 0, fdy: 0 };
  }

  /**
   * Does this photo have its background removed?
   *
   * Decides how far the body is allowed to move. Checked by sampling the
   * corners rather than by asking the server, so the engine stays usable with
   * any image and a cut-out made elsewhere still gets the full treatment.
   * Several corners, because one of them can legitimately be part of the
   * subject — a shoulder often reaches the bottom edge.
   */
  private detectCutOut(): void {
    try {
      const probe = document.createElement("canvas");
      probe.width = 32;
      probe.height = 32;
      const ctx = probe.getContext("2d", { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(this.texture, 0, 0, 32, 32);
      const data = ctx.getImageData(0, 0, 32, 32).data;
      const at = (x: number, y: number) => data[(y * 32 + x) * 4 + 3];
      const corners = [at(1, 1), at(30, 1), at(1, 30), at(30, 30)];
      // Two clear corners is enough, and is what a head-and-shoulders cut-out
      // reliably has at the top even when the body fills the bottom.
      this.cutOut = corners.filter((a) => a < 24).length >= 2;
    } catch {
      // Tainted canvas (cross-origin texture): assume it is not a cut-out,
      // which is the conservative choice — less movement, never a stray edge.
      this.cutOut = false;
    }
  }

  /**
   * Where the body pivots, and how far it may travel.
   *
   * The pivot goes below the canvas, roughly where the feet would be. A small
   * rotation about a distant point is very nearly a translation that grows
   * with height — which is both what an inverted pendulum does and the reason
   * the bottom of the frame stays put while the head moves.
   */
  private measureBody(): void {
    const xs = this.basePoints.map((p) => p.x);
    const ys = this.basePoints.map((p) => p.y);
    const faceW = Math.max(1, Math.max(...xs) - Math.min(...xs));
    const faceH = Math.max(1, Math.max(...ys) - Math.min(...ys));
    const faceCentreY = (Math.min(...ys) + Math.max(...ys)) / 2;

    this.bodyPivot = {
      x: (Math.min(...xs) + Math.max(...xs)) / 2,
      y: this.canvas.height * BODY_PIVOT_DEPTH,
    };
    // The measurement this is matched against was taken across a head, and
    // the landmarks only span a face, so scale up to compare like with like.
    const headW = faceW * FACE_TO_HEAD_WIDTH;
    const reach = Math.max(1, this.bodyPivot.y - faceCentreY);
    // Half the peak-to-peak travel, expressed as the angle that produces it
    // at head height.
    this.swayAngle = (headW * SWAY_TRAVEL) / 2 / reach;
    this.breathRise = faceH * BREATH_RISE;
  }

  /**
   * The lip's own colour, taken from the outer lip ring.
   *
   * The mouth interior used to be three hardcoded browns near black. On a
   * pale face that is a hole punched in the skin, and it is the same hole on
   * every avatar regardless of colouring. A real mouth interior is a darker,
   * less saturated version of the lips in front of it, so sampling the lips
   * gives every face an interior that belongs to it.
   */
  private sampleLipColour(): void {
    try {
      const off = document.createElement("canvas");
      off.width = this.texture.naturalWidth;
      off.height = this.texture.naturalHeight;
      const ctx = off.getContext("2d", { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(this.texture, 0, 0);
      const picks: { lum: number; rgb: [number, number, number] }[] = [];
      for (const i of this.rig.mouth_indices) {
        const p = this.texPoints[i];
        if (!p) continue;
        const x = Math.max(0, Math.min(off.width - 1, Math.round(p.x)));
        const y = Math.max(0, Math.min(off.height - 1, Math.round(p.y)));
        const d = ctx.getImageData(x, y, 1, 1).data;
        const rgb: [number, number, number] = [d[0], d[1], d[2]];
        picks.push({ lum: luma(rgb), rgb });
      }
      if (!picks.length) return;
      // Median: the ring straddles the lip edge, so the extremes are skin on
      // one side and the seam shadow on the other.
      picks.sort((a, b) => a.lum - b.lum);
      this.lipColour = picks[Math.floor(picks.length / 2)].rgb;

      // Cheeks, not lips, say how the face is lit: lips are darker and far
      // more saturated than the light falling on them (lipstick more so), so
      // teeth exposed from lip luminance came out grey on a bright face.
      const skin: { lum: number; rgb: [number, number, number] }[] = [];
      for (const i of CHEEK_LANDMARKS) {
        const q = this.texPoints[i];
        if (!q) continue;
        const sx = Math.max(0, Math.min(off.width - 1, Math.round(q.x)));
        const sy = Math.max(0, Math.min(off.height - 1, Math.round(q.y)));
        const c = ctx.getImageData(sx, sy, 1, 1).data;
        const rgb: [number, number, number] = [c[0], c[1], c[2]];
        skin.push({ lum: luma(rgb), rgb });
      }
      if (skin.length) {
        skin.sort((a, b) => a.lum - b.lum);
        this.skinColour = skin[Math.floor(skin.length / 2)].rgb;
      }
      this.sampleFaceHighlight();
      this.sampleFaceSharpness(ctx);
    } catch {
      // Tainted texture: keep the default, which is a mid warm lip.
    }
  }

  /**
   * How sharp the picture is (face-sharpness.ts): the width of its crispest
   * strong edges round the mouth and the eyes, in its own pixels, read
   * from `ctx`, which holds the texture 1:1 (no filtering: the widths are
   * the picture's). The photographic mouth feathers its aperture by it and
   * softens the teeth to it. Null on a flat picture.
   */
  private sampleFaceSharpness(ctx: CanvasRenderingContext2D): void {
    const fields = sharpnessBoxes(this.texPoints, this.texture.naturalWidth, this.texture.naturalHeight).map((b) => {
      const d = ctx.getImageData(b.x, b.y, b.w, b.h);
      return lumaField(d.data, d.width, d.height);
    });
    this.faceSharpness = faceSharpness(fields);
  }

  /** How many canvas pixels one texture pixel is, at rest. */
  private pixelScale(): number {
    const tw = this.texture.naturalWidth / Math.max(1, this.rig.image_size[0]);
    return tw > 0 ? this.scale / tw : this.scale;
  }

  /**
   * The face's brightest skin or sclera, from a small box-filtered copy of
   * its silhouette's box: one draw and one read, so a glint of a pixel or
   * two cannot set it, and nothing outside the face oval (hair, a collar, a
   * white wall) counts.
   */
  private sampleFaceHighlight(): void {
    const oval = FACE_OVAL.map((i) => this.texPoints[i]).filter(Boolean);
    if (oval.length < 8) return;
    const x0 = Math.min(...oval.map((p) => p.x)), x1 = Math.max(...oval.map((p) => p.x));
    const y0 = Math.min(...oval.map((p) => p.y)), y1 = Math.max(...oval.map((p) => p.y));
    if (!(x1 > x0) || !(y1 > y0)) return;
    const grid = 96;
    const small = document.createElement("canvas");
    small.width = grid;
    small.height = grid;
    const ctx = small.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;
    ctx.drawImage(this.texture, x0, y0, x1 - x0, y1 - y0, 0, 0, grid, grid);
    const data = ctx.getImageData(0, 0, grid, grid).data;
    this.faceHighlight = faceHighlight(oval, (column, row) => {
      const i = (row * grid + column) * 4;
      return data[i + 3] < 128 ? null : [data[i], data[i + 1], data[i + 2]];
    }, grid);
  }

  /** Each eye's lid colour, from the skin beside it, for the painted lid. */
  private sampleLidColours(): void {
    if (this.profile.blink !== "lid") return;
    try {
      const off = document.createElement("canvas");
      off.width = this.texture.naturalWidth;
      off.height = this.texture.naturalHeight;
      const ctx = off.getContext("2d", { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(this.texture, 0, 0);
      for (let e = 0; e < 2; e++) {
        const shape = this.eyeShape(this.texPoints, e);
        const read = (p: Point): Rgb | null => {
          const x = Math.round(p.x), y = Math.round(p.y);
          if (x < 0 || y < 0 || x >= off.width || y >= off.height) return null;
          const d = ctx.getImageData(x, y, 1, 1).data;
          return d[3] < 128 ? null : [d[0], d[1], d[2]];
        };
        const spots = lidSamplePoints(shape.upper, shape.lower);
        const nUp = shape.upper.length - 2;
        const readUp = spots.slice(0, nUp).map(read);
        const readDown = spots.slice(nUp).map(read);
        // A brow or a lash line can sit where "above the eye" is read, and it
        // is dark: the lid's own skin is the lighter end of what both sides
        // give, and the skin above is read from them together.
        const below = medianColour(readDown, 0.65);
        const above = medianColour([...readUp, ...readDown], 0.65);
        const either = above ?? below;
        if (either) this.lidTone[e] = { above: above ?? either, below: below ?? either };
        // How far the eye really reaches, and whether the skin below is plain.
        const w = Math.hypot(shape.upper[shape.upper.length - 1].x - shape.upper[0].x, shape.upper[shape.upper.length - 1].y - shape.upper[0].y);
        const all = [...shape.upper, ...shape.lower];
        const rx0 = Math.max(0, Math.floor(Math.min(...all.map((q) => q.x)) - w * 1.1));
        const ry0 = Math.max(0, Math.floor(Math.min(...all.map((q) => q.y)) - w * 1.1));
        const rx1 = Math.min(off.width, Math.ceil(Math.max(...all.map((q) => q.x)) + w * 1.1));
        const ry1 = Math.min(off.height, Math.ceil(Math.max(...all.map((q) => q.y)) + w * 1.1));
        if (rx1 > rx0 && ry1 > ry0 && either) {
          const img = ctx.getImageData(rx0, ry0, rx1 - rx0, ry1 - ry0);
          const at = (x: number, y: number): Rgb | null => {
            const px = Math.round(x) - rx0, py = Math.round(y) - ry0;
            if (px < 0 || py < 0 || px >= img.width || py >= img.height) return null;
            const i = (py * img.width + px) * 4;
            return img.data[i + 3] < 128 ? null : [img.data[i], img.data[i + 1], img.data[i + 2]];
          };
          // How much the skin's own texture varies: fur and pores are noise the
          // eye's edge must stand out from, flat art has none.
          const around = [...readUp, ...readDown].filter((c): c is Rgb => !!c);
          const ref = either;
          const spread = around.length
            ? Math.sqrt(around.reduce((sum, c) => sum + (c[0] - ref[0]) ** 2 + (c[1] - ref[1]) ** 2 + (c[2] - ref[2]) ** 2, 0) / around.length)
            : 0;
          this.lidExtent[e] = eyeExtent(at, shape, Math.max(50, Math.min(95, spread * 2.5)));
          // The patch the lid would copy: the skin below the eye. It must be one
          // surface (fur, skin), not an outline or another shape.
          const bottom = Math.max(...shape.lower.map((q) => q.y));
          const left = Math.min(...all.map((q) => q.x));
          let far = 0, n = 0;
          for (let a = 0; a < 10; a++) {
            for (let b = 0; b < 5; b++) {
              const c = at(left + (w * (a + 0.5)) / 10, bottom + w * (0.08 + 0.1 * b));
              if (!c) continue;
              n++;
              const ref = below ?? either;
              if (Math.hypot(c[0] - ref[0], c[1] - ref[1], c[2] - ref[2]) > Math.max(70, spread * 3)) far++;
            }
          }
          this.lidCloneOk[e] = n > 0 && far / n <= 0.18;
        }
      }
    } catch {
      // Tainted texture: the default skin tone.
    }
  }

  /** An eye's two lids as ordered point lists, corner to corner. */
  private eyeShape(pts: readonly Point[], e: number): { upper: Point[]; lower: Point[] } {
    const [c0, c1] = EYE_CORNERS[e];
    const byX = (a: Point, b: Point) => a.x - b.x;
    const upper = [pts[c0], ...UPPER_LIDS[e].map((i) => pts[i]), pts[c1]].sort(byX);
    const lower = [pts[c0], ...LOWER_LIDS[e].map((i) => pts[i]), pts[c1]].sort(byX);
    return { upper, lower };
  }

  /**
   * Copies of the picture's own pixels for a painted lid: a canvas rectangle
   * of the face as drawn, from the texture the face is drawn from. The eye
   * stays where it was drawn (the mesh does not move it for a lid blink), so
   * canvas and texture differ by a scale and an offset read off its corners.
   */
  /** A texture point of an eye, in the canvas the eye is drawn in. */
  private fromTexture(e: number, pts: Point[], t: Point): Point {
    const [c0, c1] = EYE_CORNERS[e];
    const a = pts[c0], b = pts[c1], ta = this.texPoints[c0], tb = this.texPoints[c1];
    if (!a || !b || !ta || !tb) return t;
    const k = Math.hypot(tb.x - ta.x, tb.y - ta.y) / Math.max(Math.hypot(b.x - a.x, b.y - a.y), 1e-6);
    return { x: a.x + (t.x - ta.x) / k, y: a.y + (t.y - ta.y) / k };
  }

  private lidBlit(e: number, pts: Point[]): Blit | null {
    const [c0, c1] = EYE_CORNERS[e];
    const a = pts[c0], b = pts[c1], ta = this.texPoints[c0], tb = this.texPoints[c1];
    if (!a || !b || !ta || !tb) return null;
    const k = Math.hypot(tb.x - ta.x, tb.y - ta.y) / Math.max(Math.hypot(b.x - a.x, b.y - a.y), 1e-6);
    return (c, dst, src) => {
      if (dst.w < 1 || dst.h < 1 || src.w < 1 || src.h < 1) return;
      c.drawImage(
        this.texture,
        ta.x + (src.x - a.x) * k, ta.y + (src.y - a.y) * k, src.w * k, src.h * k,
        dst.x, dst.y, dst.w, dst.h
      );
    };
  }

  /** The painted lid of a profile that blinks that way. */
  private drawLids(pts: Point[]): void {
    if (this.profile.blink !== "lid" || this.blink <= 0 || this.tuning.blink <= 0) return;
    const amount = lidAmount(blinkEase(this.blink));
    const flat = this.look.flat;
    for (let e = 0; e < 2; e++) {
      const shape = this.eyeShape(pts, e);
      const outline = this.lidExtent[e]
        ? this.lidExtent[e]!.map((q) => this.fromTexture(e, pts, q))
        : null;
      const blit = flat || !this.lidCloneOk[e] ? null : this.lidBlit(e, pts);
      paintLid(this.ctx, shape, amount, this.lidTone[e], this.lashRgb[e], flat, blit, outline);
    }
  }

  /**
   * Cel art or a render, and the picture's own line, for the character mouth
   * to paint in. Only a rig whose profile asks for that mouth pays for it.
   */
  private sampleCharacterLook(): void {
    // For every profile: the character mouth paints with it, and the mesh
    // pads its seams on flat art whichever mouth it has (trianglePads).
    const skin: Rgb = this.skinColour ?? DEFAULT_LOOK.skin;
    this.look = { ...DEFAULT_LOOK, lip: this.lipColour, skin };
    try {
      const l = this.texPoints[61], r = this.texPoints[291];
      if (!l || !r) return;
      const w = Math.max(Math.hypot(r.x - l.x, r.y - l.y), 4);
      const cx = (l.x + r.x) / 2, cy = (l.y + r.y) / 2;
      const x0 = Math.max(0, Math.floor(cx - w * 2)), y0 = Math.max(0, Math.floor(cy - w * 1.2));
      const x1 = Math.min(this.texture.naturalWidth, Math.ceil(cx + w * 2));
      const y1 = Math.min(this.texture.naturalHeight, Math.ceil(cy + w * 1.7));
      if (x1 <= x0 || y1 <= y0) return;
      const off = document.createElement("canvas");
      off.width = this.texture.naturalWidth;
      off.height = this.texture.naturalHeight;
      const ctx = off.getContext("2d", { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(this.texture, 0, 0);
      const data = ctx.getImageData(x0, y0, x1 - x0, y1 - y0);
      const pixel = (x: number, y: number): Rgb | null => {
        const px = Math.round(x) - x0, py = Math.round(y) - y0;
        if (px < 0 || py < 0 || px >= data.width || py >= data.height) return null;
        const i = (py * data.width + px) * 4;
        if (data.data[i + 3] < 128) return null;
        return [data.data[i], data.data[i + 1], data.data[i + 2]];
      };
      const seam = INNER_UPPER.map((i) => this.texPoints[i]).filter(Boolean);
      this.look = sampleLook(pixel, seam, { cx, cy, w }, this.lipColour, skin);
    } catch {
      // Tainted texture: the default look, shaded.
    }
  }

  /** The darkest run along each upper lid — the lashes as this face has them. */
  private sampleLashColour(): void {
    try {
      const off = document.createElement("canvas");
      off.width = this.texture.naturalWidth;
      off.height = this.texture.naturalHeight;
      const ctx = off.getContext("2d", { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(this.texture, 0, 0);
      for (let e = 0; e < 2; e++) {
        const lid = UPPER_LIDS[e].map((i) => this.texPoints[i]).filter(Boolean);
        if (lid.length < 3) continue;
        const picks: { lum: number; rgb: [number, number, number] }[] = [];
        for (const p of lid) {
          for (let dy = -1; dy <= 1; dy++) {
            const x = Math.max(0, Math.min(off.width - 1, Math.round(p.x)));
            const y = Math.max(0, Math.min(off.height - 1, Math.round(p.y + dy)));
            const d = ctx.getImageData(x, y, 1, 1).data;
            const rgb: [number, number, number] = [d[0], d[1], d[2]];
            picks.push({ lum: luma(rgb), rgb });
          }
        }
        if (!picks.length) continue;
        // The darkest quartile along the lid IS the lash line, whatever
        // colour this face's lashes happen to be.
        picks.sort((a, b) => a.lum - b.lum);
        const [r, g, b] = picks[Math.floor(picks.length * 0.15)].rgb;
        this.lashColour[e] = `rgba(${r}, ${g}, ${b}, 0.8)`;
        this.lashRgb[e] = [r, g, b];
      }
    } catch {
      // Tainted texture: keep the neutral dark default.
    }
  }

  /**
   * Refine the mesh around the mouth: 1:4 subdivide every triangle with at
   * least two vertices near the mouth. Big triangles are what make lip
   * deformation look faceted — midpoint vertices (tracked by parent pair)
   * follow the warp smoothly at near-zero cost (~200 extra triangles).
   */
  private subdivideMouthRegion(): void {
    const mouth = this.rig.mouth_indices ?? [];
    if (!mouth.length) {
      this.triangles = this.rig.triangles.map((t) => [...t] as [number, number, number]);
      return;
    }
    let mcx = 0;
    let mcy = 0;
    for (const i of mouth) {
      mcx += this.basePoints[i].x;
      mcy += this.basePoints[i].y;
    }
    mcx /= mouth.length;
    mcy /= mouth.length;
    const xs = mouth.map((i) => this.basePoints[i].x);
    const radius = Math.max((Math.max(...xs) - Math.min(...xs)) * 0.95, 8);
    const near = new Set<number>();
    for (let i = 0; i < this.basePoints.length; i++) {
      if (Math.hypot(this.basePoints[i].x - mcx, this.basePoints[i].y - mcy) < radius) {
        near.add(i);
      }
    }

    const midCache = new Map<string, number>();
    const midpoint = (a: number, b: number): number => {
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      let index = midCache.get(key);
      if (index === undefined) {
        index = this.basePoints.length + this.derivedParents.length;
        midCache.set(key, index);
        this.derivedParents.push([a, b]);
        this.texPoints.push({
          x: (this.texPoints[a].x + this.texPoints[b].x) / 2,
          y: (this.texPoints[a].y + this.texPoints[b].y) / 2,
        });
      }
      return index;
    };

    this.triangles = [];
    for (const [a, b, c] of this.rig.triangles) {
      const inside = Number(near.has(a)) + Number(near.has(b)) + Number(near.has(c));
      if (inside >= 2) {
        const ab = midpoint(a, b);
        const bc = midpoint(b, c);
        const ca = midpoint(c, a);
        this.triangles.push([a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]);
      } else {
        this.triangles.push([a, b, c]);
      }
    }
  }

  /**
   * The neck band below the jaw line (jaw-rig.ts buildNeckBand), appended
   * after the mouth subdivision's midpoints: its vertices, their texture
   * positions (the still picture below the chin) and its triangles. Every
   * rig gets one, derived from its own points.
   */
  private buildNeckBand(): void {
    this.neckBand = [];
    const band = buildNeckBand(this.basePoints, this.basePoints.length + this.derivedParents.length);
    const tw = this.texture.naturalWidth / this.rig.image_size[0];
    const th = this.texture.naturalHeight / this.rig.image_size[1];
    for (const v of band.vertices) {
      this.neckBand.push({ base: { x: v.x, y: v.y }, parent: v.parent, share: v.share });
      this.texPoints.push({
        x: ((v.x - this.offsetX) / this.scale) * tw,
        y: ((v.y - this.offsetY) / this.scale) * th,
      });
    }
    this.triangles.push(...band.triangles);
  }

  /**
   * Guard: if the stored inner-lip ring spread is implausible vs the mouth
   * box (bad rig / wrong indices), rebuild a usable ring from mouth_indices.
   */
  private validInnerRing(): number[] {
    const ring = this.rig.inner_lip_ring ?? [];
    const mouth = this.rig.mouth_indices ?? [];
    if (ring.length < 6) return this.ringFromMouth(mouth);
    const pts = ring.map((i) => this.rig.points[i]);
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const ringW = Math.max(...xs) - Math.min(...xs);
    const ringH = Math.max(...ys) - Math.min(...ys);
    const mpts = mouth.map((i) => this.rig.points[i]);
    const mxs = mpts.map((p) => p[0]);
    const mys = mpts.map((p) => p[1]);
    const mouthW = Math.max(...mxs) - Math.min(...mxs);
    const mouthH = Math.max(...mys) - Math.min(...mys);
    const plausible =
      ringW > mouthW * 0.2 && ringW <= mouthW * 1.05 && ringH <= Math.max(mouthH * 1.05, 1);
    return plausible ? ring : this.ringFromMouth(mouth);
  }

  private ringFromMouth(mouth: number[]): number[] {
    if (!mouth.length) return [];
    // Innermost half of the mouth points (closest to the mouth centroid).
    const cx = mouth.reduce((s, i) => s + this.rig.points[i][0], 0) / mouth.length;
    const cy = mouth.reduce((s, i) => s + this.rig.points[i][1], 0) / mouth.length;
    return [...mouth]
      .sort((a, b) => {
        const da = (this.rig.points[a][0] - cx) ** 2 + (this.rig.points[a][1] - cy) ** 2;
        const db = (this.rig.points[b][0] - cx) ** 2 + (this.rig.points[b][1] - cy) ** 2;
        return da - db;
      })
      .slice(0, Math.max(8, Math.floor(mouth.length / 2)));
  }

  // --- Public speech API -----------------------------------------------------

  /**
   * Play base64 audio with a viseme cue track. Resolves onEnd (also on stop()).
   *
   * Without a `cueClock` option (every page but the lab) cue time is the
   * audio element's own position (media-clock.ts): held at 0 until the voice
   * is actually playing, re-anchored on `playing` and `seeked`, followed
   * every frame, and standing still with the mouth closed while the element
   * is paused. A clock started at play() ran ahead of the voice by however
   * long the audio took to start, for the whole utterance.
   */
  playAudio(audioB64: string, mime: string, cues: Cue[], onEnd?: () => void): void {
    this.stopAudio();
    const audio = new Audio(`data:${mime};base64,${audioB64}`);
    this.currentAudio = audio;
    const clock = this.cueClock ? null : new MediaClock(audio);
    this.audioClock = clock;
    if (clock) {
      const sync = () => {
        if (audio !== this.currentAudio) return;
        this.placeBeatWalker(clock.sync(performance.now()));
      };
      audio.addEventListener("playing", sync);
      audio.addEventListener("seeked", sync);
    }
    this.onAudioEnd = onEnd ?? null;
    this.cues = prepareCues(cues);
    this.speaking = true;
    this.body.beginSpeech(performance.now(), utteranceMs(cues));
    this.beats = emphasisBeats(this.cues);
    this.nextBeat = 0;
    this.gazeTarget = { x: 0, y: 0 }; // look at the person you are talking to

    // Only reroute through the analyser when the cue track is too sparse to
    // drive the mouth (amplitude fallback needed). Rerouting risks silent
    // playback (suspended AudioContext, Safari data:-URL taint), so rich cue
    // tracks — every Liveface provider — play natively.
    if (cues.length < 4) this.attachAnalyser(audio);

    audio.addEventListener("ended", () => {
      if (audio !== this.currentAudio) return;
      this.finishSpeech();
    });
    audio.addEventListener("error", () => {
      if (audio !== this.currentAudio) return;
      this.finishSpeech();
    });
    const playPromise = audio.play();
    this.cueStart = performance.now();
    if (playPromise) {
      // An abort during stop() must NOT surface as an unhandled rejection.
      playPromise.catch(() => {
        if (audio === this.currentAudio) this.finishSpeech();
      });
    }
  }

  /** Drive lip-sync from an externally played voice (e.g. speechSynthesis):
   * cues only, no audio element. */
  playCues(cues: Cue[]): void {
    this.stopAudio();
    this.cues = prepareCues(cues);
    this.speaking = true;
    this.cueStart = performance.now();
    this.body.beginSpeech(this.cueStart, utteranceMs(cues));
    this.beats = emphasisBeats(this.cues);
    this.nextBeat = 0;
    this.gazeTarget = { x: 0, y: 0 };
  }

  /**
   * Swap the mouth renderer on a live engine, or pass null for the classic
   * drawn mouth. Progressive like setLayers: the widget is already animating
   * on a thumbnail when the mouth bundle and its assets arrive, and an avatar
   * that waited for them would show nothing in the meantime.
   */
  setMouthExtension(extension: MouthExtension | null): void {
    this.mouthExtension = extension ?? undefined;
  }

  /** Replace a growing external cue track without restarting articulation. */
  updateCueTrack(cues: Cue[]): void {
    // Opt-in streaming extension: append look-ahead without restarting body
    // motion, the articulation smoother, or the speech clock.
    const time = this.cueTime(performance.now());
    this.cues = prepareCues(cues);
    this.beats = emphasisBeats(this.cues);
    this.nextBeat = this.beats.findIndex(b => b.t > time);
    if (this.nextBeat < 0) this.nextBeat = this.beats.length;
  }

  /** Re-align the cue clock to a known position in the track (ms). */
  syncCueTime(ms: number): void {
    this.cueStart = performance.now() - ms;
    this.placeBeatWalker(ms);
  }

  /** Re-place the beat walker at `ms`: after a seek the beats behind the new
   *  position are spent, not pending. */
  private placeBeatWalker(ms: number): void {
    this.nextBeat = this.beats.findIndex((b) => b.t > ms);
    if (this.nextBeat < 0) this.nextBeat = this.beats.length;
  }

  stopSpeech(): void {
    this.stopAudio();
    this.speaking = false;
    this.cues = [];
    this.targetWeights = { ...ZERO_WEIGHTS };
    this.body.endSpeech();
    this.blinks.onSpeechEnd(performance.now());
    this.beats = [];
  }

  isSpeaking(): boolean {
    return this.speaking;
  }

  private finishSpeech(): void {
    this.speaking = false;
    this.cues = [];
    this.targetWeights = { ...ZERO_WEIGHTS };
    this.body.endSpeech();
    this.blinks.onSpeechEnd(performance.now());
    this.beats = [];
    const cb = this.onAudioEnd;
    this.onAudioEnd = null;
    this.currentAudio = null;
    this.audioClock = null;
    if (cb && !this.destroyed) cb();
  }

  private stopAudio(): void {
    // Cue time goes back to the frame clock (playCues, the next playAudio).
    this.audioClock = null;
    if (this.currentAudio) {
      const audio = this.currentAudio;
      this.currentAudio = null;
      this.onAudioEnd = null;
      audio.pause();
      audio.src = "";
    }
  }

  private attachAnalyser(audio: HTMLAudioElement): void {
    try {
      if (!this.audioCtx) {
        const Ctor = window.AudioContext ?? (window as never as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        this.audioCtx = new Ctor();
        this.analyser = this.audioCtx.createAnalyser();
        this.analyser.fftSize = 256;
        this.analyserData = new Uint8Array(this.analyser.frequencyBinCount);
        this.analyser.connect(this.audioCtx.destination);
      }
      const ctx = this.audioCtx;
      // createMediaElementSource REROUTES the element's output through the
      // context — if the context is suspended (autoplay policy), playback
      // goes silent. Only connect once the context is confirmed running;
      // otherwise the element plays natively and we just lose the
      // amplitude fallback.
      void ctx
        .resume()
        .then(() => {
          if (ctx.state !== "running" || audio !== this.currentAudio) return;
          const source = ctx.createMediaElementSource(audio);
          source.connect(this.analyser!);
        })
        .catch(() => undefined);
    } catch {
      // Analyser is an enhancement (amplitude fallback); audio still plays.
    }
  }

  private amplitude(): number {
    if (!this.analyser || !this.analyserData) return 0;
    this.analyser.getByteFrequencyData(this.analyserData as Uint8Array<ArrayBuffer>);
    let sum = 0;
    for (let i = 0; i < this.analyserData.length; i++) sum += this.analyserData[i];
    return sum / (this.analyserData.length * 255);
  }

  // --- Animation tick --------------------------------------------------------

  private cueTime(now: number): number {
    const external = this.cueClock?.();
    if (external !== undefined && Number.isFinite(external)) return Math.max(0, external);
    if (this.audioClock) return this.audioClock.read(now);
    return now - this.cueStart;
  }

  /** The voice is paused mid-utterance (the page, the OS, a headset): the
   *  mouth closes rather than freezing on whatever shape it was making. */
  private voicePaused(): boolean {
    return this.audioClock?.paused ?? false;
  }

  /** The audio has been asked to play and is not heard yet (decoding, the
   *  output device waking): cue time holds at 0 meanwhile. */
  private awaitingVoice(): boolean {
    return this.audioClock !== null && !this.audioClock.started;
  }

  private currentViseme(now: number): string {
    if (!this.speaking || !this.cues.length || this.voicePaused()) return "sil";
    const t = this.cueTime(now);
    let viseme = "sil";
    for (const cue of this.cues) {
      if (cue.t <= t) viseme = cue.viseme;
      else break;
    }
    return viseme;
  }

  /**
   * Co-articulated viseme weights: instead of stepping to each cue, blend
   * between the current and next viseme across the cue interval — real
   * mouths are always mid-transition, never parked on a phoneme.
   */
  private blendedCueWeights(now: number): BlendWeights {
    if (this.voicePaused()) return { ...ZERO_WEIGHTS };
    const t = this.cueTime(now);
    let index = -1;
    for (let i = 0; i < this.cues.length; i++) {
      if (this.cues[i].t <= t) index = i;
      else break;
    }
    if (index < 0) return { ...ZERO_WEIGHTS };

    // Coarticulation by overlapping dominance (Cohen-Massaro). Blending only
    // the two bracketing cues walked the mouth in straight lines from one
    // viseme vertex to the next, with a velocity corner at every cue — that
    // piecewise-linear zigzag is what read as "random" darting. Here every
    // cue near `t` contributes on a smooth bell, so the shape at any instant
    // is a weighted mixture of what the mouth just did, is doing, and is
    // about to do. That is also how real articulators behave: /k/ in "key"
    // and "coo" are different shapes because the vowel is already pulling.
    const out = { ...ZERO_WEIGHTS };
    const keys = Object.keys(out) as (keyof BlendWeights)[];
    const from = Math.max(0, index - 2);
    const to = Math.min(this.cues.length, index + 3);
    const spanOf = (i: number): number => {
      const next = this.cues[i + 1];
      return next ? Math.max(1, next.t - this.cues[i].t) : DEFAULT_CUE_SPAN_MS;
    };

    let totalWeight = 0;
    for (let i = from; i < to; i++) {
      const span = spanOf(i);
      // Bell centred on the cue's own span, widened for longer sounds.
      const sigma = Math.max(MIN_DOMINANCE_MS, span * 0.62);
      const z = Math.abs(t - (this.cues[i].t + span / 2)) / sigma;
      const weight = Math.exp(-0.5 * Math.pow(z, BELL_EXPONENT));
      if (weight < 1e-3) continue;
      const shape = this.rig.visemes[this.cues[i].viseme] ?? {};
      // Stress amplitude: an unstressed syllable is a smaller mouth, not a
      // faster one. Scaling the shape (rather than the duration) is what
      // makes "MARket" look like one stressed and one reduced syllable
      // instead of two identical ones.
      const amp = this.cues[i].a ?? 1;
      for (const key of keys) out[key] += (shape[key] ?? 0) * amp * weight;
      totalWeight += weight;
    }
    if (totalWeight <= 0) {
      return { ...ZERO_WEIGHTS, ...(this.rig.visemes[this.cues[index].viseme] ?? {}) };
    }
    for (const key of keys) out[key] /= totalWeight;

    // Constraint pass: pull the blended shape back onto the closure-critical
    // visemes. The gate is itself a smooth bell, so re-asserting the target
    // costs no continuity — it only sharpens where a real mouth is sharp.
    for (let i = from; i < to; i++) {
      const strength = IMPERATIVE[this.cues[i].viseme];
      if (!strength) continue;
      const span = spanOf(i);
      const sigma = Math.max(MIN_IMPERATIVE_MS, span * IMPERATIVE_WIDTH);
      const z = (t - (this.cues[i].t + span / 2)) / sigma;
      // Deliberately NOT scaled by the cue's stress amplitude: /p/ /b/ /m/
      // close completely in an unstressed syllable too — "puPPET" shuts the
      // lips twice, equally, whatever the stress does to the vowels.
      const gate = Math.exp(-0.5 * z * z) * strength;
      if (gate < 1e-3) continue;
      const shape = this.rig.visemes[this.cues[i].viseme] ?? {};
      for (const key of keys) out[key] += ((shape[key] ?? 0) - out[key]) * gate;
    }
    return out;
  }

  private loop(now: number): void {
    if (this.destroyed) return;
    this.tick(now);
    this.render();
    this.raf = requestAnimationFrame(this.loop);
  }

  private tick(now: number): void {
    // Viseme targets: co-articulated blend across cues (+ amplitude
    // fallback when the track is silent but audio clearly isn't).
    const visemeWeights = this.pose?.()?.weights ?? (this.speaking ? this.blendedCueWeights(now) : { ...ZERO_WEIGHTS });
    const silent = this.speaking && this.currentViseme(now) === "sil";
    if (silent) {
      const amp = this.amplitude();
      if (amp > 0.06) visemeWeights.jawOpen = Math.min(0.5, amp * 1.2);
    }
    // Waiting for the voice to start is not a pause in it. Cue time holds at
    // 0 until the audio plays, which takes hundreds of ms on a phone, and a
    // greeting that opens on /h/ is silence at 0: counted as a pause, it
    // began with a breath, a blink and a glance away before the first word.
    if (silent && !this.awaitingVoice()) {
      // A pause that has lasted long enough to be a pause (not the gap
      // between two words) gets a catch-breath. Once per run of silence.
      if (this.silenceSince === null) this.silenceSince = now;
      else if (now - this.silenceSince >= PAUSE_BREATH_MS) {
        this.body.catchBreath(now);
        this.blinks.onPause(now);
        // Sometimes a pause is a thought: glance down or aside, and the
        // next fixation (re-picked on resume) brings the eyes back.
        if (Math.random() < 0.45) {
          this.gazeTarget = { x: (Math.random() * 2 - 1) * 0.16, y: 0.18 + Math.random() * 0.12 };
          this.nextSaccadeAt = now + 700 + Math.random() * 600;
        }
        this.silenceSince = Infinity; // spent for this run
      }
    } else {
      if (this.silenceSince === Infinity) {
        // Speech resumed after a real pause: come back to the listener.
        this.gazeTarget = { x: 0, y: 0 };
        this.nextSaccadeAt = now + 900 + Math.random() * 1400;
      }
      this.silenceSince = null;
    }
    this.targetWeights = visemeWeights;

    // Critically-damped-ish approach to targets. Slow on purpose: a
    // newsreader's articulation is small and fluid, and the damping is the
    // main thing standing between cue tracks and a flapping jaw.
    // Frame-rate INDEPENDENT smoothing. A fixed fraction per frame makes the
    // effective time constant depend on how fast frames happen to arrive, so
    // any jitter in frame timing became jitter in the mouth. Convert to an
    // exponential filter over real elapsed time: rate = 1 - exp(-dt / tau).
    const dt = Math.min(64, Math.max(4, now - (this.lastTickAt || now - 16.7)));
    this.lastTickAt = now;
    const smoothing = Math.max(0.15, this.tuning.smoothness);
    // Jaws CLOSE faster than they open (muscle + gravity). Closing slower
    // than opening left the mouth hanging open through a whole sentence —
    // measured only 1% closed frames before that was corrected.
    const TAU_OPEN = 47 / smoothing; // ms; matches the old 0.30/frame @60fps
    const TAU_CLOSE = 33 / smoothing; // ms; matches the old 0.40/frame @60fps
    const keys = Object.keys(this.weights) as (keyof BlendWeights)[];
    for (const key of keys) {
      const target = this.targetWeights[key];
      const tau =
        (target > this.weights[key] ? TAU_OPEN : TAU_CLOSE) * INERTIA[key];
      const rate = 1 - Math.exp(-dt / tau);
      this.weights[key] += (target - this.weights[key]) * rate;
    }

    // The tongue follows the sound being made, eased: the sounds are
    // discrete and the tongue is not.
    if (this.field) {
      const sound = this.pose?.()?.viseme ?? this.currentViseme(now);
      const target = TONGUE_RAISE[sound] ?? 0;
      this.tongue += (target - this.tongue) * (1 - Math.exp(-dt / 55));
    }

    // Speech energy (drives head pose amplitude).
    const instant = this.speaking
      ? Math.min(1, this.weights.jawOpen + this.weights.mouthStretch * 0.5 + this.amplitude())
      : 0;
    this.energy += (instant - this.energy) * (1 - Math.exp(-dt / 270));

    // Blinks are placed by events (pauses, saccades, head turns, speech
    // end) with a timer only as a fallback — see blink.ts. `silent` was
    // computed above from the cue track.
    this.blinks.update(dt, now, { speaking: this.speaking, wordActive: this.speaking && !silent });
    this.blink = this.blinks.phase;

    // Gentle nods on a loose cadence while speaking.
    // Emphasis beats: the head marks the syllables the voice leaned on.
    // Walked on the CUE clock, not wall time, so a beat stays on its
    // syllable when playback is re-synced (syncCueTime).
    if (this.speaking && this.beats.length) {
      const cueTime = this.cueTime(now);
      while (this.nextBeat < this.beats.length && this.beats[this.nextBeat].t <= cueTime) {
        const beat = this.beats[this.nextBeat++];
        // Only if the beat is still near: after a seek, skip the ones the
        // clock jumped over rather than firing a burst of stale nods.
        if (cueTime - beat.t < BEAT_NOD_MS) {
          this.nodPhase = 0;
          this.nodMs = BEAT_NOD_MS;
          this.nodStrength = beat.strength;
        }
      }
    } else if (this.speaking && now >= this.nextNodAt) {
      // No usable emphasis in this track (a browser voice, or a cue track
      // with flat amplitudes): the old loose cadence still reads better
      // than a head that never moves while talking.
      this.nextNodAt = now + 1800 + Math.random() * 2600;
      this.nodPhase = 0;
      this.nodMs = AMBIENT_NOD_MS;
      this.nodStrength = 1;
    }
    if (this.nodPhase < 1) this.nodPhase = Math.min(1, this.nodPhase + dt / this.nodMs);

    this.body.update(dt, now);
    this.headDrive.update(dt, now, this.speaking);
    if (this.headDrive.movedAt === now && this.headDrive.moveSize > 0.35) this.blinks.onHeadTurn(now);

    // Saccades: eyes jump to a new fixation, then hold. While speaking the
    // gaze returns near-center more often (engaged with the listener);
    // idle gaze wanders further and rests longer.
    if (now >= this.nextSaccadeAt) {
      const speaking = this.speaking;
      this.nextSaccadeAt = now + (speaking ? 900 : 1400) + Math.random() * (speaking ? 1600 : 2600);
      // Most fixations return to the viewer; only some wander. A face that
      // is usually looking somewhere else reads as distracted, not alive.
      // Wanders split into sideways glances and the occasional glance DOWN —
      // the recollecting-your-thoughts look — which never happens with a
      // symmetric draw because y is halved and rarely lands low.
      const spread = speaking ? 0.2 : 0.3;
      const roll = Math.random();
      if (roll < (speaking ? 0.5 : 0.35)) {
        this.gazeTarget = { x: 0, y: 0 };
      } else if (roll < (speaking ? 0.68 : 0.55)) {
        this.gazeTarget = { x: (Math.random() * 2 - 1) * spread * 0.6, y: spread * (1.0 + Math.random() * 0.5) };
      } else {
        this.gazeTarget = { x: (Math.random() * 2 - 1) * spread, y: (Math.random() * 2 - 1) * spread * 0.5 };
      }
      // A big jump of the eyes carries a blink with it.
      this.blinks.onSaccade(now, Math.hypot(this.gazeTarget.x - this.gaze.x, this.gazeTarget.y - this.gaze.y));
    }
    // Saccades are ballistic: fast jump, then a still fixation.
    // A saccade is ballistic and fast — ~35ms to cross, whatever the frame rate.
    const saccadeRate = 1 - Math.exp(-dt / SACCADE_MS);
    this.gaze.x += (this.gazeTarget.x - this.gaze.x) * saccadeRate;
    this.gaze.y += (this.gazeTarget.y - this.gaze.y) * saccadeRate;

    // Brow pulses: idle micro-expressions + emphasis while speaking.
  }

  // --- Deformation -----------------------------------------------------------

  private deformedPoints(_now: number): Point[] {
    const pts = this.basePoints.map((p) => ({ x: p.x, y: p.y }));
    const w = this.weights;

    // Mouth geometry in canvas space.
    const mouthIdx = this.rig.mouth_indices;
    let mcx = 0;
    let mcy = 0;
    let mMinX = Infinity, mMaxX = -Infinity, mMinY = Infinity, mMaxY = -Infinity;
    for (const i of mouthIdx) {
      mcx += pts[i].x;
      mcy += pts[i].y;
      mMinX = Math.min(mMinX, pts[i].x);
      mMaxX = Math.max(mMaxX, pts[i].x);
      mMinY = Math.min(mMinY, pts[i].y);
      mMaxY = Math.max(mMaxY, pts[i].y);
    }
    mcx /= mouthIdx.length;
    mcy /= mouthIdx.length;
    const mw = Math.max(mMaxX - mMinX, 1);
    const mh = Math.max(mMaxY - mMinY, 1);
    const innerSet = new Set(this.innerRing);

    // Blendshape-driven deformation as a CONTINUOUS FIELD over every
    // vertex, not a binary mouth/not-mouth split. The split moved lip
    // landmarks far while their neighbours stayed put, which tore the
    // texture into visible stair-steps below the lip.
    const reach = mw * 1.15; // how far mouth motion bleeds into the face
    // Rounded shapes open a narrower lens: at full pucker the drop reaches
    // ~75% of the way to the corners. Narrower (0.65 was tried) turns a
    // wide flat lip — every cartoon — into a pointed teardrop on "oh".
    const lensWidth = 1.05 - 0.3 * Math.min(1, w.mouthPucker + w.mouthFunnel * 0.6);
    // A character profile moves the mouth with its own field instead.
    const classic = !this.field;
    for (let i = 0; classic && i < pts.length; i++) {
      // The eyes, brows, nose and forehead are no part of a mouth: the
      // field's reach used to lift the nose tip a little on every open vowel.
      if (UPPER_FACE.has(i)) continue;
      const px = pts[i].x - mcx;
      const py = pts[i].y - mcy;
      const dist = Math.hypot(px, py * 1.35); // squashed: motion spreads wider than tall
      if (dist > reach) continue;
      // Smoothstep falloff: 1 at the lips, easing to 0 at `reach`.
      const t = 1 - dist / reach;
      const falloff = t * t * (3 - 2 * t);
      const nx = px / (mw / 2);
      const ny = py / (mh / 2);
      let dx = 0;
      let dy = 0;
      // jawOpen: the jaw is a HINGE. Everything below the lip seam drops as
      // one unit — the lower lip keeps its thickness and travels with the
      // chin. The previous field scaled the drop with distance below the
      // mouth centre, which is a gradient, not a hinge: the lower lip's top
      // edge moved a little and its bottom edge a lot, so on every open
      // vowel the lip stretched to twice its height while the painted
      // opening stayed a thin lens. Measured on a photograph at jawOpen
      // 0.85: lip band 2.1x its resting height. A short ramp just below the
      // seam takes the drop from 0 to full, so the seam itself parts
      // cleanly instead of tearing.
      // Assigned by IDENTITY, not by height: with the mouth closed the upper
      // and lower inner-lip landmarks sit at the same y (measured: 0.05 vs
      // 0.08 half-heights), so any ramp on y drags the upper lip down with
      // the lower and the two never separate. Lower-lip landmarks drop as a
      // unit (tapering into the anchored corners); upper-lip landmarks
      // stay; skin takes a ramp by height.
      const hinge = hingeShare(i, nx, ny, lensWidth);
      dy += w.jawOpen * mh * JAW_DROP * hinge * falloff;
      if (ny < 0) dy -= w.jawOpen * mh * 0.08 * -ny * falloff;
      // pucker/funnel: narrow horizontally, round the aperture.
      dx -= (w.mouthPucker * 0.32 + w.mouthFunnel * 0.18) * nx * (mw / 2) * falloff;
      dy += (ny < 0 ? -w.mouthFunnel * 0.14 : w.mouthFunnel * 0.1) * mh * falloff;
      // stretch/smile: widen, corners up and out.
      dx += (w.mouthStretch * 0.26 + w.mouthSmile * 0.16) * nx * (mw / 2) * falloff;
      if (Math.abs(nx) > 0.55) {
        dy -= w.mouthSmile * mh * 0.3 * (Math.abs(nx) - 0.55) * falloff;
      }
      if (innerSet.has(i)) {
        // NOTE: no extra "part the inner ring" term here. It fired only on
        // landmarks below the mouth centroid, so it opened some of the ring
        // and not the rest — the seam came out as a zigzag. The aperture is
        // synthesised in drawMouthInterior instead, which needs this ring
        // to stay a clean curve.
        dy += (mcy - pts[i].y) * w.mouthClose * 0.8;
      }
      pts[i].x += dx * this.tuning.mouthOpen;
      pts[i].y += dy * this.tuning.mouthOpen;
    }

    if (this.field) this.field.apply(pts, w, this.tuning.mouthOpen, this.traits);

    // (The jaw, the chin and the cheeks come after every driver, below:
    // applyLowerFace. The outward cheek push that lived here pushed the
    // cheeks the wrong way — an opening jaw narrows the face.)

    // Face half-height, for expression amplitudes.
    const ys = pts.map((p) => p.y);
    const fh = (Math.max(...ys) - Math.min(...ys)) / 2;

    // Eased blinks: the upper lid sweeps DOWN to the lower lid (lid skin
    // stretches over the eyeball); the lower lid rises only slightly.
    // Corner points stay pinned, mid-lid points travel furthest.
    // Lids also follow a downward gaze a little (LID_FOLLOW), so the
    // deformation runs whenever either is non-zero.
    const lidFollow = Math.max(0, Math.min(0.5, this.gaze.y)) * LID_FOLLOW;
    if ((this.blink > 0 || lidFollow > 0) && this.profile.blink === "mesh") {
      // Asymmetric ease: lids snap shut faster than they reopen — blink.ts.
      const amount = Math.min(1, blinkEase(this.blink) + lidFollow);
      for (let e = 0; e < 2; e++) {
        const [c0, c1] = EYE_CORNERS[e];
        const ecx = (pts[c0].x + pts[c1].x) / 2;
        const halfW = Math.max(Math.abs(pts[c1].x - pts[c0].x) / 2, 1);
        let eyeBottom = -Infinity;
        let eyeTop = Infinity;
        for (const i of LOWER_LIDS[e]) eyeBottom = Math.max(eyeBottom, pts[i].y);
        for (const i of UPPER_LIDS[e]) eyeTop = Math.min(eyeTop, pts[i].y);
        for (const i of UPPER_LIDS[e]) {
          const centrality = Math.max(0, 1 - ((pts[i].x - ecx) / halfW) ** 2);
          // A PARTIAL sweep, and that limit is the whole design. Driving
          // these vertices all the way to the lower lid compresses the
          // eyeball texture into a band and stretches brow skin across it —
          // a translucent smear with the iris showing through. Stopping
          // short keeps the motion inside the range where the mesh still
          // looks like an eye narrowing.
          pts[i].y +=
            (eyeBottom - pts[i].y) *
            amount *
            LID_VERTEX_SWEEP *
            this.tuning.blink *
            (0.15 + 0.85 * centrality);
        }
        for (const i of LOWER_LIDS[e]) {
          const centrality = Math.max(0, 1 - ((pts[i].x - ecx) / halfW) ** 2);
          pts[i].y -= (pts[i].y - eyeTop) * amount * 0.12 * centrality;
        }
      }
    }

    // NOTE: gaze is NOT applied to iris vertices — the iris and the sclera
    // around it share one triangulated mesh, so moving those vertices drags
    // the whole socket and reads as wall-eyed smearing. The iris is drawn
    // as a separate layer instead (drawEyes), which is how it actually
    // slides across the eye.

    // Smiling raises the lower lid (a real smile reaches the eyes).
    if (w.mouthSmile > 0.05) {
      for (let e = 0; e < 2; e++) {
        const lift = w.mouthSmile * 0.12;
        const top = Math.min(...UPPER_LIDS[e].map((i) => pts[i].y));
        for (const i of LOWER_LIDS[e]) pts[i].y -= (pts[i].y - top) * lift;
      }
    }

    // Brow layer: lift rows inner->outer on eased sin pulses + rest browInnerUp.
    // No brow pulse. It ran on its own random timer, independent of the
    // blink's, so the two coincided often enough to read as a tic — brows up,
    // then a blink. An involuntary motion that draws attention to itself is
    // worse than none.
    const browPulse = 0;
    const browLift = browPulse * (this.speaking ? 0.45 + this.energy * 0.3 : 0.4);
    for (const brow of [LEFT_BROW, RIGHT_BROW]) {
      for (let j = 0; j < brow.length; j++) {
        const innerness = 1 - j / (brow.length - 1); // inner moves most
        const rest = 0.06 * innerness; // resting browInnerUp
        pts[brow[j]].y -= fh * 0.035 * (browLift * (0.4 + 0.6 * innerness) + rest);
      }
    }

    // Head pose is applied at render time as a rigid layer transform —
    // see buildHeadLayer. Warping vertices for it is how the face ended up
    // sliding around inside a stationary head.

    this.mouthExtension?.deform?.(pts, this.basePoints, this.rig, w);

    // The lower face, for every driver: the chin and the jaw line hinge
    // with the lower lip wherever the driver left them behind (the classic
    // field always did; a photographed pose whose chin lags its lip), and
    // the cheeks follow the jaw and the lip shapes. After the driver, so it
    // reads what the lip actually did, jaw range and all.
    if (this.lowerFace) applyLowerFace(pts, this.basePoints, this.lowerFace, w, this.tuning.mouthOpen);

    // Derived midpoint vertices (mouth subdivision) follow their parents
    // through EVERY layer above — computed last, from final positions.
    for (const [a, b] of this.derivedParents) {
      pts.push({ x: (pts[a].x + pts[b].x) / 2, y: (pts[a].y + pts[b].y) / 2 });
    }
    // The neck band follows the jaw line by each vertex's share.
    for (const v of this.neckBand) {
      const p = pts[v.parent], b = this.basePoints[v.parent];
      pts.push({ x: v.base.x + (p.x - b.x) * v.share, y: v.base.y + (p.y - b.y) * v.share });
    }

    return pts;
  }

  // --- Rendering ---------------------------------------------------------------

  private render(): void {
    const now = performance.now();
    const ctx = this.ctx;
    const pts = this.deformedPoints(now);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    // The scene's background first, under everything and still.
    this.drawSceneBackground();

    if (this.layers) {
      this.renderLayered(pts);
      return;
    }

    // Body motion is applied to the finished picture, not to the mesh.
    //
    // That is the whole point: a rigid transform cannot distort a face. The
    // earlier attempt to move the head warped vertices to fake a rotation,
    // which deformed the features instead of turning them. Sway and breathing
    // are things a camera sees a whole subject do, so moving the whole
    // drawing is not an approximation — it is exactly right.
    ctx.save();
    this.applyBodyTransform(ctx);

    // --- Head motion ------------------------------------------------------
    //
    // The whole head — hair included — moves as one rigid unit, which is
    // what makes a shift read as a turn. HOW depends on what is behind it.
    // A cut-out has nothing behind its head but transparency: the head is
    // cut out as its own feathered layer, erased from the base and drawn
    // moved, and its edges are the hair's own. A picture with an opaque
    // background has no such edge: a moved copy of the head over the still
    // picture leaves a seam wherever the copy's rectangle meets what it
    // covers, and at the picture's boundary (a scan on white, a portrait
    // on grey) the rotated copy pokes past the edge as a torn, jagged rim.
    // So an opaque picture moves AS ONE, picture and mesh together: there
    // is no second copy, and nothing to seam.
    const head = this.headOffsets();
    const geom = this.headGeom;
    const asOne = !this.cutOut;
    if (asOne && geom) {
      ctx.translate(geom.pivotX + head.dx, geom.pivotY + head.dy);
      ctx.rotate(head.roll);
      ctx.translate(-geom.pivotX, -geom.pivotY);
    }

    // Base layer: the whole un-warped photo, through the viewport. Triangle
    // seams and sub-pixel gaps in the warp then reveal original pixels
    // instead of holes, and the hair, shoulders and background are simply
    // there, as far as the canvas reaches.
    this.drawFullFrame(this.texture);

    const layered = !asOne && geom && this.headLayer;
    if (layered) {
      // The head erased from the base first, so the moved layer does not
      // leave a ghost of itself behind.
      ctx.globalCompositeOperation = "destination-out";
      ctx.drawImage(this.headLayer!, geom.x, geom.y);
      ctx.globalCompositeOperation = "source-over";
    }
    ctx.save();
    if (layered) {
      ctx.translate(geom.pivotX + head.dx, geom.pivotY + head.dy);
      ctx.rotate(head.roll);
      ctx.translate(-geom.pivotX, -geom.pivotY);
      // ADDED back, not laid over: the punch-out left base * (1 - a) where
      // the layer's feathered alpha is a, and the layer brings hair * a.
      // Source-over would attenuate the remainder a second time, by
      // (1 - a) again, and the feather band came out a quarter transparent
      // at rest: a faint rectangle around every cut-out's head, over
      // whatever the page showed behind it. Summed, the two are the base
      // again exactly where nothing moved, and the moved copy elsewhere.
      ctx.globalCompositeOperation = "lighter";
      ctx.drawImage(this.headLayer!, geom.x, geom.y);
      ctx.globalCompositeOperation = "source-over";
      ctx.translate(head.fdx, head.fdy);
    }

    const pads = this.trianglePads();
    let t = 0;
    for (const [a, b, c] of this.triangles) {
      this.drawWarpedTriangle(pts, a, b, c, pads ? pads[t++] : 0);
    }

    this.drawEyes(pts);
    this.drawLids(pts);
    this.drawLashes(pts);
    this.drawMouthSurface(pts);

    if (this.debugMesh) this.drawDebugMesh(pts);
    ctx.restore();
    ctx.restore();
  }

  /** Draw a whole full-frame image (the photo, or a layer aligned to it)
   *  through the viewport. */
  private drawFullFrame(img: HTMLImageElement): void {
    const pic = this.picture;
    this.ctx.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight, pic.x, pic.y, pic.w, pic.h);
  }

  /**
   * The layered picture: still background, swaying body, moving head.
   *
   * Every layer is real pixels — the body's collar exists under the head,
   * the wall exists behind the hair — so no motion can reveal a hole, and
   * none of the single-photo path's compensations (punch-out, feathered
   * cutout, reduced travel over an attached background) apply. Body sway
   * runs at full strength because the background genuinely stays still,
   * which is exactly what a camera watching a standing person sees.
   */
  private renderLayered(pts: Point[]): void {
    const ctx = this.ctx;
    const L = this.layers!;

    if (L.background) this.drawFullFrame(L.background);

    ctx.save();
    this.applyBodyTransform(ctx, true);
    this.drawFullFrame(L.body);

    const head = this.headOffsets();
    const geom = this.headGeom;
    ctx.save();
    if (geom) {
      ctx.translate(geom.pivotX + head.dx, geom.pivotY + head.dy);
      ctx.rotate(head.roll);
      ctx.translate(-geom.pivotX, -geom.pivotY);
    }
    this.drawFullFrame(L.head);

    const pads = this.trianglePads();
    let t = 0;
    for (const [a, b, c] of this.triangles) {
      this.drawWarpedTriangle(pts, a, b, c, pads ? pads[t++] : 0);
    }
    this.drawEyes(pts);
    this.drawLids(pts);
    this.drawLashes(pts);
    this.drawMouthSurface(pts);
    if (this.debugMesh) this.drawDebugMesh(pts);
    ctx.restore();
    ctx.restore();
  }

  private drawMouthSurface(pts: Point[]): void {
    let painted = false;
    if (this.mouthExtension?.paint) {
      this.ctx.save();
      try {
        painted = this.mouthExtension.paint(this.ctx, {
          points: pts, neutral: this.basePoints, rig: this.rig, weights: this.weights,
          lipColour: this.lipColour,
          skinColour: this.skinColour ?? undefined,
          faceHighlight: this.faceHighlight ?? undefined,
          soft: this.look.soft,
          sharpness: this.faceSharpness ?? undefined,
          pixelScale: this.pixelScale(),
          viseme: this.pose?.()?.viseme ?? this.currentViseme(performance.now()),
        });
      } finally { this.ctx.restore(); }
    }
    if (!painted) {
      if (this.field && !this.mouthExtension) {
        this.drawCharacterMouth(pts);
        return;
      }
      if (this.profile.contactLine) this.drawLipContactLine(pts);
      this.drawMouthInterior(pts);
    }
  }

  /** The character mouth's opening, read off the moved lips, and painted. */
  private drawCharacterMouth(pts: Point[]): void {
    const opening = characterOpening(pts, this.basePoints);
    if (!opening) return;
    paintCharacter(this.ctx, {
      opening,
      clip: openingPath(opening, () => new Path2D()),
      weights: this.weights,
      look: this.look,
      traits: this.traits,
      tongueRaise: this.tongue,
      cavityShade: this.profile.cavityShade,
    });
  }

  /**
   * Tip the whole picture about a pivot below the frame, and lift it to breathe.
   *
   * Scaled right down when the photo still carries its own background: moving
   * the entire image then looks like a shaky camera rather than a person
   * shifting their weight, and it walks the photo's own edge into view. A
   * cut-out has no edge to expose, so it gets the full amount.
   */
  private applyBodyTransform(ctx: CanvasRenderingContext2D, layered = false): void {
    const scale =
      (layered || this.cutOut ? 1 : OPAQUE_BACKGROUND_SCALE) * this.tuning.bodyMotion;
    if (scale <= 0) return;
    const angle = this.body.sway * this.swayAngle * scale;
    const rise = this.body.breath * this.breathRise * scale;
    ctx.translate(this.bodyPivot.x, this.bodyPivot.y);
    ctx.rotate(angle);
    ctx.translate(-this.bodyPivot.x, -this.bodyPivot.y - rise);
  }

  private padsFor: unknown = null;
  private pads: Float32Array | null = null;

  /**
   * Each triangle's overlap with its neighbours, px. Worked out once per
   * mesh. A pixel everywhere for a character profile and for any flat
   * picture, whose drawn lines thread through every seam; for a photograph,
   * a pixel wherever the lower-face rig can move the mesh over the still
   * picture (the jaw, the chin, the cheeks, the neck band: the lit neck
   * showed through the seams of the dropped chin as a faint lattice), and
   * none about the eyes and forehead, which draw exactly as they always
   * did. Half a pixel where the lips' own drawn line crosses the mesh.
   */
  private trianglePads(): Float32Array | null {
    if (this.padsFor !== this.triangles || !this.pads) {
      this.padsFor = this.triangles;
      const everywhere = !!this.field || this.look.flat;
      const rig = this.lowerFace;
      const moves = (i: number) =>
        i >= 478 || (!!rig && (rig.jaw[i] > 0 || rig.weight[i] > 0 || rig.cheek[i] > 0));
      this.pads = Float32Array.from(this.triangles, ([a, b, c]) =>
        this.touchesMouth(a, b, c) ? 0.45 : everywhere || moves(a) || moves(b) || moves(c) ? 1 : 0
      );
    }
    return this.pads;
  }

  private mouthSet: Set<number> | null = null;

  /** Does a triangle touch the lips (the rig's mouth points, or a vertex the
   *  mouth subdivision added)? */
  private touchesMouth(a: number, b: number, c: number): boolean {
    if (!this.mouthSet) this.mouthSet = new Set(this.rig.mouth_indices ?? []);
    const set = this.mouthSet;
    const mouthy = (i: number): boolean => {
      if (i < 478) return set.has(i);
      const parents = this.derivedParents[i - 478];
      return !!parents && (set.has(parents[0]) || set.has(parents[1]));
    };
    return mouthy(a) || mouthy(b) || mouthy(c);
  }

  /**
   * Draw one texture triangle warped to its deformed destination.
   * Affine solved with Cramer's rule; degenerate triangles are skipped.
   */
  private drawWarpedTriangle(pts: Point[], i0: number, i1: number, i2: number, pad = 0): void {
    const ctx = this.ctx;
    const s0 = this.texPoints[i0], s1 = this.texPoints[i1], s2 = this.texPoints[i2];
    const d0 = pts[i0], d1 = pts[i1], d2 = pts[i2];

    const det =
      s0.x * (s1.y - s2.y) + s1.x * (s2.y - s0.y) + s2.x * (s0.y - s1.y);
    if (Math.abs(det) < 1e-6) return;

    const a =
      (d0.x * (s1.y - s2.y) + d1.x * (s2.y - s0.y) + d2.x * (s0.y - s1.y)) / det;
    const c =
      (d0.x * (s2.x - s1.x) + d1.x * (s0.x - s2.x) + d2.x * (s1.x - s0.x)) / det;
    const e =
      (d0.x * (s1.x * s2.y - s2.x * s1.y) +
        d1.x * (s2.x * s0.y - s0.x * s2.y) +
        d2.x * (s0.x * s1.y - s1.x * s0.y)) /
      det;
    const b =
      (d0.y * (s1.y - s2.y) + d1.y * (s2.y - s0.y) + d2.y * (s0.y - s1.y)) / det;
    const d =
      (d0.y * (s2.x - s1.x) + d1.y * (s0.x - s2.x) + d2.y * (s1.x - s0.x)) / det;
    const f =
      (d0.y * (s1.x * s2.y - s2.x * s1.y) +
        d1.y * (s2.x * s0.y - s0.x * s2.y) +
        d2.y * (s0.x * s1.y - s1.x * s0.y)) /
      det;

    ctx.save();
    ctx.beginPath();
    // Inflate the clip triangle to hide the seams between triangles: a
    // little in proportion on every triangle, plus `pad` px of edge offset
    // where the mesh moves over the still picture (seam-pad.ts). Less where
    // a thin drawn line crosses the triangles, as the lips do: a wide
    // overlap would redraw a pixel of it from the wrong triangle.
    const [g0, g1, g2] = padTriangle(d0, d1, d2, pad);
    ctx.moveTo(g0.x, g0.y);
    ctx.lineTo(g1.x, g1.y);
    ctx.lineTo(g2.x, g2.y);
    ctx.closePath();
    ctx.clip();
    ctx.transform(a, b, c, d, e, f);
    ctx.drawImage(this.texture, 0, 0);
    ctx.restore();
  }

  /**
   * A lash line riding the closing lid.
   *
   * The mesh alone moves the photographed lashes down with the lid, but as
   * the eye compresses they thin out and lose definition just when the eye
   * most needs an edge. This lays this face's OWN lash colour along the lid's
   * leading edge — sampled, never assumed black, because a fair or stylized
   * face can have brown, auburn or near-white lashes and a black line on
   * those looks pasted on.
   */
  private drawLashes(pts: Point[]): void {
    if (this.blink <= 0 || this.profile.blink === "lid") return;
    const phase = this.blink;
    const amount =
      phase < 0.4
        ? Math.sin((phase / 0.4) * (Math.PI / 2))
        : Math.cos(((phase - 0.4) / 0.6) * (Math.PI / 2));
    if (amount <= 0.02) return;
    const ctx = this.ctx;
    for (let e = 0; e < 2; e++) {
      const lid = UPPER_LIDS[e]
        .map((i) => pts[i])
        .filter(Boolean)
        .slice()
        .sort((a, b) => a.x - b.x);
      if (lid.length < 3) continue;
      const width = Math.max(...lid.map((p) => p.x)) - Math.min(...lid.map((p) => p.x));
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(lid[0].x, lid[0].y);
      // Through the lid points as a smooth curve, so the line is an arc
      // rather than a chain of segments.
      for (let i = 1; i < lid.length - 1; i++) {
        const mx = (lid[i].x + lid[i + 1].x) / 2;
        const my = (lid[i].y + lid[i + 1].y) / 2;
        ctx.quadraticCurveTo(lid[i].x, lid[i].y, mx, my);
      }
      ctx.lineTo(lid[lid.length - 1].x, lid[lid.length - 1].y);
      ctx.strokeStyle = this.lashColour[e];
      ctx.globalAlpha = amount * 0.85;
      ctx.lineWidth = Math.max(1, width * 0.022);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.stroke();
      ctx.restore();
    }
  }

  /**
   * Gaze, by sliding the photograph's own eye inside the lids.
   *
   * The predecessor of this method re-stamped an extracted iris disc, and
   * every version broke on some real avatar: a 10-texture-px iris upscaled
   * into a flat grey disc, and painted eyes got their catchlight stamped
   * twice. The rule that survives arbitrary uploads is: never invent eye
   * pixels.
   *
   * So nothing is synthesised here. The texture region around the iris —
   * iris, catchlight, surrounding sclera, whatever the artist drew — is
   * redrawn as one piece, offset by the gaze, clipped to the intersection
   * of TWO detectors: the eye opening built from the deformed lid points,
   * and a circle around MediaPipe's iris ring. The circle is what makes
   * this survive painted eyes: the clip-vs-original seam lands in sclera
   * (white meeting white) instead of on the eyeliner and lashes, where the
   * lid-polygon-only version doubled the lash line. One copy, so there is
   * exactly one iris and one catchlight; the lid clip follows blinks; the
   * shift is capped well inside the circle so the iris never crosses it.
   */
  private drawEyes(pts: Point[]): void {
    const gx = Math.max(-0.6, Math.min(0.6, this.gaze.x));
    const gy = Math.max(-0.5, Math.min(0.5, this.gaze.y));
    if (Math.abs(gx) < 0.02 && Math.abs(gy) < 0.02) return;

    // Shift scale is capped against the interocular distance, not just the
    // eye's own width: stylised faces (anime) have eyes near half the face
    // wide, and an eye-width-proportional shift slides those giant irises
    // several px — enough to tear against the lashes at the clip boundary.
    const eL0 = pts[EYE_CORNERS[0][0]], eL1 = pts[EYE_CORNERS[0][1]];
    const eR0 = pts[EYE_CORNERS[1][0]], eR1 = pts[EYE_CORNERS[1][1]];
    const interOc =
      eL0 && eL1 && eR0 && eR1
        ? Math.hypot(
            (eR0.x + eR1.x - eL0.x - eL1.x) / 2,
            (eR0.y + eR1.y - eL0.y - eL1.y) / 2
          )
        : 0;

    const ctx = this.ctx;
    for (let e = 0; e < 2; e++) {
      const [c0, c1] = EYE_CORNERS[e];
      const a = pts[c0], b = pts[c1];
      const ta = this.texPoints[c0], tb = this.texPoints[c1];
      if (!a || !b || !ta || !tb) continue;
      const eyeW = Math.hypot(b.x - a.x, b.y - a.y);
      if (eyeW < 3) continue;

      // The pupil detector: iris center and radius from the ring points.
      const [ic, ring] = IRISES[e];
      const c = pts[ic], tc = this.texPoints[ic];
      if (!c || !tc) continue;
      let r = 0;
      for (const i of ring) {
        const q = pts[i];
        if (!q) { r = 0; break; }
        r += Math.hypot(q.x - c.x, q.y - c.y);
      }
      r /= 4;
      if (r < 2) continue;

      // The opening: corner, upper lid, corner, lower lid back. Built from
      // the DEFORMED points, so a blink shrinks the clip and mid-blink the
      // patch only paints below the descended lid.
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      for (const i of UPPER_LIDS[e]) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.lineTo(b.x, b.y);
      for (let j = LOWER_LIDS[e].length - 1; j >= 0; j--) {
        const q = pts[LOWER_LIDS[e][j]];
        ctx.lineTo(q.x, q.y);
      }
      ctx.closePath();
      ctx.clip();
      // ∩ the iris circle, generous enough to hold the shifted iris plus a
      // sclera margin where the seam can hide.
      const R = r * 1.5;
      ctx.beginPath();
      ctx.arc(c.x, c.y, R, 0, Math.PI * 2);
      ctx.clip();

      // Shift, capped twice: within the circle (so the iris rim never
      // reaches the clip edge) and against the interocular distance (so a
      // giant stylised iris still moves a believable few pixels).
      const capX = Math.min(r * 0.35, interOc * 0.05);
      const capY = Math.min(r * 0.25, interOc * 0.035);
      const sx = gx * capX, sy = gy * capY;

      // Source box around the iris in texture space, mapped through the
      // same texture<->canvas ratio the triangles use so content lands 1:1.
      const eyeWt = Math.hypot(tb.x - ta.x, tb.y - ta.y);
      const k = eyeWt / eyeW; // texture px per canvas px
      const m = R + 3;
      ctx.drawImage(
        this.texture,
        tc.x - m * k, tc.y - m * k, 2 * m * k, 2 * m * k,
        c.x - m + sx, c.y - m + sy, 2 * m, 2 * m
      );
      ctx.restore();
    }
  }

  /**
   * A soft dark line where the lips meet. Strongest when the mouth is
   * closed (the interior isn't drawn then), fading out as it opens — gives
   * the lips definition that the raw warp lacks.
   */
  private drawLipContactLine(pts: Point[]): void {
    if (this.innerRing.length < 6) return;
    const openness = Math.min(1, this.weights.jawOpen * 1.3 + this.weights.mouthFunnel * 0.25);
    const alpha = 0.28 * Math.max(0, 1 - openness / 0.25);
    if (alpha < 0.02) return;

    const ring = this.innerRing.map((i) => pts[i]);
    const cy = ring.reduce((s, p) => s + p.y, 0) / ring.length;
    // Corner-to-corner midline through the ring, flattened to the lip seam.
    const sorted = [...ring].sort((p, q) => p.x - q.x);
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = `rgba(70, 30, 28, ${alpha})`;
    ctx.lineWidth = Math.max(1, (sorted[sorted.length - 1].x - sorted[0].x) * 0.018);
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(sorted[0].x, cy + (sorted[0].y - cy) * 0.1);
    for (let i = 1; i < sorted.length; i++) {
      ctx.lineTo(sorted[i].x, cy + (sorted[i].y - cy) * 0.1);
    }
    ctx.stroke();
    ctx.restore();
  }

  /**
   * Mouth interior v2: angle-sorted inner-lip clip, smooth quadratic lip
   * path, fixed-size teeth hanging from the lips (the dark gap grows with
   * jawOpen, not the teeth), gum line, tongue with center groove, and an
   * inner-lip contact shadow.
   */
  /**
   * Mouth interior, built from the REAL lip curve.
   *
   * Earlier versions drew an invented symmetric lens spanning the full
   * corner-to-corner width, which put sharp dark spikes at the commissures
   * — lips do not separate at the corners. Instead:
   *   1. find the two commissures (the furthest-apart pair on the ring),
   *   2. project every lip landmark onto the corner-to-corner axis to get
   *      its position t and its perpendicular offset d (d IS the measured
   *      lip shape from the photo),
   *   3. scale d by a taper window that is zero at both corners and full
   *      mid-mouth, so the opening physically cannot part at the corners,
   *   4. draw a smooth Catmull-Rom curve through the result.
   */
  /**
   * Mouth interior, built on the measured lip seam.
   *
   * The seam (midline between opposing inner-lip landmarks) carries the
   * real position, curvature and tilt of this mouth. The opening is
   * synthesised on top of it — necessary because in a closed-lip portrait
   * the inner-lip landmarks are coincident, so there is no aperture to
   * scale. Everything is sampled along ONE parameter so x and y always
   * come from the same place on the curve; mixing parameters sheared the
   * aperture into a triangle.
   */
  private drawMouthInterior(pts: Point[]): void {
    if (this.innerRing.length < 8) return;
    const ctx = this.ctx;
    const ring = this.innerRing.map((i) => pts[i]);
    const n = ring.length;
    const half = Math.floor(n / 2);

    // Commissures: furthest-apart pair on the ring.
    let ia = 0;
    let ib = 1;
    let best = -1;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const d2 = (ring[i].x - ring[j].x) ** 2 + (ring[i].y - ring[j].y) ** 2;
        if (d2 > best) {
          best = d2;
          ia = i;
          ib = j;
        }
      }
    }
    const left = ring[ia].x <= ring[ib].x ? ring[ia] : ring[ib];
    const right = ring[ia].x <= ring[ib].x ? ring[ib] : ring[ia];
    const ax = right.x - left.x;
    const ay = right.y - left.y;
    const axisLen = Math.hypot(ax, ay);
    if (axisLen < 4) return;
    const axisLen2 = axisLen * axisLen;
    // Stable opening direction: perpendicular to the corner-to-corner axis,
    // pointing down the screen.
    let axisNormX = -ay / axisLen;
    let axisNormY = ax / axisLen;
    if (axisNormY < 0) {
      axisNormX = -axisNormX;
      axisNormY = -axisNormY;
    }

    const w = this.weights;
    const rounding = Math.min(1, w.mouthPucker + w.mouthFunnel * 0.6);
    const openFrac =
      w.jawOpen * 0.23 + w.mouthFunnel * 0.07 + w.mouthStretch * 0.03 - w.mouthClose * 0.05;
    // Lip RETRACTION, which is a different thing from jaw opening. /f/ /v/
    // /s/ /z/ /sh/ barely drop the jaw — measured, /f/'s openFrac is exactly
    // 0.010 against a 0.012 bail, so the whole interior returned early and
    // those sounds rendered as a flat closed line. What they actually show is
    // a bright tooth edge behind pulled-back lips.
    //
    // Rounding suppression is SQUARED: linear let /ou/ (a pucker, which shows
    // nothing) leak through. The stretch deadband stops silence, which has a
    // little residual stretch, from growing teeth.
    const retract =
      Math.min(1, w.mouthStretch * 1.5 + w.mouthSmile * 0.6) *
      (1 - rounding) ** 2 *
      Math.min(1, Math.max(0, (w.mouthStretch - 0.14) / 0.16));
    // The labiodental tuck, /f/ and /v/, is the OTHER way teeth become
    // visible, and it is not retraction — the lower lip rides UP against the
    // upper incisors. For that shape mouthClose is the cause of the teeth
    // showing, not a reason to hide them, which is why gating teeth on
    // `1 - mouthClose` left /f/ at 0.058 alpha, i.e. invisible.
    //
    // mouthStretch is what separates it from a bilabial: /f/ carries ~0.25,
    // /p/ /b/ /m/ carry none, so a closed mouth stays closed.
    const tuck = w.mouthClose * Math.min(1, w.mouthStretch / 0.2) * (1 - rounding);
    const teethDrive = Math.max(retract, tuck);
    // A geometry floor, deliberately well below the cavity's 0.03 knee: /f/
    // gets an arch to hang teeth from, not a black hole.
    const synthHeight =
      Math.max(Math.max(0, openFrac), teethDrive * 0.018) * axisLen * this.tuning.mouthOpen;

    // --- Seam: midline between opposing landmarks, parameterised by t. ---
    const seam: { x: number; y: number; t: number }[] = [{ x: left.x, y: left.y, t: 0 }];
    for (let k = 1; k < half; k++) {
      const lo = ring[k];
      const up = ring[n - k];
      const sx = (lo.x + up.x) / 2;
      const sy = (lo.y + up.y) / 2;
      const t = Math.max(
        0,
        Math.min(1, ((sx - left.x) * ax + (sy - left.y) * ay) / axisLen2)
      );
      seam.push({ x: sx, y: sy, t });
    }
    seam.push({ x: right.x, y: right.y, t: 1 });
    seam.sort((p, q) => p.t - q.t);

    // Least-squares quadratic fit of the seam. Interpolating the raw
    // midpoints put a 16px step at the mouth centre — the central lip
    // landmarks take the strongest jaw displacement, so the midline
    // kinked and the aperture sheared into a hook. A real lip line is a
    // smooth curve, so fit one.
    const fitQuadratic = (values: number[], ts: number[]) => {
      let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0;
      let b0 = 0, b1 = 0, b2 = 0;
      for (let i = 0; i < ts.length; i++) {
        const t = ts[i];
        const t2 = t * t;
        s0 += 1;
        s1 += t;
        s2 += t2;
        s3 += t2 * t;
        s4 += t2 * t2;
        b0 += values[i];
        b1 += values[i] * t;
        b2 += values[i] * t2;
      }
      // Solve the 3x3 normal equations by Cramer's rule.
      const det =
        s0 * (s2 * s4 - s3 * s3) - s1 * (s1 * s4 - s3 * s2) + s2 * (s1 * s3 - s2 * s2);
      if (Math.abs(det) < 1e-9) return [values[0] ?? 0, 0, 0];
      const c0 =
        (b0 * (s2 * s4 - s3 * s3) - s1 * (b1 * s4 - b2 * s3) + s2 * (b1 * s3 - b2 * s2)) / det;
      const c1 =
        (s0 * (b1 * s4 - b2 * s3) - b0 * (s1 * s4 - s3 * s2) + s2 * (s1 * b2 - s2 * b1)) / det;
      const c2 =
        (s0 * (s2 * b2 - s3 * b1) - s1 * (s1 * b2 - s2 * b1) + b0 * (s1 * s3 - s2 * s2)) / det;
      return [c0, c1, c2];
    };
    const seamTs = seam.map((q) => q.t);
    const fx = fitQuadratic(seam.map((q) => q.x), seamTs);
    const fy = fitQuadratic(seam.map((q) => q.y), seamTs);
    const seamAt = (t: number) => {
      const tc = Math.max(0, Math.min(1, t));
      return {
        x: fx[0] + fx[1] * tc + fx[2] * tc * tc,
        y: fy[0] + fy[1] * tc + fy[2] * tc * tc,
      };
    };

    // --- MEASURED parting. The jaw hinge (deformedPoints) now moves the
    // whole lower lip, so the inner rings genuinely separate in the mesh
    // and the triangles between them stretch. The painted cavity has to
    // cover exactly that region, or the stretched lip texture shows as a
    // streaked band under a too-small opening (which is what a fixed
    // fraction of mouth width produced once the lip started to move).
    //
    // Fit the upper and lower rings separately as smooth curves along the
    // mouth axis (the raw ring zigzags; that zigzag is why the aperture
    // was synthesised in the first place), then take their separation minus
    // the same separation at rest — a closed mouth's landmarks still sit a
    // few pixels apart, and that must not open a hole in silence. The seam
    // is the midpoint of each pair, so the parting splits equally above and
    // below it. ---
    const proj = (q: Point) =>
      Math.max(0, Math.min(1, ((q.x - left.x) * ax + (q.y - left.y) * ay) / axisLen2));
    const along = (q: Point) => (q.x - left.x) * axisNormX + (q.y - left.y) * axisNormY;
    const evalQ = (c: number[], t: number) => c[0] + c[1] * t + c[2] * t * t;
    const fitRing = (points: Point[]) =>
      fitQuadratic(points.map(along), points.map(proj));
    const lowerNow: Point[] = [];
    const upperNow: Point[] = [];
    const lowerRest: Point[] = [];
    const upperRest: Point[] = [];
    for (let k = 1; k < half; k++) {
      lowerNow.push(ring[k]);
      upperNow.push(ring[n - k]);
      lowerRest.push(this.basePoints[this.innerRing[k]]);
      upperRest.push(this.basePoints[this.innerRing[n - k]]);
    }
    // Four fits per frame, not four per sample.
    const fits =
      lowerNow.length >= 3
        ? { ln: fitRing(lowerNow), un: fitRing(upperNow), lr: fitRing(lowerRest), ur: fitRing(upperRest) }
        : null;
    const partingHalfAt = (t: number): number => {
      if (!fits) return 0;
      const now = evalQ(fits.ln, t) - evalQ(fits.un, t);
      const rest = evalQ(fits.lr, t) - evalQ(fits.ur, t);
      return Math.max(0, (now - rest) / 2);
    };
    let measuredMax = 0;
    for (let i = 0; i <= 8; i++) measuredMax = Math.max(measuredMax, partingHalfAt(0.2 + (i / 8) * 0.6));
    const openHeight = Math.max(synthHeight, measuredMax * 2);
    if (openHeight < axisLen * 0.010) return; // lips together

    // The aperture always ends INSIDE the commissures: its own rounded ends
    // then land on lip flesh, so the lips stay joined at the corners even
    // though the profile itself is blunt.
    // With the mesh genuinely parting, the painted opening must reach as
    // far as the parting does — the measured profile closes on its own at
    // the corners. Rounded shapes still narrow the synthetic profile.
    const spanHalf = 0.97 / 2;
    const t0 = 0.5 - spanHalf;
    const t1 = 0.5 + spanHalf;
    const synthSpanHalf = (0.84 - rounding * 0.4) / 2;

    // --- Sample upper and lower edges off the seam normal. ---
    const SAMPLES = 26;
    const LOWER_SHARE = 0.80; // the jaw drops; the upper lip barely lifts
    const UPPER_SHARE = 0.20;
    const upperPts: Point[] = [];
    const lowerPts: Point[] = [];
    for (let i = 0; i <= SAMPLES; i++) {
      const u = i / SAMPLES;
      const t = t0 + u * (t1 - t0);
      const here = seamAt(t);
      // Offset along the MOUTH AXIS normal, not the local seam normal.
      // The seam comes from noisy landmarks: where it tilts steeply the
      // local normal swings toward horizontal (and the sign-flip guard
      // fires), so the opening sheared into a wedge/hook on one side. A
      // mouth opens perpendicular to its own corner-to-corner axis.
      const nx = axisNormX;
      const ny = axisNormY;
      // Superellipse profile. sin(pi*u)^1.15 leaves the ends with a slope
      // of ~1.9 — almost linear, which is exactly why the mouth read as a
      // TRIANGLE. A true ellipse has an end slope near 20 (blunt); this
      // superellipse keeps that roundness while staying slightly fuller in
      // the middle than a circle.
      const e = Math.abs(2 * u - 1);
      // Synthetic profile lives in its own (narrower, rounding-aware) span.
      const es = Math.min(1, Math.abs(t - 0.5) / synthSpanHalf);
      const gap = synthHeight * Math.pow(Math.max(0, 1 - Math.pow(es, 2.4)), 1 / 1.9);
      // Whichever is larger on each side: the mesh's own parting (the
      // stretched triangles that must be covered) or the synthetic profile
      // (retraction and teeth shapes, where the jaw barely moves).
      // The measured parting is already a smooth curve that closes where
      // the rings meet, so it is used almost to the ends: forcing it to zero
      // early left parted mesh triangles near the corners uncovered.
      const parted = partingHalfAt(t) * Math.pow(Math.max(0, 1 - Math.pow(e, 8)), 0.5);
      const lowerOff = Math.max(gap * LOWER_SHARE, parted);
      const upperOff = Math.max(gap * UPPER_SHARE, parted);
      lowerPts.push({ x: here.x + nx * lowerOff, y: here.y + ny * lowerOff });
      upperPts.push({ x: here.x - nx * upperOff, y: here.y - ny * upperOff });
    }

    // Drop the shared endpoints: at u=0 and u=1 the gap is zero, so
    // upperPts and lowerPts hold the SAME point there. Feeding coincident
    // points to Catmull-Rom gives zero-length tangents and the curve
    // overshoots into a hook/wing off the corner of the mouth.
    const outline = [...lowerPts, ...upperPts.slice(1, -1).reverse()];
    (this as unknown as { lastAperture?: unknown }).lastAperture = outline;

    const xs = outline.map((p) => p.x);
    const ys = outline.map((p) => p.y);
    const bw = Math.max(...xs) - Math.min(...xs);
    const bh = Math.max(...ys) - Math.min(...ys);
    if (bw < 2 || bh < 1) return;
    // Openness must come from the SYNTHESISED opening, not the drawn
    // bounding box: bh also contains this face's resting lip bow, so a
    // curved mouth reported gapRatio > 0.09 with the lips 4px apart and ran
    // the cavity at full opacity. openHeight/axisLen is identity-independent.
    const gapRatio = openHeight / Math.max(1, axisLen);
    // One opacity used to gate the cavity, the lip shading AND the teeth, all
    // keyed purely to how far the jaw had dropped. But teeth visibility is a
    // function of lip retraction, not gape: you see someone's teeth on "fifty"
    // with their jaw almost shut. Two opacities now.
    const cavityAlpha = Math.min(1, Math.max(0, (gapRatio - 0.03) / 0.04));
    const teethAlpha = Math.max(cavityAlpha, Math.min(0.85, teethDrive * 0.9));
    if (cavityAlpha <= 0.01 && teethAlpha <= 0.01) return;
    const midY = (Math.max(...ys) + Math.min(...ys)) / 2;
    const cx = (Math.max(...xs) + Math.min(...xs)) / 2;

    const aperture = smoothClosedPath(outline);

    if (this.mouthExtension) {
      const neutralA = this.basePoints[this.innerRing[ia]];
      const neutralB = this.basePoints[this.innerRing[ib]];
      // A smiling/bowed seam is not its corner chord. Seat oral geometry at
      // the measured central seam, otherwise upper incisors disappear above
      // the aperture while the lower row appears to be the upper teeth.
      const [anchorA, anchorB] = centralMouthAnchors(this.innerRing.map(i => this.basePoints[i]), neutralA, neutralB);
      ctx.save();
      try {
        this.mouthExtension.draw(ctx, {
          weights: this.weights,
          viseme: this.pose?.()?.viseme ?? this.currentViseme(performance.now()),
          upper: upperPts, lower: lowerPts, aperture,
          neutralLeft: anchorA.x <= anchorB.x ? anchorA : anchorB,
          neutralRight: anchorA.x <= anchorB.x ? anchorB : anchorA,
          lipColour: this.lipColour, skinColour: this.skinColour ?? undefined, cavityAlpha, teethAlpha,
        });
      } finally { ctx.restore(); }
      return;
    }

    ctx.save();
    ctx.clip(aperture);

    ctx.globalAlpha = cavityAlpha;
    const cavity = ctx.createLinearGradient(0, midY - bh / 2, 0, midY + bh / 2);
    // Derived from this face's lips: deepest at the top where the upper lip
    // shadows the cavity, warming toward the tongue below. Never fully black
    // — a real mouth is a lit red space, not a void, and pure black reads as
    // a hole cut in the face.
    const [lr, lg, lb] = this.lipColour;
    const shade = (k: number) =>
      `rgb(${Math.round(lr * k)}, ${Math.round(lg * k * 0.86)}, ${Math.round(lb * k * 0.86)})`;
    const [top, middle, bottom] = this.profile.cavityShade;
    cavity.addColorStop(0, shade(top));
    cavity.addColorStop(0.55, shade(middle));
    cavity.addColorStop(1, shade(bottom));
    ctx.fillStyle = cavity;
    ctx.fillRect(cx - bw, midY - bh, bw * 2, bh * 2);

    // --- Inner-lip depth. Without this the opening reads as a slice cut
    // through the lips. Light comes from above, so the UNDERSIDE of the
    // upper lip is deeply shadowed while the top surface of the lower lip
    // catches a wet highlight. ---
    const lipEdge = (edge: Point[], width: number, colour: string) => {
      ctx.beginPath();
      ctx.moveTo(edge[0].x, edge[0].y);
      for (let i = 1; i < edge.length; i++) ctx.lineTo(edge[i].x, edge[i].y);
      ctx.strokeStyle = colour;
      ctx.lineWidth = width;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.stroke();
    };
    // Upper lip underside: wide soft shadow, then a tighter darker core.
    lipEdge(upperPts, bh * 0.3, "rgba(26, 8, 8, 0.38)");
    lipEdge(upperPts, bh * 0.13, "rgba(18, 5, 5, 0.42)");
    // Lower lip inner surface: shadow at the very edge, then the wet line.
    lipEdge(lowerPts, bh * 0.18, "rgba(40, 12, 12, 0.34)");
    lipEdge(
      lowerPts.map((q) => ({ x: q.x, y: q.y - bh * 0.03 })),
      Math.max(0.7, bh * 0.03),
      "rgba(255, 226, 214, 0.16)"
    );

    // --- Teeth: individual incisors hanging from the upper arch. ---
    const teethGap = 0.06 * (this.tuning.teethThreshold / DEFAULT_TUNING.teethThreshold);
    // How much of the teeth is exposed. mouthStretch used to appear here
    // twice — once inside `retract`/gapRatio and again as an explicit
    // multiplier — which is why the spread vowels saturated.
    const teethAmount =
      Math.max(
        Math.max(0, Math.min(1, (gapRatio - teethGap) / 0.08)),
        teethDrive * 0.75
      ) * Math.max(0, Math.min(1, 1 - rounding / 0.45));
    ctx.globalAlpha = 1;
    if (this.profile.teeth && teethAmount > 0.02 && teethAlpha > 0.02) {
      const upperH = Math.min(bh * 0.3, bw * 0.04) * (0.45 + 0.55 * teethAmount);
      this.drawTeethRow(upperPts, bw, teethAlpha, teethAmount, upperH, false);
      // The lower incisors are attached to the JAW, so they ride the lower
      // lip. Almost all of each tooth is hidden behind that lip — only the
      // biting tips clear it — so the row is seated ON the lower edge and
      // drawn short. Floating it into the middle of the cavity (which is
      // what flattening it toward the chord did) looks badly wrong.
      const lowerArch = lowerPts.map((q) => ({ x: q.x, y: q.y - bh * 0.055 }));
      // Lower teeth appear once there is room for them without meeting the
      // uppers — a real jaw shows them well before it is fully open.
      const room = bh - upperH * 1.35;
      const lowerH = Math.min(upperH * 0.5, room * 0.34);
      if (lowerH > 0.8) {
        // The lower row shows across the front only.
        this.drawTeethRow(lowerArch, bw, teethAlpha, teethAmount, lowerH, true, 0.3, 0.7, 0.18);
      }
      // Dissolve both rows into darkness toward the commissures, so the
      // teeth recede into the mouth instead of stopping at a hard end.
      const fade = ctx.createLinearGradient(cx - bw / 2, 0, cx + bw / 2, 0);
      fade.addColorStop(0, "rgba(24, 9, 8, 0.95)");
      fade.addColorStop(0.16, "rgba(24, 9, 8, 0.55)");
      fade.addColorStop(0.34, "rgba(24, 9, 8, 0)");
      fade.addColorStop(0.66, "rgba(24, 9, 8, 0)");
      fade.addColorStop(0.84, "rgba(24, 9, 8, 0.55)");
      fade.addColorStop(1, "rgba(24, 9, 8, 0.95)");
      ctx.globalAlpha = teethAlpha;
      ctx.fillStyle = fade;
      ctx.fillRect(cx - bw / 2, midY - bh, bw, bh * 2);
      ctx.globalAlpha = 1;
    }

    // Tongue: a soft rise low in the cavity on genuinely open shapes.
    ctx.globalAlpha = cavityAlpha;
    if (gapRatio > this.profile.tongueFrom) {
      const amount = Math.min(1, (gapRatio - this.profile.tongueFrom) / 0.12);
      const ty2 = midY + bh * 0.34;
      const tongue = ctx.createRadialGradient(cx, ty2, bh * 0.06, cx, ty2, bh * 0.6);
      tongue.addColorStop(0, `rgba(176, 92, 86, ${(0.85 * amount).toFixed(3)})`);
      tongue.addColorStop(1, "rgba(120, 52, 48, 0)");
      ctx.fillStyle = tongue;
      ctx.beginPath();
      ctx.ellipse(cx, ty2, bw * 0.3, bh * 0.3, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();

    // Soft rim so the opening blends into the lips.
    ctx.save();
    ctx.globalAlpha = cavityAlpha * 0.45;
    ctx.strokeStyle = "rgba(60, 22, 20, 0.5)";
    ctx.lineWidth = Math.max(1, bw * 0.016);
    ctx.stroke(aperture);
    ctx.restore();
  }

  /**
   * One row of teeth on a smoothed dental arch, drawn with perspective:
   * the arch curves away from the camera, so teeth toward the corners are
   * narrower, shorter, set deeper into the mouth and in shadow. Uniform
   * teeth read as a flat printed strip.
   */
  private drawTeethRow(
    arch: Point[],
    bw: number,
    alpha: number,
    exposure: number,
    height: number,
    isLower: boolean,
    // Teeth occupy only the front of the arch; the rest curves away out of
    // sight. Without this the row wrapped up around the commissures.
    spanStart = 0.08,
    spanEnd = 0.92,
    // A dental arch is far flatter than the lip opening it sits behind;
    // following the aperture curve exactly made the row dive at the sides.
    flatten = 0.3
  ): void {
    const ctx = this.ctx;
    if (arch.length < 4 || height < 0.6) return;

    // Smooth arch: a quadratic through the ends and the midpoint. Following
    // the raw samples put the teeth on a wavy line.
    // Fit the arch over the span the row actually occupies. Using
    // arch[0] / arch[last] anchored the curve on the ZERO-GAP commissure
    // samples — those sit on the seam, not on the lip, so the fitted arch
    // was pulled up off the lower lip and the row appeared to float.
    const sampleArch = (frac: number) => {
      const f = Math.max(0, Math.min(1, frac)) * (arch.length - 1);
      const i = Math.min(arch.length - 2, Math.floor(f));
      const k = f - i;
      return {
        x: arch[i].x + (arch[i + 1].x - arch[i].x) * k,
        y: arch[i].y + (arch[i + 1].y - arch[i].y) * k,
      };
    };
    const a0 = sampleArch(spanStart);
    const a1 = sampleArch(spanEnd);
    const rawMid = sampleArch((spanStart + spanEnd) / 2);
    const chordMid = { x: (a0.x + a1.x) / 2, y: (a0.y + a1.y) / 2 };
    const am = {
      x: rawMid.x + (chordMid.x - rawMid.x) * flatten,
      y: rawMid.y + (chordMid.y - rawMid.y) * flatten,
    };
    const ctrl = { x: 2 * am.x - (a0.x + a1.x) / 2, y: 2 * am.y - (a0.y + a1.y) / 2 };
    const archAt = (u: number) => {
      const k = Math.max(0, Math.min(1, u));
      const m = 1 - k;
      return {
        x: m * m * a0.x + 2 * m * k * ctrl.x + k * k * a1.x,
        y: m * m * a0.y + 2 * m * k * ctrl.y + k * k * a1.y,
      };
    };

    // Central incisors widest, narrowing to the canines.
    const widths = isLower
      ? [0.45, 0.65, 0.85, 1.0, 1.0, 0.85, 0.65, 0.45]
      : [0.42, 0.62, 0.85, 1.1, 1.1, 0.85, 0.62, 0.42];
    const total = widths.reduce((s, v) => s + v, 0);
    const dir = isLower ? -1 : 1; // lower teeth grow upward

    ctx.save();
    ctx.globalAlpha = Math.min(0.97, alpha * (0.72 + 0.28 * exposure));
    let acc = 0;
    for (let i = 0; i < widths.length; i++) {
      const u0 = acc / total;
      acc += widths[i];
      const u1 = acc / total;
      const uc = (u0 + u1) / 2;
      // Perspective: 1 at the front of the arch, 0 at the corners.
      const depth = Math.sin(Math.PI * uc);
      const h = height * (0.22 + 0.78 * depth);
      // Receding teeth sit deeper — pushed back toward the gum line.
      const recess = (1 - depth) * height * 0.95 * dir;
      const gapPx = Math.max(0.25, bw * 0.0018);

      const a = archAt(u0);
      const b = archAt(u1);
      const mid = archAt(uc);
      const ay = a.y + recess;
      const by = b.y + recess;
      const my = mid.y + recess;

      ctx.beginPath();
      ctx.moveTo(a.x + gapPx, ay);
      ctx.quadraticCurveTo(mid.x, my - 0.1 * h * dir, b.x - gapPx, by);
      ctx.lineTo(b.x - gapPx, by + h * 0.72 * dir);
      ctx.quadraticCurveTo(
        mid.x,
        my + h * 1.1 * dir,
        a.x + gapPx,
        ay + h * 0.72 * dir
      );
      ctx.closePath();

      // Darker toward the corners (in shadow) and darker overall on the
      // lower row, which sits under the upper lip's shadow.
      const tint = (isLower ? 0.42 : 0.5) + (isLower ? 0.36 : 0.5) * depth;
      const g = ctx.createLinearGradient(0, my, 0, my + h * dir);
      g.addColorStop(0, `rgba(${Math.round(236 * tint)}, ${Math.round(230 * tint)}, ${Math.round(216 * tint)}, 0.98)`);
      g.addColorStop(0.7, `rgba(${Math.round(248 * tint)}, ${Math.round(242 * tint)}, ${Math.round(228 * tint)}, 0.97)`);
      g.addColorStop(1, `rgba(${Math.round(200 * tint)}, ${Math.round(192 * tint)}, ${Math.round(176 * tint)}, 0.8)`);
      ctx.fillStyle = g;
      ctx.fill();
      // Hairline separation, as shadow rather than a cut.
      ctx.strokeStyle = "rgba(96, 74, 62, 0.2)";
      ctx.lineWidth = Math.max(0.4, bw * 0.0025);
      ctx.stroke();
    }

    // Shadow where the row meets the lip/gum.
    const first = archAt(0);
    const last = archAt(1);
    const y0 = isLower
      ? Math.max(first.y, last.y) - height * 0.1
      : Math.min(first.y, last.y) - height * 0.25;
    const shade = ctx.createLinearGradient(0, y0, 0, y0 + height * 0.7 * dir);
    shade.addColorStop(0, "rgba(70, 26, 24, 0.5)");
    shade.addColorStop(1, "rgba(70, 26, 24, 0)");
    ctx.fillStyle = shade;
    ctx.fillRect(
      Math.min(first.x, last.x),
      Math.min(y0, y0 + height * 0.7 * dir),
      Math.abs(last.x - first.x),
      height * 0.7
    );
    ctx.restore();
  }

  private drawDebugMesh(pts: Point[]): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = "rgba(0, 255, 140, 0.35)";
    ctx.lineWidth = 0.5;
    for (const [a, b, c] of this.triangles) {
      ctx.beginPath();
      ctx.moveTo(pts[a].x, pts[a].y);
      ctx.lineTo(pts[b].x, pts[b].y);
      ctx.lineTo(pts[c].x, pts[c].y);
      ctx.closePath();
      ctx.stroke();
    }
    ctx.fillStyle = "rgba(255, 80, 80, 0.9)";
    for (const i of this.innerRing) {
      ctx.beginPath();
      ctx.arc(pts[i].x, pts[i].y, 1.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}
