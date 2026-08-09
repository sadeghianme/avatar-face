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
import { HeadPose, HEAD_PITCH_MAX, HEAD_ROLL_MAX, HEAD_YAW_MAX } from "./headpose";
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
const NOSE_TIP = 4;

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
const NOD_MS = 650;

/**
 * Indices of the points on the convex hull, counter-clockwise.
 *
 * Andrew's monotone chain. Used to find an ordered boundary loop around the
 * face landmarks to grow the head shell from — the mesh's own outline is not
 * stored as a loop anywhere, and the hull of a face's landmarks is its
 * silhouette, which is exactly what needs extending.
 */
function convexHullIndices(points: { x: number; y: number }[]): number[] {
  const order = points.map((_, i) => i).sort((a, b) =>
    points[a].x - points[b].x || points[a].y - points[b].y
  );
  const cross = (o: number, a: number, b: number) =>
    (points[a].x - points[o].x) * (points[b].y - points[o].y) -
    (points[a].y - points[o].y) * (points[b].x - points[o].x);

  const build = (seq: number[]) => {
    const out: number[] = [];
    for (const i of seq) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], i) <= 0) {
        out.pop();
      }
      out.push(i);
    }
    out.pop(); // shared with the other half
    return out;
  };
  return [...build(order), ...build([...order].reverse())];
}

// --- Head pose -------------------------------------------------------------
//
// Rotation is modelled as a cylinder rather than as a sideways slide. Turning
// a head does not translate the features: the side turning away compresses
// and the side turning towards you spreads out. That foreshortening is most
// of what makes a turn read as a turn, and a pure translation reads as the
// face sliding around inside the head.
//
// The model also pins the silhouette for free. At the edge of the face the
// mapping is sin(±pi/2 + angle) = cos(angle), which changes only to second
// order in the angle — so the outline barely moves while the nose moves a
// lot, which is exactly what a real head does and what stops the mesh from
// tearing away from the still photograph behind it.

/**
 * The head shell: rings of extra vertices grown outward from the face.
 *
 * The landmark mesh covers the face and stops at the jaw and hairline, so
 * warping it turns the face inside a head that stays put — the features move
 * and the hair, ears and skull do not, which reads as a mask sliding about
 * rather than as someone turning their head.
 *
 * These rings extend the mesh over the hair and out into the surroundings.
 * Everything inside the first ring moves as one piece; the outermost ring is
 * pinned, so the annulus between them absorbs the motion and the mesh still
 * meets the untouched photograph exactly where it did before. The ring must
 * also enclose the whole head — the still photo is drawn underneath, so any
 * part of the original head the mesh fails to cover shows through as a ghost.
 *
 * Each entry is [outward scale, how freely it moves].
 */
const HEAD_SHELL_RINGS: [number, number][] = [
  [1.45, 1.0], // over the hair: still fully part of the head
  [1.78, 0.55],
  [2.15, 0.0], // pinned to the photograph
];

/**
 * How much less the rings grow downward than upward.
 *
 * A head ends at the chin, but it continues into a neck and shoulders that
 * must not swing with it. Growing the rings evenly would sweep the collar
 * along with the jaw.
 */
const HEAD_SHELL_DOWNWARD_DAMP = 0.82;

/** The head's centre of mass sits above the face landmarks, in the skull. */
const HEAD_CENTRE_RISE = 0.22;
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
  private head = new HeadPose();
  /** Per-vertex freedom to move: 1 across the head, 0 at the outer ring. */
  private headFalloff: Float32Array | null = null;
  private shellTriangles: [number, number, number][] = [];
  private headCentre = { x: 0, y: 0 };
  private headHalf = { x: 1, y: 1 };
  private headBottom = 0;
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
    this.rebuildGeometry();
    this.sampleLipColour();
    this.sampleLashColour();
    this.startTime = performance.now();
    this.nextBlinkAt = this.startTime + 1200 + Math.random() * 2000;
    this.nextNodAt = this.startTime + 2500;
    this.nextSaccadeAt = this.startTime + 600 + Math.random() * 1200;
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
    // Debug handle (last engine wins): lets a console force blinks/visemes.
    (globalThis as { __liveface?: AvatarEngine }).__liveface = this;
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
  }

  /**
   * Rebuild everything derived from the rig and the texture, in order.
   *
   * The order is load-bearing. The shell appends vertices, and the mouth
   * subdivision numbers its midpoints from basePoints.length — so the shell
   * has to exist first or every subdivided index is off by the shell's size.
   * Subdivision then rebuilds the triangle list from the rig, which is why
   * the shell's own triangles are re-appended afterwards.
   */
  private rebuildGeometry(): void {
    this.derivedParents = [];
    this.computeFraming();
    this.buildHeadShell();
    this.subdivideMouthRegion();
    this.triangles.push(...this.shellTriangles);
  }

  /**
   * Swap in a different image of the same face, mid-animation.
   *
   * Used to upgrade from the thumbnail the widget starts with to the
   * full-resolution photograph once it arrives. Everything derived from the
   * pixels has to be recomputed: texture coordinates are in the texture's own
   * pixels, and the lip and lash colours were sampled from the old one.
   *
   * The rig is untouched — it is in image-space and both images are the same
   * face at different scales, so no landmark moves.
   */
  setTexture(texture: HTMLImageElement): void {
    if (!texture.naturalWidth || !texture.naturalHeight) return;
    this.texture = texture;
    this.rebuildGeometry();
    this.sampleLipColour();
    this.sampleLashColour();
  }

  /**
   * Grow the mesh outward from the face so the whole head moves with it.
   *
   * Works entirely in image space and converts at the end, so a ring vertex
   * and its texture coordinate come from the same clamped point — at rest the
   * shell reproduces the photograph exactly, which is what makes the addition
   * invisible until something actually moves.
   */
  private buildHeadShell(): void {
    const faceCount = this.rig.points.length;
    const face = this.rig.points.map(([x, y]) => ({ x, y }));
    const loop = convexHullIndices(face);
    const [imageW, imageH] = this.rig.image_size;

    const xs = face.map((p) => p.x);
    const ys = face.map((p) => p.y);
    const centre = {
      x: (Math.min(...xs) + Math.max(...xs)) / 2,
      // Rotation belongs to the skull, which sits above the landmarks: they
      // stop at the brow, and everything above it is hair.
      y:
        (Math.min(...ys) + Math.max(...ys)) / 2 -
        (Math.max(...ys) - Math.min(...ys)) * HEAD_CENTRE_RISE,
    };

    const falloff = new Float32Array(faceCount + loop.length * HEAD_SHELL_RINGS.length);
    falloff.fill(1, 0, faceCount); // the face is all head: it moves as one piece

    const rings: number[][] = [];
    for (const [scale, freedom] of HEAD_SHELL_RINGS) {
      const ring: number[] = [];
      for (const index of loop) {
        const dx = face[index].x - centre.x;
        const dy = face[index].y - centre.y;
        const length = Math.hypot(dx, dy) || 1;
        // Downward growth is damped so the ring stops at the neck instead of
        // reaching the shoulders.
        const downward = Math.max(0, dy / length);
        const k = 1 + (scale - 1) * (1 - downward * HEAD_SHELL_DOWNWARD_DAMP);
        const point = {
          x: Math.max(0, Math.min(imageW, centre.x + dx * k)),
          y: Math.max(0, Math.min(imageH, centre.y + dy * k)),
        };
        const at = this.basePoints.length;
        this.basePoints.push({
          x: point.x * this.scale + this.offsetX,
          y: point.y * this.scale + this.offsetY,
        });
        this.texPoints.push({
          x: (point.x * this.texture.naturalWidth) / imageW,
          y: (point.y * this.texture.naturalHeight) / imageH,
        });
        falloff[at] = freedom;
        ring.push(at);
      }
      rings.push(ring);
    }

    // Stitch each gap into a quad strip. Every ring shares the loop's
    // ordering, so ring[j] and ring[j+1] are the same direction from centre
    // and the triangles never cross.
    this.shellTriangles = [];
    const bands = [loop, ...rings];
    for (let b = 0; b < bands.length - 1; b++) {
      const inner = bands[b];
      const outer = bands[b + 1];
      for (let j = 0; j < inner.length; j++) {
        const k = (j + 1) % inner.length;
        this.shellTriangles.push(
          [inner[j], outer[j], outer[k]],
          [inner[j], outer[k], inner[k]]
        );
      }
    }

    this.headFalloff = falloff;
    // Metrics for the rotation itself, in canvas space, measured on the ring
    // that bounds the head — so the cylinder spans the head and not the face.
    const shell = rings[0].map((i) => this.basePoints[i]);
    const sx = shell.map((p) => p.x);
    const sy = shell.map((p) => p.y);
    this.headCentre = {
      x: centre.x * this.scale + this.offsetX,
      y: centre.y * this.scale + this.offsetY,
    };
    this.headHalf = {
      x: Math.max(1, (Math.max(...sx) - Math.min(...sx)) / 2),
      y: Math.max(1, (Math.max(...sy) - Math.min(...sy)) / 2),
    };
    this.headBottom = Math.max(...sy);
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

    this.head.update(dt, now, this.speaking);

    // Saccades: eyes jump to a new fixation, then hold. While speaking the
    // gaze returns near-center more often (engaged with the listener);
    // idle gaze wanders further and rests longer.
    if (now >= this.nextSaccadeAt) {
      const speaking = this.speaking;
      this.nextSaccadeAt = now + (speaking ? 900 : 1400) + Math.random() * (speaking ? 1600 : 2600);
      // Most fixations return to the viewer; only some wander. A face that
      // is usually looking somewhere else reads as distracted, not alive.
      const spread = speaking ? 0.12 : 0.18;
      const lookAway = Math.random() < (speaking ? 0.35 : 0.5);
      this.gazeTarget = lookAway
        ? { x: (Math.random() * 2 - 1) * spread, y: (Math.random() * 2 - 1) * spread * 0.5 }
        : { x: 0, y: 0 };
    }
    // Saccades are ballistic: fast jump, then a still fixation.
    // A saccade is ballistic and fast — ~35ms to cross, whatever the frame rate.
    const saccadeRate = 1 - Math.exp(-dt / SACCADE_MS);
    this.gaze.x += (this.gazeTarget.x - this.gaze.x) * saccadeRate;
    this.gaze.y += (this.gazeTarget.y - this.gaze.y) * saccadeRate;

    // Brow pulses: idle micro-expressions + emphasis while speaking.
  }

  // --- Deformation -----------------------------------------------------------

  private deformedPoints(now: number): Point[] {
    const t = (now - this.startTime) / 1000;
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

    // Face geometry for pose layers — measured over the LANDMARKS only. The
    // head shell is appended after them, and letting its rings into this
    // would silently rescale every layer that works in face-widths: blink
    // sweep, brow lift, cheek bulge.
    const faceCount = this.rig.points.length;
    const xs = [], ys = [];
    for (let i = 0; i < faceCount; i++) { xs.push(pts[i].x); ys.push(pts[i].y); }
    const fMinX = Math.min(...xs), fMaxX = Math.max(...xs);
    const fMinY = Math.min(...ys), fMaxY = Math.max(...ys);
    const fw = (fMaxX - fMinX) / 2;
    const fh = (fMaxY - fMinY) / 2;

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

    // --- Head pose ---------------------------------------------------------
    //
    // Yaw and pitch rotate the face as a cylinder (see HEAD_YAW_MAX): the far
    // side foreshortens, the near side spreads, and the silhouette holds
    // still. Roll then rotates the result about a pivot in the neck.
    //
    // A slow drift rides on top of the sprung pose so the head is never
    // perfectly frozen between movements — a completely static face between
    // gestures looks like a paused video.
    const amp = (0.7 + this.energy * 0.3) * this.tuning.headMotion;
    const driftYaw = Math.sin(t * 0.19) * 0.10 + Math.sin(t * 0.073 + 1.1) * 0.07;
    const driftPitch = Math.sin(t * 0.14 + 2.2) * 0.09;
    // Breathing: the chest lifts, so the head rises fractionally with it.
    const breathe = Math.sin(t * 0.62) * fh * 0.005;
    const nod = this.nodPhase < 1 ? Math.sin(this.nodPhase * Math.PI) * 0.8 : 0;

    const yawAngle = (this.head.yaw + driftYaw) * HEAD_YAW_MAX * amp;
    const pitchAngle =
      ((this.head.pitch + driftPitch) * HEAD_PITCH_MAX + nod * this.energy * 0.05) * amp;
    const rollAngle = (this.head.roll * HEAD_ROLL_MAX) * amp;

    const cosRoll = Math.cos(rollAngle);
    const sinRoll = Math.sin(rollAngle);
    // Normalised against the head, not the face: the cylinder has to span
    // hair and skull too, or the shell vertices all sit past its edge and
    // the hair stops rotating with the features inside it.
    const hcx = this.headCentre.x;
    const hcy = this.headCentre.y;
    const hhw = this.headHalf.x;
    const hhh = this.headHalf.y;
    const pivotX = hcx;
    const pivotY = this.headBottom + hhh * 0.28;
    const falloff = this.headFalloff;

    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      // Vertices past the mesh rim are pinned, so the warp never pulls away
      // from the photograph it sits on.
      const free = falloff ? falloff[Math.min(i, falloff.length - 1)] : 1;
      if (free <= 0.0005) continue;

      const startX = p.x;
      const startY = p.y;

      // Cylindrical yaw. asin maps the face across a half-turn of the
      // cylinder, so adding the angle and taking sin again gives correct
      // foreshortening rather than a uniform slide.
      const u = Math.max(-1, Math.min(1, (p.x - hcx) / hhw));
      let x = hcx + Math.sin(Math.asin(u) + yawAngle) * hhw;
      const v = Math.max(-1, Math.min(1, (p.y - hcy) / hhh));
      let y = hcy + Math.sin(Math.asin(v) + pitchAngle) * hhh;

      // Roll about the neck, not about the face centre: a head pivots where
      // it meets the spine, so rolling around its own middle looks like the
      // face rotating inside the skull.
      const rx = x - pivotX;
      const ry = y - pivotY;
      x = pivotX + rx * cosRoll - ry * sinRoll;
      y = pivotY + rx * sinRoll + ry * cosRoll + breathe;

      p.x = startX + (x - startX) * free;
      p.y = startY + (y - startY) * free;
    }

    // The nose is the part of a face closest to the camera, so it swings
    // furthest on a turn. Everything else is on the cylinder's surface; this
    // is the one feature that stands off it.
    const noseFree = falloff ? falloff[NOSE_TIP] : 1;
    pts[NOSE_TIP].x += Math.sin(yawAngle) * fw * 0.10 * noseFree;
    pts[NOSE_TIP].y += Math.sin(pitchAngle) * fh * 0.06 * noseFree;

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

    for (const [a, b, c] of this.triangles) {
      this.drawWarpedTriangle(pts, a, b, c);
    }

    this.drawEyes(pts);
    this.drawLashes(pts);
    this.drawLipContactLine(pts);
    this.drawMouthInterior(pts);

    if (this.debugMesh) this.drawDebugMesh(pts);
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

  private drawEyes(_pts: Point[]): void {
    // Deliberately does nothing.
    //
    // This used to slide the iris for gaze by covering the old one and
    // re-stamping it. Every version of that broke on some real avatar: on a
    // portrait whose iris is 9.9 texture px the re-stamp upscales into a flat
    // grey disc, and on painted eyes the artwork's own catchlight gets
    // stamped a second time, so one eye ends up with two highlights.
    //
    // The eye is the highest-contrast thing on a face and the first place a
    // viewer looks, so anything repainted there is noticed immediately. There
    // is no version of "invent iris pixels" that survives contact with
    // arbitrary uploads. The eye is left exactly as photographed; gaze now
    // reads through head motion instead, which costs nothing and never lies.
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
