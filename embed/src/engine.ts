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
// Iris clusters (center + 4 rim points). Moving these is what makes a face
// look alive: eyes that only blink read as dead, but eyes that drift and
// dart are read as attentive even when nothing else moves.
const IRIS_CLUSTERS = [
  [468, 469, 470, 471, 472],
  [473, 474, 475, 476, 477],
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
const BLINK_MS = 220;
/** How far the upper-lid VERTICES travel, as a fraction of the way to the
 * lower lid. ZERO on purpose: any sweep at all compresses the eyeball texture
 * downward under the lid cover, and the squashed remnant showing below the
 * descending lid is what reads as a SECOND eye. The cover supplies all of the
 * blink; the mesh must hold the eye still underneath it. */
const LID_VERTEX_SWEEP = 0.0;
const NOD_MS = 650;
const SACCADE_MS = 35;

// How far the iris slides across the eye, as a fraction of eye width.
const GAZE_TRAVEL_X = 0.12;
const GAZE_TRAVEL_Y = 0.07;

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
  private browPulsePhase = 1;
  private nextBrowPulseAt = 0;
  // Gaze: current and target offsets in eye-widths, plus saccade timing.
  private gaze = { x: 0, y: 0 };
  private gazeTarget = { x: 0, y: 0 };
  private nextSaccadeAt = 0;
  // Separate iris layer: sclera colour sampled per eye, iris radius in
  // texture pixels, and the texture->canvas scale factor.
  private eyeLayer: {
    // null for an eye whose sclera could not be identified — see
    // prepareEyeLayer. That eye keeps the photographed iris and forgoes gaze.
    sclera: (string | null)[];
    irisTexRadius: number[];
    texToCanvas: number;
    /** How much taller the DRAWN eye is than the landmarked one, per eye.
     * MediaPipe fits a human template; on stylized art it lands well inside
     * the painted eye, and a lid sized to it covers only part of that eye
     * while borrowing its "skin" from eye artwork — which is what draws a
     * second lash line inside the first. Measured from pixels. */
    lidExtent: number[];
    /** The eyelid's own colour, sampled from the skin just above the eye. */
    lidSkin: string[];
  } | null = null;
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
    this.computeFraming();
    this.subdivideMouthRegion();
    this.prepareEyeLayer();
    this.startTime = performance.now();
    this.nextBlinkAt = this.startTime + 1200 + Math.random() * 2000;
    this.nextNodAt = this.startTime + 2500;
    this.nextBrowPulseAt = this.startTime + 1800 + Math.random() * 2500;
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
    if (now >= this.nextBrowPulseAt) {
      this.nextBrowPulseAt = now + (this.speaking ? 1400 : 3200) + Math.random() * 2800;
      this.browPulsePhase = 0;
    }
    if (this.browPulsePhase < 1) this.browPulsePhase = Math.min(1, this.browPulsePhase + 16 / 500);
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

    // Face geometry for pose layers.
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const fMinX = Math.min(...xs), fMaxX = Math.max(...xs);
    const fMinY = Math.min(...ys), fMaxY = Math.max(...ys);
    const fcx = (fMinX + fMaxX) / 2;
    const fcy = (fMinY + fMaxY) / 2;
    const fw = (fMaxX - fMinX) / 2;
    const fh = (fMaxY - fMinY) / 2;

    // Eased blinks: the upper lid sweeps DOWN to the lower lid (lid skin
    // stretches over the eyeball); the lower lid rises only slightly.
    // Corner points stay pinned, mid-lid points travel furthest.
    if (this.blink > 0) {
      // Asymmetric ease: lids snap shut faster than they reopen.
      const phase = this.blink;
      const amount = phase < 0.4 ? Math.sin((phase / 0.4) * (Math.PI / 2))
                                 : Math.cos(((phase - 0.4) / 0.6) * (Math.PI / 2));
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
          // Only a PARTIAL sweep. Driving these vertices all the way to the
          // lower lid does not cover the eye — their texture coordinates are
          // fixed, so it compresses the EYEBALL texture into a thin band and
          // stretches the brow skin down over it. Rendered, that is a
          // translucent smear with the iris still visible through it, which
          // is exactly what a blink must not look like. The lid itself is
          // drawn as a cover pass in drawBlink(); this just gives the
          // surrounding skin its crease.
          pts[i].y +=
            (eyeBottom - pts[i].y) * amount * LID_VERTEX_SWEEP * (0.15 + 0.85 * centrality);
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
    const browPulse = this.browPulsePhase < 1 ? Math.sin(this.browPulsePhase * Math.PI) : 0;
    const browLift = browPulse * (this.speaking ? 0.45 + this.energy * 0.3 : 0.4);
    for (const brow of [LEFT_BROW, RIGHT_BROW]) {
      for (let j = 0; j < brow.length; j++) {
        const innerness = 1 - j / (brow.length - 1); // inner moves most
        const rest = 0.06 * innerness; // resting browInnerUp
        pts[brow[j]].y -= fh * 0.035 * (browLift * (0.4 + 0.6 * innerness) + rest);
      }
    }

    // Head pose (2.5D): yaw/pitch via radial-parallax dome; nose moves most.
    const idleYaw = Math.sin(t * 0.43) * 0.25 + Math.sin(t * 0.117) * 0.2;
    const idlePitch = Math.sin(t * 0.31 + 1.3) * 0.22;
    const nod = this.nodPhase < 1 ? Math.sin(this.nodPhase * Math.PI) * 0.8 : 0;
    const amp = (0.3 + this.energy * 0.5) * this.tuning.headMotion;
    const yaw = idleYaw * amp * fw * 0.05;
    const pitch = (idlePitch * amp + nod * this.energy) * fh * 0.04;
    for (const p of pts) {
      const dx = (p.x - fcx) / fw;
      const dy = (p.y - fcy) / fh;
      const depth = Math.max(0, 1 - (dx * dx + dy * dy)); // dome: rim ~0, nose ~1
      p.x += yaw * depth;
      p.y += pitch * depth;
    }
    // Nose nudge: it's the closest point to the camera.
    pts[NOSE_TIP].x += yaw * 0.25;

    // Roll about a neck pivot below the chin; breathing sway rides along.
    // Skipped in fullPhoto mode: rolling the whole mesh would tear the rim
    // away from the static photo behind it.
    if (!this.fullPhoto) {
      const roll = (Math.sin(t * 0.27 + 0.7) * 0.012 + Math.sin(t * 0.071) * 0.008) * amp;
      const breathe = Math.sin(t * 0.9) * fh * 0.004;
      const pivotX = fcx;
      const pivotY = fMaxY + fh * 0.35;
      const cosR = Math.cos(roll);
      const sinR = Math.sin(roll);
      for (const p of pts) {
        const rx = p.x - pivotX;
        const ry = p.y - pivotY;
        p.x = pivotX + rx * cosR - ry * sinR;
        p.y = pivotY + rx * sinR + ry * cosR + breathe;
      }
    }

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
    this.drawBlink();
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
   * Measure the iris in texture space and sample a sclera colour per eye,
   * so the iris can be redrawn as its own layer. Needs pixel access to the
   * texture; if that's unavailable (tainted canvas) the eye layer is
   * disabled and the avatar simply renders without gaze.
   */
  private prepareEyeLayer(): void {
    const centers = [468, 473];
    if (!this.texPoints[477]) return; // rig has no iris landmarks
    try {
      const off = document.createElement("canvas");
      off.width = this.texture.naturalWidth;
      off.height = this.texture.naturalHeight;
      const offCtx = off.getContext("2d", { willReadFrequently: true });
      if (!offCtx) return;
      offCtx.drawImage(this.texture, 0, 0);

      const sclera: (string | null)[] = [];
      const irisTexRadius: number[] = [];
      for (let e = 0; e < 2; e++) {
        const c = this.texPoints[centers[e]];
        const rim = IRIS_CLUSTERS[e].slice(1).map((i) => this.texPoints[i]);
        const radius =
          rim.reduce((s, p) => s + Math.hypot(p.x - c.x, p.y - c.y), 0) / rim.length;
        irisTexRadius.push(radius);
        // Sclera colour. Sampling anywhere in the eye-opening polygon does
        // NOT work: measured on a real avatar, the iris is 1.14x TALLER than
        // the opening, so there is no sclera above or below it — the polygon
        // is mostly lash, liner and lid skin, and a brightness percentile
        // over it returned rgb(174,156,142), i.e. beige skin, which then got
        // painted inside the eye. Sclera lives only in two slivers to the
        // LEFT and RIGHT of the iris, level with its centre, so that is the
        // only place worth looking.
        const poly = [...UPPER_LIDS[e], ...LOWER_LIDS[e], ...EYE_CORNERS[e]]
          .map((i) => this.texPoints[i])
          .filter(Boolean);
        const pcx = poly.reduce((s, p) => s + p.x, 0) / poly.length;
        const pcy = poly.reduce((s, p) => s + p.y, 0) / poly.length;
        const ordered = [...poly].sort(
          (p, q) => Math.atan2(p.y - pcy, p.x - pcx) - Math.atan2(q.y - pcy, q.x - pcx)
        );
        const minX = Math.min(...ordered.map((p) => p.x));
        const maxX = Math.max(...ordered.map((p) => p.x));
        const minY = Math.min(...ordered.map((p) => p.y));
        const maxY = Math.max(...ordered.map((p) => p.y));
        const inside = (x: number, y: number) => {
          let hit = false;
          for (let i = 0, j = ordered.length - 1; i < ordered.length; j = i++) {
            const a = ordered[i];
            const b = ordered[j];
            if (
              a.y > y !== b.y > y &&
              x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x
            ) {
              hit = !hit;
            }
          }
          return hit;
        };

        const candidates: Sample[] = [];
        const bandHalf = (maxY - minY) * 0.22; // level with the iris centre
        const STEPS_X = 26;
        const STEPS_Y = 6;
        for (let ix = 0; ix <= STEPS_X; ix++) {
          for (let iy = 0; iy <= STEPS_Y; iy++) {
            const x = minX + ((maxX - minX) * ix) / STEPS_X;
            const y = c.y - bandHalf + (2 * bandHalf * iy) / STEPS_Y;
            if (!inside(x, y)) continue;
            const dx = Math.abs(x - c.x);
            // Outside the iris (plus a margin for landmark error), but inside
            // the eye — not out past the corner, where only skin lives.
            if (dx < radius * 1.15 || dx > (maxX - minX) * 0.46) continue;
            const sx = Math.max(0, Math.min(off.width - 1, Math.round(x)));
            const sy = Math.max(0, Math.min(off.height - 1, Math.round(y)));
            const d = offCtx.getImageData(sx, sy, 1, 1).data;
            const rgb: [number, number, number] = [d[0], d[1], d[2]];
            candidates.push({ lum: luma(rgb), rgb });
          }
        }
        // Reference skin, taken just below the lower lid: it is the same
        // exposure and skin tone as the eye, which is what makes the sclera
        // test work across faces instead of needing absolute thresholds.
        const lidBottom = Math.max(...LOWER_LIDS[e].map((i) => this.texPoints[i]?.y ?? c.y));
        const skinSamples: Sample[] = [];
        for (let ix = -2; ix <= 2; ix++) {
          for (let iy = 1; iy <= 3; iy++) {
            const x = c.x + ix * radius * 0.4;
            const y = lidBottom + iy * radius * 0.45;
            const sx = Math.max(0, Math.min(off.width - 1, Math.round(x)));
            const sy = Math.max(0, Math.min(off.height - 1, Math.round(y)));
            const d = offCtx.getImageData(sx, sy, 1, 1).data;
            const rgb: [number, number, number] = [d[0], d[1], d[2]];
            skinSamples.push({ lum: luma(rgb), rgb });
          }
        }
        skinSamples.sort((a, b) => a.lum - b.lum);
        const skin = skinSamples[Math.floor(skinSamples.length / 2)] ?? null;

        // No credible sclera: leave this eye exactly as photographed. Losing
        // gaze is invisible; painting skin colour inside an eye is not.
        sclera.push(pickScleraColour(candidates, skin));
      }
      // How far the DRAWN eye actually extends above and below the iris.
      // March vertical rays out from the iris centre until the dark eye
      // region gives way to skin; the ratio against the landmarked opening
      // tells the blink how big a lid it really has to draw.
      const lidExtent: number[] = [];
      for (let e = 0; e < 2; e++) {
        const c = this.texPoints[centers[e]];
        const r = irisTexRadius[e];
        const ring = [...UPPER_LIDS[e], ...LOWER_LIDS[e]]
          .map((i) => this.texPoints[i])
          .filter(Boolean);
        const landmarkHalf = Math.max(
          1,
          (Math.max(...ring.map((p) => p.y)) - Math.min(...ring.map((p) => p.y))) / 2
        );
        const lumAt = (x: number, y: number): number => {
          const sx = Math.max(0, Math.min(off.width - 1, Math.round(x)));
          const sy = Math.max(0, Math.min(off.height - 1, Math.round(y)));
          const d = offCtx.getImageData(sx, sy, 1, 1).data;
          return 0.299 * d[0] + 0.587 * d[1] + 0.114 * d[2];
        };
        // Skin reference well outside the eye, and the darkest point on the
        // iris; the eye ends where luma crosses halfway between them.
        const skin = lumAt(c.x, c.y + landmarkHalf * 3.2);
        const dark = Math.min(lumAt(c.x, c.y), lumAt(c.x - r * 0.5, c.y), lumAt(c.x + r * 0.5, c.y));
        const threshold = (skin + dark) / 2;
        let reach = landmarkHalf;
        for (const dx of [-r * 0.5, 0, r * 0.5]) {
          for (const dir of [-1, 1]) {
            for (let t = landmarkHalf; t < landmarkHalf * 2.4; t += 1) {
              if (lumAt(c.x + dx, c.y + dir * t) > threshold) break;
              reach = Math.max(reach, t);
            }
          }
        }
        lidExtent.push(Math.max(1, Math.min(2.0, reach / landmarkHalf)));
      }
      // The lid's own colour, taken from the skin just above each eye. A lid
      // is PAINTED, not blitted: sliding a rectangle of photographed skin
      // over a curved eye reads as a shutter, and stretches its contents by a
      // different amount every frame, which shimmers.
      const lidSkin: string[] = [];
      for (let e = 0; e < 2; e++) {
        // Sample UNDER the eye, not above it. Above the lid is the crease and
        // then the eyebrow, and a median over that returns brow brown — which
        // painted the closed lid as a dark blob stuck on the face. The skin
        // just below the lower lash is the same tone as a closed lid and is
        // free of both brow and lashes.
        const lower = LOWER_LIDS[e].map((i) => this.texPoints[i]).filter(Boolean);
        const base = Math.max(...lower.map((p) => p.y));
        const midX = lower.reduce((s2, p) => s2 + p.x, 0) / lower.length;
        const span = Math.max(4, irisTexRadius[e]);
        const picks: { lum: number; rgb: [number, number, number] }[] = [];
        for (let dx = -1; dx <= 1; dx++) {
          for (let dy = 1; dy <= 3; dy++) {
            const sx = Math.max(0, Math.min(off.width - 1, Math.round(midX + dx * span * 0.6)));
            const sy = Math.max(0, Math.min(off.height - 1, Math.round(base + dy * span * 0.45)));
            const d = offCtx.getImageData(sx, sy, 1, 1).data;
            const rgb: [number, number, number] = [d[0], d[1], d[2]];
            picks.push({ lum: luma(rgb), rgb });
          }
        }
        // Upper-middle of the range: any stray dark sample is a lash or a
        // shadow, and a lid must never come out darker than the face.
        picks.sort((a, b) => a.lum - b.lum);
        const pick = picks[Math.floor(picks.length * 0.7)] ?? picks[picks.length - 1];
        lidSkin.push(pick ? `rgb(${pick.rgb.join(", ")})` : "rgb(214, 184, 166)");
      }
      const texToCanvas = (this.rig.image_size[0] / this.texture.naturalWidth) * this.scale;
      this.eyeLayer = { sclera, irisTexRadius, texToCanvas, lidExtent, lidSkin };
    } catch {
      this.eyeLayer = null; // cross-origin texture: skip the eye layer
    }
  }

  /**
   * Draw the eyelid closing over the eye.
   *
   * A photo has no picture of a closed lid, so one has to be borrowed: the
   * skin immediately ABOVE the eye is eyelid skin, and sliding it down over
   * the opening is both what really happens and the only source of correct
   * pixels. Warping the mesh cannot do this — the eye triangles keep drawing
   * the eyeball no matter where their vertices go, so the eye gets squashed
   * rather than hidden.
   */
  private drawBlink(): void {
    if (this.blink <= 0) return;
    const phase = this.blink;
    const amount =
      phase < 0.4
        ? Math.sin((phase / 0.4) * (Math.PI / 2))
        : Math.cos(((phase - 0.4) / 0.6) * (Math.PI / 2));
    if (amount <= 0.01) return;
    const ctx = this.ctx;
    const layer = this.eyeLayer;

    for (let e = 0; e < 2; e++) {
      // Both lid curves, left to right, in resting position. The lid has to
      // travel along the eye's OWN shape — an eye is an almond, and a
      // straight edge crossing it is the single most artificial thing a
      // blink can do.
      const upper = UPPER_LIDS[e]
        .map((i) => this.basePoints[i])
        .filter(Boolean)
        .slice()
        .sort((a, b) => a.x - b.x);
      const lower = LOWER_LIDS[e]
        .map((i) => this.basePoints[i])
        .filter(Boolean)
        .slice()
        .sort((a, b) => a.x - b.x);
      if (upper.length < 3 || lower.length < 3) continue;

      const [ci, co] = EYE_CORNERS[e].map((i) => this.basePoints[i]);
      if (!ci || !co) continue;
      const left = ci.x <= co.x ? ci : co;
      const right = ci.x <= co.x ? co : ci;
      const cy = (upper.reduce((s2, p) => s2 + p.y, 0) / upper.length +
        lower.reduce((s2, p) => s2 + p.y, 0) / lower.length) / 2;
      // Stylized art draws the eye larger than the landmarks describe; open
      // both curves out to the eye as drawn so the lid covers all of it.
      const grow = layer?.lidExtent?.[e] ?? 1;
      const open = (p: Point) => ({ x: p.x, y: cy + (p.y - cy) * grow });

      // Sample both curves at the same parameter so they can be interpolated.
      const STEPS = 14;
      const sampleAt = (curve: Point[], t: number): Point => {
        const x = left.x + (right.x - left.x) * t;
        let a = curve[0];
        let b = curve[curve.length - 1];
        for (let i = 0; i < curve.length - 1; i++) {
          if (curve[i].x <= x && curve[i + 1].x >= x) {
            a = curve[i];
            b = curve[i + 1];
            break;
          }
        }
        const span = b.x - a.x;
        const f = span > 1e-3 ? (x - a.x) / span : 0;
        return { x, y: a.y + (b.y - a.y) * Math.max(0, Math.min(1, f)) };
      };

      const lidTop: Point[] = [];
      const lidEdge: Point[] = [];
      for (let k = 0; k <= STEPS; k++) {
        const t = k / STEPS;
        const u = open(sampleAt(upper, t));
        const l = open(sampleAt(lower, t));
        lidTop.push(u);
        // The corners are anchored: a real lid pivots there and sweeps most
        // in the middle, which is also what keeps the almond shape.
        const pinned = Math.sin(Math.PI * t) ** 0.55;
        lidEdge.push({ x: u.x, y: u.y + (l.y - u.y) * amount * (0.25 + 0.75 * pinned) });
      }

      // The lid itself: the band between where the lid rests and where its
      // edge has reached, filled with the eyelid's own colour.
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(lidTop[0].x, lidTop[0].y - 1);
      for (const p of lidTop) ctx.lineTo(p.x, p.y - 1);
      for (let k = lidEdge.length - 1; k >= 0; k--) ctx.lineTo(lidEdge[k].x, lidEdge[k].y);
      ctx.closePath();

      const top = Math.min(...lidTop.map((p) => p.y));
      const bottom = Math.max(...lidEdge.map((p) => p.y));
      const skin = layer?.lidSkin?.[e] ?? "rgb(214, 184, 166)";
      if (bottom > top + 0.5) {
        // Slightly shaded toward the edge: the lid curves away from the light
        // as it comes down, and a flat fill reads as paper.
        const shade = ctx.createLinearGradient(0, top, 0, bottom);
        shade.addColorStop(0, "rgba(255, 255, 255, 0.10)");
        shade.addColorStop(0.6, "rgba(0, 0, 0, 0)");
        shade.addColorStop(1, "rgba(0, 0, 0, 0.16)");
        ctx.fillStyle = skin;
        ctx.fill();
        // A gentle roll: catch light on the upper curve, shade into the
        // crease at the edge. Anything stronger and the lid reads as a patch.
        ctx.fillStyle = shade;
        ctx.fill();
      } else {
        ctx.fillStyle = skin;
        ctx.fill();
      }
      ctx.restore();

      // The lash line rides the leading edge, and only once fully drawn.
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(lidEdge[0].x, lidEdge[0].y);
      for (const p of lidEdge) ctx.lineTo(p.x, p.y);
      ctx.strokeStyle = `rgba(46, 28, 24, ${(0.72 * amount).toFixed(3)})`;
      ctx.lineWidth = Math.max(1, (bottom - top) * 0.06 + 1);
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.stroke();
      ctx.restore();
    }
  }

  /**
   * Draw each iris as its own layer inside the eye opening: repaint the
   * socket with sclera, then stamp the iris disc at the gaze offset. This
   * is what lets the eye actually LOOK somewhere — warping the mesh can
   * only smear it.
   */
  private drawEyes(pts: Point[]): void {
    const layer = this.eyeLayer;
    if (!layer) return;
    const blinkAmount = this.blink > 0 ? Math.sin(this.blink * Math.PI) : 0;
    if (blinkAmount > 0.35) return; // the lid cover owns the eye from here
    const ctx = this.ctx;
    const centers = [468, 473];

    for (let e = 0; e < 2; e++) {
      const ringIdx = [...UPPER_LIDS[e], ...LOWER_LIDS[e], ...EYE_CORNERS[e]];
      const ring = ringIdx.map((i) => pts[i]).filter(Boolean);
      if (ring.length < 6) continue;
      const cx = ring.reduce((s, p) => s + p.x, 0) / ring.length;
      const cy = ring.reduce((s, p) => s + p.y, 0) / ring.length;
      // Angle-sort so the opening is a simple polygon (index order isn't).
      const sorted = [...ring].sort(
        (p, q) => Math.atan2(p.y - cy, p.x - cx) - Math.atan2(q.y - cy, q.x - cx)
      );
      const xs = sorted.map((p) => p.x);
      const ys = sorted.map((p) => p.y);
      const openW = Math.max(...xs) - Math.min(...xs);
      const openH = Math.max(...ys) - Math.min(...ys);
      if (openW < 3 || openH < 2) continue;

      const scleraColour = layer.sclera[e];
      if (!scleraColour) continue; // no readable sclera — keep the photo
      const irisR = layer.irisTexRadius[e] * layer.texToCanvas;
      if (irisR < 1) continue;
      const base = pts[centers[e]];
      if (!base) continue;
      // A human iris travels only ~2-3mm, roughly 0.12 of eye width, before
      // the eye gives up and the head turns. The old 0.22 pushed the iris
      // past the sclera that exists to uncover, so it clipped against the
      // lid and the vacated area became larger than the eye could explain.
      const gx = this.gaze.x * openW * GAZE_TRAVEL_X * (1 - blinkAmount);
      const gy = this.gaze.y * openW * GAZE_TRAVEL_Y * (1 - blinkAmount);
      // At rest, touch NOTHING: the mesh already drew the real eye, which
      // is always more correct than anything we can repaint. Only when the
      // iris actually needs to move do we patch it.
      if (Math.hypot(gx, gy) < 0.6) continue;

      ctx.save();
      // Clip to the eye opening: the iris can never escape the socket.
      ctx.beginPath();
      ctx.moveTo(sorted[0].x, sorted[0].y);
      for (let i = 1; i < sorted.length; i++) ctx.lineTo(sorted[i].x, sorted[i].y);
      ctx.closePath();
      ctx.clip();

      // Cover ONLY the original iris (not the whole socket): lashes, tear
      // duct, lid shading and corners stay as photographed. The cover is
      // slightly larger than the measured iris so an imperfect landmark
      // radius can't leave a rim of the old iris behind.
      //
      // Cover it with REAL sclera pixels, not a flat colour. A flat disc was
      // the visible defect here: the cover is ~58px across on a ~48px-tall
      // opening, so once clipped to the lid it became a hard-edged wedge of
      // uniform paint over half the eye — a sticker, not an eyeball. Instead
      // take a thin VERTICAL strip of the eye from the side the iris is
      // moving away from (which is sclera in the original) and stretch it
      // horizontally across the vacated area. Stretching sideways preserves
      // the vertical gradient — the shadow the upper lid casts on the top of
      // the eyeball — which is most of what makes an eye read as wet and
      // recessed rather than painted on.
      const texC = this.texPoints[centers[e]];
      const texR = layer.irisTexRadius[e];
      const texRing = [...UPPER_LIDS[e], ...LOWER_LIDS[e], ...EYE_CORNERS[e]]
        .map((i) => this.texPoints[i])
        .filter(Boolean);
      const texTop = Math.min(...texRing.map((p) => p.y));
      const texBottom = Math.max(...texRing.map((p) => p.y));
      const texLeft = Math.min(...texRing.map((p) => p.x));
      const texRight = Math.max(...texRing.map((p) => p.x));
      const canvasTop = Math.min(...ys);
      const canvasBottom = Math.max(...ys);
      const stripW = Math.max(2, texR * 0.3);
      // The vacated side is opposite the direction of travel.
      const away = gx >= 0 ? -1 : 1;
      const stripCx = Math.max(
        texLeft + stripW / 2,
        Math.min(texRight - stripW / 2, texC.x + away * texR * 1.5)
      );
      ctx.save();
      ctx.beginPath();
      ctx.arc(base.x, base.y, irisR * 1.18, 0, Math.PI * 2);
      ctx.clip();
      // Fall back to the sampled flat colour only if the strip would be
      // degenerate (a landmark collapse), so there is always something sane.
      if (texBottom - texTop > 1 && canvasBottom - canvasTop > 1) {
        ctx.drawImage(
          this.texture,
          stripCx - stripW / 2,
          texTop,
          stripW,
          texBottom - texTop,
          base.x - irisR * 1.4,
          canvasTop,
          irisR * 2.8,
          canvasBottom - canvasTop
        );
      } else {
        ctx.fillStyle = scleraColour;
        ctx.fill();
      }
      ctx.restore();

      // Stamp the iris at its new position.
      ctx.save();
      ctx.beginPath();
      ctx.arc(base.x + gx, base.y + gy, irisR, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(
        this.texture,
        texC.x - texR * 1.15,
        texC.y - texR * 1.15,
        texR * 2.3,
        texR * 2.3,
        base.x + gx - irisR * 1.15,
        base.y + gy - irisR * 1.15,
        irisR * 2.3,
        irisR * 2.3
      );
      ctx.restore();
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
    cavity.addColorStop(0, "#1b0908");
    cavity.addColorStop(0.55, "#3a1512");
    cavity.addColorStop(1, "#55201a");
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
