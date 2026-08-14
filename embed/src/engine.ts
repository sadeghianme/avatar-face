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
import { BodyMotion, BREATH_RISE, SWAY_TRAVEL } from "./bodymotion";
import { HeadMotion } from "./headmotion";
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
// Fast. The squash is only ever an approximation, so the less time it is on
// screen the better; a real blink is 100-150ms anyway.
const BLINK_MS = 150;

/**
 * Blink envelope, 0..1 -> 0..1, closing faster than it opens.
 *
 * A single smooth curve rather than two joined quarter-waves: the old pair
 * met at the peak with a discontinuous velocity, so the lid arrived at its
 * lowest point and reversed in one frame, which reads as a snap.
 */
function blinkEase(phase: number): number {
  const t = Math.max(0, Math.min(1, phase));
  // Skew time so the close occupies the first ~40% and the opening the rest,
  // then take one raised cosine over the skewed clock.
  const skewed = t < 0.4 ? (t / 0.4) * 0.5 : 0.5 + ((t - 0.4) / 0.6) * 0.5;
  // No phase offset here. With one, the curve starts CLOSED, opens at the
  // peak and shuts again at the end — and since the eye is already open at
  // rest, a single blink then renders as shut-open-shut: several fast
  // blinks where there should be one.
  return 0.5 - 0.5 * Math.cos(skewed * Math.PI * 2);
}
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
const NOD_MS = 1050;

/** Where the mouth-frame feather starts fading, as a fraction of the radius. */
const FEATHER_SOLID = 0.45;

/**
 * The visible mouth patch, as multiples of the live mouth's own size.
 *
 * Sized here rather than at generation time on purpose: the stored frame is
 * a generous crop, and how much of it shows is a rendering decision that can
 * be re-tuned without paying to regenerate anything. Generous was wrong —
 * a patch covering the whole lower face replaces nose, chin and cheeks with
 * generated pixels, and the model's identity drift is then plainly visible.
 * Tall relative to width because an open jaw grows downward far more than
 * the mouth grows sideways.
 */
const MOUTH_PATCH_W = 0.82;
const MOUTH_PATCH_H = 1.5;

/** Pivot depth for body sway, as a multiple of canvas height. Below the
 *  frame: a standing body turns about its feet, not its middle. */
const BODY_PIVOT_DEPTH = 1.75;

/** A head is wider than the face landmarks that sit inside it. Used only to
 *  express the sway target in the same units it was measured in. */
const FACE_TO_HEAD_WIDTH = 1.4;

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

interface Point {
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
  /**
   * Show the ENTIRE photo (hair, shoulders, background) with the animated
   * face composited over it, instead of cropping to the face box. Roll and
   * breathing sway are disabled in this mode so the mesh rim stays glued
   * to the static background.
   */
  fullPhoto?: boolean;
}

export class AvatarEngine {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private rig: Rig;
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
  private triangles: [number, number, number][] = [];
  private innerRing: number[] = [];

  // Animation state
  private cues: Cue[] = [];
  private cueStart = 0;
  private speaking = false;
  private weights: BlendWeights = { ...ZERO_WEIGHTS };
  private targetWeights: BlendWeights = { ...ZERO_WEIGHTS };
  private energy = 0; // smoothed speech energy, drives head motion
  private blink = 0;
  private nextBlinkAt = 0;
  private nextNodAt = 0;
  private nodPhase = 1; // 1 = finished
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
  /** The face's own lip colour, sampled at load. The mouth interior is
   * derived from it rather than hardcoded. */
  private lipColour: [number, number, number] = [150, 90, 84];
  /** Each eye's own lash colour. Not every face has black lashes — a fair or
   * stylized one can have brown, auburn or near-white, and drawing black on
   * those puts a stranger's eyelash on the face. */
  private lashColour: string[] = ["rgba(60, 42, 38, 0.75)", "rgba(60, 42, 38, 0.75)"];
  private raf = 0;
  private startTime = 0;
  private lastTickAt = 0;

  // Audio
  private audioCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private analyserData: Uint8Array | null = null;
  private currentAudio: HTMLAudioElement | null = null;
  private onAudioEnd: (() => void) | null = null;

  debugMesh: boolean;
  /** Live animation parameters — mutate freely, applied next frame. */
  tuning: EngineTuning = { ...DEFAULT_TUNING };
  private fullPhoto: boolean;
  // Source crop (rig-image coords) that the canvas displays.
  private crop = { x: 0, y: 0, w: 0, h: 0 };

  // Layered render path (see setLayers). Null means single-photo.
  private layers: {
    background?: HTMLImageElement;
    body: HTMLImageElement;
    head: HTMLImageElement;
  } | null = null;

  // Photographic mouth keyframes (see setVisemeFrames). Null = geometric.
  private visemeFrames: {
    box: { x: number; y: number; w: number; h: number };
    frames: { shape: Partial<BlendWeights>; image: HTMLImageElement }[];
  } | null = null;

  constructor(canvas: HTMLCanvasElement, rig: Rig, texture: HTMLImageElement, opts: EngineOptions = {}) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2d canvas context unavailable");
    this.ctx = ctx;
    this.rig = rig;
    this.texture = texture;
    this.debugMesh = opts.debugMesh ?? false;
    this.fullPhoto = opts.fullPhoto ?? false;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    this.innerRing = this.validInnerRing();
    this.computeFraming();
    this.sampleLipColour();
    this.sampleLashColour();
    this.subdivideMouthRegion();
    this.startTime = performance.now();
    this.nextBlinkAt = this.startTime + 1200 + Math.random() * 2000;
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
   * Switch the mouth to photographic keyframes.
   *
   * Each frame is a picture of THIS face making one mouth shape, aligned to
   * the photo and cropped to a shared box (see services/visemeframes.py).
   * The frames carry the blendshape coordinates of the shape they depict, so
   * they are keys in the space the cue blender already produces — nothing
   * about timing, coarticulation or stress changes here. Only the pixels do.
   */
  setVisemeFrames(set: {
    box: { x: number; y: number; w: number; h: number };
    frames: { shape: Partial<BlendWeights>; image: HTMLImageElement }[];
  }): void {
    if (this.destroyed || !set.frames.length) return;
    this.visemeFrames = set;
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
    this.derivedParents = [];
    this.computeFraming();
    this.sampleLipColour();
    this.sampleLashColour();
    this.subdivideMouthRegion();
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
   * Frame the face from face_box: expand upward for forehead/hair and a
   * little down for the chin, fit into the canvas at TRUE aspect, center.
   */
  private computeFraming(): void {
    let cropX = 0;
    let cropY = 0;
    let cropW = this.rig.image_size[0];
    let cropH = this.rig.image_size[1];
    if (!this.fullPhoto) {
      const [bx0, by0, bx1, by1] = this.rig.face_box;
      const bw = bx1 - bx0;
      const bh = by1 - by0;
      cropX = Math.max(0, bx0 - bw * 0.25);
      cropY = Math.max(0, by0 - bh * 0.55); // forehead + hair
      const cropX1 = Math.min(this.rig.image_size[0], bx1 + bw * 0.25);
      const cropY1 = Math.min(this.rig.image_size[1], by1 + bh * 0.18); // chin
      cropW = cropX1 - cropX;
      cropH = cropY1 - cropY;
    }
    this.crop = { x: cropX, y: cropY, w: cropW, h: cropH };

    const cw = this.canvas.width;
    const ch = this.canvas.height;
    this.scale = Math.min(cw / cropW, ch / cropH);
    this.offsetX = (cw - cropW * this.scale) / 2 - cropX * this.scale;
    this.offsetY = (ch - cropH * this.scale) / 2 - cropY * this.scale;

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

    const x = Math.max(0, fx0 - faceW * 0.42);
    const y = Math.max(0, fy0 - faceH * 0.9);
    const w = Math.min(this.canvas.width, fx1 + faceW * 0.42) - x;
    const h = Math.min(this.canvas.height, fy1 + faceH * 0.5) - y;
    if (w < 8 || h < 8) return;

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
    const dy = (this.headDrive.pitch * g.pitchPx + nod * this.energy * g.faceH * 0.013) * s;
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
    } catch {
      // Tainted texture: keep the default, which is a mid warm lip.
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

  /** Play base64 audio with a viseme cue track. Resolves onEnd (also on stop()). */
  playAudio(audioB64: string, mime: string, cues: Cue[], onEnd?: () => void): void {
    this.stopAudio();
    const audio = new Audio(`data:${mime};base64,${audioB64}`);
    this.currentAudio = audio;
    this.onAudioEnd = onEnd ?? null;
    this.cues = prepareCues(cues);
    this.speaking = true;

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
  }

  /** Re-align the cue clock to a known position in the track (ms). */
  syncCueTime(ms: number): void {
    this.cueStart = performance.now() - ms;
  }

  stopSpeech(): void {
    this.stopAudio();
    this.speaking = false;
    this.cues = [];
    this.targetWeights = { ...ZERO_WEIGHTS };
  }

  isSpeaking(): boolean {
    return this.speaking;
  }

  private finishSpeech(): void {
    this.speaking = false;
    this.cues = [];
    this.targetWeights = { ...ZERO_WEIGHTS };
    const cb = this.onAudioEnd;
    this.onAudioEnd = null;
    this.currentAudio = null;
    if (cb && !this.destroyed) cb();
  }

  private stopAudio(): void {
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

  private currentViseme(now: number): string {
    if (!this.speaking || !this.cues.length) return "sil";
    const t = now - this.cueStart;
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
    const t = now - this.cueStart;
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
    const visemeWeights = this.speaking ? this.blendedCueWeights(now) : { ...ZERO_WEIGHTS };
    if (this.speaking && this.currentViseme(now) === "sil") {
      const amp = this.amplitude();
      if (amp > 0.06) visemeWeights.jawOpen = Math.min(0.5, amp * 1.2);
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
      const tau = target > this.weights[key] ? TAU_OPEN : TAU_CLOSE;
      const rate = 1 - Math.exp(-dt / tau);
      this.weights[key] += (target - this.weights[key]) * rate;
    }

    // Speech energy (drives head pose amplitude).
    const instant = this.speaking
      ? Math.min(1, this.weights.jawOpen + this.weights.mouthStretch * 0.5 + this.amplitude())
      : 0;
    this.energy += (instant - this.energy) * (1 - Math.exp(-dt / 270));

    // Eased (sin-curve) blinks.
    if (now >= this.nextBlinkAt) {
      this.nextBlinkAt = now + 2200 + Math.random() * 3200;
      this.blink = 0.0001; // arm
    }
    if (this.blink > 0) {
      this.blink += dt / BLINK_MS;
      if (this.blink >= 1) this.blink = 0;
    }

    // Gentle nods on a loose cadence while speaking.
    if (this.speaking && now >= this.nextNodAt) {
      this.nextNodAt = now + 1800 + Math.random() * 2600;
      this.nodPhase = 0;
    }
    if (this.nodPhase < 1) this.nodPhase = Math.min(1, this.nodPhase + dt / NOD_MS);

    this.body.update(dt, now);
    this.headDrive.update(dt, now, this.speaking);

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
    for (let i = 0; i < pts.length; i++) {
      const px = pts[i].x - mcx;
      const py = pts[i].y - mcy;
      const dist = Math.hypot(px, py * 1.35); // squashed: motion spreads wider than tall
      if (dist > reach) continue;
      // Smoothstep falloff: 1 at the lips, easing to 0 at `reach`.
      const t = 1 - dist / reach;
      const falloff = t * t * (3 - 2 * t);
      const nx = px / (mw / 2);
      const ny = py / (mh / 2);
      const below = Math.max(0, Math.min(1.2, ny));
      let dx = 0;
      let dy = 0;
      // jawOpen: everything below the lip line drops, most at the lip.
      dy += w.jawOpen * mh * 0.62 * below * falloff;
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

    // Cheek response: points lateral to the mouth corners push outward as
    // the jaw opens. (Jaw drop itself is handled by the continuous field
    // above — doing it again here, skipping mouth points, was what created
    // the torn seam along the lower lip.)
    if (w.jawOpen > 0.01) {
      for (let i = 0; i < pts.length; i++) {
        const dx = pts[i].x - mcx;
        const dyFromMouth = pts[i].y - mcy;
        const lateral = Math.abs(dx) - mw * 0.4;
        if (lateral > 0 && lateral < mw * 0.8 && Math.abs(dyFromMouth) < mh * 2.5) {
          const cheekFalloff = 1 - lateral / (mw * 0.8);
          pts[i].x += Math.sign(dx) * w.jawOpen * mw * 0.02 * cheekFalloff * this.tuning.mouthOpen;
        }
      }
    }

    // Face half-height, for expression amplitudes.
    const ys = pts.map((p) => p.y);
    const fh = (Math.max(...ys) - Math.min(...ys)) / 2;

    // Eased blinks: the upper lid sweeps DOWN to the lower lid (lid skin
    // stretches over the eyeball); the lower lid rises only slightly.
    // Corner points stay pinned, mid-lid points travel furthest.
    if (this.blink > 0) {
      // Asymmetric ease: lids snap shut faster than they reopen.
      const phase = this.blink;
      // One continuous curve over the whole blink. The old piecewise
      // sin-then-cos met at its peak with a corner in the velocity, which is
      // what made the close read as a snap.
      const amount = blinkEase(phase);
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

    // Derived midpoint vertices (mouth subdivision) follow their parents
    // through EVERY layer above — computed last, from final positions.
    for (const [a, b] of this.derivedParents) {
      pts.push({ x: (pts[a].x + pts[b].x) / 2, y: (pts[a].y + pts[b].y) / 2 });
    }

    return pts;
  }

  // --- Rendering ---------------------------------------------------------------

  private render(): void {
    const now = performance.now();
    const ctx = this.ctx;
    const pts = this.deformedPoints(now);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

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

    // Base layer: the un-warped photo. Triangle seams and sub-pixel gaps in
    // the warp then reveal original pixels instead of holes — and in
    // fullPhoto mode this is what shows hair/shoulders/background.
    const tw = this.texture.naturalWidth / this.rig.image_size[0];
    const th = this.texture.naturalHeight / this.rig.image_size[1];
    ctx.drawImage(
      this.texture,
      this.crop.x * tw,
      this.crop.y * th,
      this.crop.w * tw,
      this.crop.h * th,
      this.crop.x * this.scale + this.offsetX,
      this.crop.y * this.scale + this.offsetY,
      this.crop.w * this.scale,
      this.crop.h * this.scale
    );

    // --- Head layer -------------------------------------------------------
    //
    // The whole head — hair included — moves as one rigid unit over the
    // still body, with the face given a slightly larger share of the same
    // travel (parallax), which is what makes a shift read as a turn. For a
    // cut-out, the head is erased from the base first so the moved layer
    // does not leave a ghost of itself behind.
    const head = this.headOffsets();
    const geom = this.headGeom;
    if (geom && this.headLayer && this.cutOut) {
      ctx.globalCompositeOperation = "destination-out";
      ctx.drawImage(this.headLayer, geom.x, geom.y);
      ctx.globalCompositeOperation = "source-over";
    }
    ctx.save();
    if (geom && this.headLayer) {
      ctx.translate(geom.pivotX + head.dx, geom.pivotY + head.dy);
      ctx.rotate(head.roll);
      ctx.translate(-geom.pivotX, -geom.pivotY);
      ctx.drawImage(this.headLayer, geom.x, geom.y);
      ctx.translate(head.fdx, head.fdy);
    }

    for (const [a, b, c] of this.triangles) {
      this.drawWarpedTriangle(pts, a, b, c);
    }

    this.drawEyes(pts);
    this.drawLashes(pts);
    this.drawMouth(pts);

    if (this.debugMesh) this.drawDebugMesh(pts);
    ctx.restore();
    ctx.restore();
  }

  /**
   * The mouth: photographic keyframes when they exist, geometry otherwise.
   *
   * The two are alternatives, never both. The contact line and interior
   * shading are compensations for what a warp of a closed mouth cannot show
   * — over a real photograph of an open mouth they draw a second dark line
   * across teeth that are already there.
   */
  private drawMouth(pts: Point[]): void {
    if (this.visemeFrames) {
      this.drawVisemeFrames(pts);
      return;
    }
    this.drawLipContactLine(pts);
    this.drawMouthInterior(pts);
  }

  /**
   * The mouth, drawn from photographs instead of warped geometry.
   *
   * The current shape is a point in blendshape space; the frames are labelled
   * points in that same space. Inverse-distance weights over the nearest few
   * give a continuous mixture — the mouth is never parked on a keyframe, it
   * moves through them, which is what the geometric path was already doing
   * and what real articulation does.
   *
   * Compositing note: the frames are stacked back-to-front with alpha
   * w_i / sum(w_i..w_n), which is exactly a weighted average under `over`
   * compositing — the last (heaviest) frame lands at full alpha, so the
   * region is fully replaced rather than ghosted over the warped mouth
   * underneath. The whole stack is clipped to a feathered ellipse so the
   * patch has no edge of its own.
   */
  private drawVisemeFrames(pts: Point[]): void {
    const set = this.visemeFrames!;
    const w = this.weights;

    // Distance in shape space. jawOpen dominates how a mouth reads, so it
    // carries more weight than the lip-detail channels.
    const AXES: [keyof BlendWeights, number][] = [
      ["jawOpen", 1.6],
      ["mouthClose", 1.2],
      ["mouthPucker", 1.0],
      ["mouthFunnel", 0.8],
      ["mouthStretch", 0.9],
      ["mouthSmile", 0.5],
    ];
    const scored = set.frames.map((frame) => {
      let d2 = 0;
      for (const [key, k] of AXES) {
        const delta = (w[key] ?? 0) - (frame.shape[key] ?? 0);
        d2 += k * delta * delta;
      }
      // Inverse SQUARED distance: plain inverse distance leaves every key
      // contributing everywhere, so a closed mouth carried a little of the
      // wide-open frame and the resting face wore a permanent half-smile.
      // Squaring makes the nearest key clearly dominant while still
      // crossfading through the ones between.
      return { frame, weight: 1 / (d2 * d2 + 0.004) };
    });
    scored.sort((a, b) => b.weight - a.weight);
    const top = scored.slice(0, 3);
    const total = top.reduce((sum, s) => sum + s.weight, 0);
    if (!(total > 0)) return;

    // Where the stored patch lands on canvas, in the photo's mapping.
    const box = set.box;
    const dx = box.x * this.scale + this.offsetX;
    const dy = box.y * this.scale + this.offsetY;
    const dw = box.w * this.scale;
    const dh = box.h * this.scale;

    // How much of it is allowed to SHOW: an ellipse hugging the live mouth.
    // Taken from the deformed points rather than the stored box so it tracks
    // the mouth the rest of the engine is drawing, and so the visible extent
    // stays a render-time decision (see MOUTH_PATCH_W/H).
    const mouthIdx = this.rig.mouth_indices ?? [];
    if (!mouthIdx.length) return;
    let mx0 = Infinity, my0 = Infinity, mx1 = -Infinity, my1 = -Infinity;
    for (const i of mouthIdx) {
      const p = pts[i];
      if (!p) continue;
      if (p.x < mx0) mx0 = p.x;
      if (p.x > mx1) mx1 = p.x;
      if (p.y < my0) my0 = p.y;
      if (p.y > my1) my1 = p.y;
    }
    if (!(mx1 > mx0)) return;
    const mcx = (mx0 + mx1) / 2;
    const mcy = (my0 + my1) / 2;
    const mw = mx1 - mx0;
    // Height from the WIDTH, not the measured height: a closed mouth is a
    // few pixels tall, and a patch scaled from that would be a slit that
    // cannot show an open jaw.
    const rx = mw * MOUTH_PATCH_W;
    const ry = mw * MOUTH_PATCH_H * 0.5;

    // Build the blend in an offscreen buffer, then feather the buffer once
    // and stamp it. Feathering each frame as it goes down would fade the
    // earlier frames repeatedly and hollow out the middle of the mouth.
    const buffer = this.mouthBuffer(Math.ceil(dw), Math.ceil(dh));
    if (!buffer) return;
    const bctx = buffer.getContext("2d")!;
    bctx.globalCompositeOperation = "source-over";
    bctx.clearRect(0, 0, buffer.width, buffer.height);
    // Weighted average under `over`: draw lightest first at full alpha, then
    // each heavier frame at w_i / (sum of it and everything already down).
    // The accumulator has to grow with what is BELOW — running it the other
    // way puts the heaviest frame on top at alpha 1, which hides the blend
    // entirely and snaps the mouth from key to key. (Caught by sampling a
    // shape halfway between two keys and finding one key's exact colour.)
    let below = 0;
    for (let i = top.length - 1; i >= 0; i--) {
      below += top[i].weight;
      bctx.globalAlpha = Math.min(1, top[i].weight / below);
      bctx.drawImage(top[i].frame.image, 0, 0, buffer.width, buffer.height);
    }
    bctx.globalAlpha = 1;

    // Feather to the mouth ellipse: a hard-edged patch stamps a visible
    // rectangle of slightly different skin around every mouth.
    // destination-in keeps the buffer only where the gradient is opaque.
    // The ellipse is expressed in BUFFER pixels, which is why the live
    // mouth centre is converted out of canvas space here.
    const bufScaleX = buffer.width / dw;
    const bufScaleY = buffer.height / dh;
    bctx.globalCompositeOperation = "destination-in";
    bctx.save();
    bctx.translate((mcx - dx) * bufScaleX, (mcy - dy) * bufScaleY);
    bctx.scale(rx * bufScaleX, ry * bufScaleY);
    const feather = bctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    feather.addColorStop(0, "rgba(0,0,0,1)");
    feather.addColorStop(FEATHER_SOLID, "rgba(0,0,0,1)");
    feather.addColorStop(1, "rgba(0,0,0,0)");
    bctx.fillStyle = feather;
    // Cover the whole buffer in this scaled space, so nothing outside the
    // ellipse survives regardless of where the mouth sits in the patch.
    bctx.fillRect(-1e4, -1e4, 2e4, 2e4);
    bctx.restore();
    bctx.globalCompositeOperation = "source-over";

    this.ctx.drawImage(buffer, dx, dy, dw, dh);
  }

  /** Reusable offscreen buffer for the mouth blend, grown as needed. */
  private mouthBufferCanvas: HTMLCanvasElement | null = null;
  private mouthBuffer(width: number, height: number): HTMLCanvasElement | null {
    if (width < 2 || height < 2) return null;
    let canvas = this.mouthBufferCanvas;
    if (!canvas) canvas = this.mouthBufferCanvas = document.createElement("canvas");
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    return canvas;
  }

  /** Draw a full-frame layer through the same crop/scale mapping as the photo. */
  private drawFullFrame(img: HTMLImageElement): void {
    const tw = img.naturalWidth / this.rig.image_size[0];
    const th = img.naturalHeight / this.rig.image_size[1];
    this.ctx.drawImage(
      img,
      this.crop.x * tw,
      this.crop.y * th,
      this.crop.w * tw,
      this.crop.h * th,
      this.crop.x * this.scale + this.offsetX,
      this.crop.y * this.scale + this.offsetY,
      this.crop.w * this.scale,
      this.crop.h * this.scale
    );
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

    for (const [a, b, c] of this.triangles) {
      this.drawWarpedTriangle(pts, a, b, c);
    }
    this.drawEyes(pts);
    this.drawLashes(pts);
    this.drawMouth(pts);
    if (this.debugMesh) this.drawDebugMesh(pts);
    ctx.restore();
    ctx.restore();
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

  /**
   * Draw one texture triangle warped to its deformed destination.
   * Affine solved with Cramer's rule; degenerate triangles are skipped.
   */
  private drawWarpedTriangle(pts: Point[], i0: number, i1: number, i2: number): void {
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
    // Slightly inflate the clip triangle to hide seams between triangles.
    const cx = (d0.x + d1.x + d2.x) / 3;
    const cy = (d0.y + d1.y + d2.y) / 3;
    const grow = (p: Point) => ({ x: p.x + (p.x - cx) * 0.015, y: p.y + (p.y - cy) * 0.015 });
    const g0 = grow(d0), g1 = grow(d1), g2 = grow(d2);
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
    if (this.blink <= 0) return;
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
    const openHeight =
      Math.max(Math.max(0, openFrac), teethDrive * 0.018) * axisLen * this.tuning.mouthOpen;
    if (openHeight < axisLen * 0.010) return; // lips together

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

    // The aperture always ends INSIDE the commissures: its own rounded ends
    // then land on lip flesh, so the lips stay joined at the corners even
    // though the profile itself is blunt.
    const spanHalf = (0.84 - rounding * 0.4) / 2;
    const t0 = 0.5 - spanHalf;
    const t1 = 0.5 + spanHalf;

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
      const gap = openHeight * Math.pow(Math.max(0, 1 - Math.pow(e, 2.4)), 1 / 1.9);
      lowerPts.push({ x: here.x + nx * gap * LOWER_SHARE, y: here.y + ny * gap * LOWER_SHARE });
      upperPts.push({ x: here.x - nx * gap * UPPER_SHARE, y: here.y - ny * gap * UPPER_SHARE });
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
    cavity.addColorStop(0, shade(0.3));
    cavity.addColorStop(0.55, shade(0.46));
    cavity.addColorStop(1, shade(0.62));
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
    if (teethAmount > 0.02 && teethAlpha > 0.02) {
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
    if (gapRatio > 0.26) {
      const amount = Math.min(1, (gapRatio - 0.26) / 0.12);
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
