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
const MIN_CUE_MS = 110;

export function prepareCues(cues: Cue[]): Cue[] {
  if (cues.length <= 2) return cues;
  const out: Cue[] = [];
  for (const cue of cues) {
    const last = out[out.length - 1];
    if (last && cue.t - last.t < MIN_CUE_MS) {
      // Collides with the previous keyframe: vowels win (they carry the
      // jaw motion); otherwise keep the existing one.
      if (VOWEL_VISEMES.has(cue.viseme) && !VOWEL_VISEMES.has(last.viseme)) {
        last.viseme = cue.viseme;
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
    out.push({ t: Math.max(end.t, (lastOut?.t ?? 0) + 1), viseme: "sil" });
  }
  return out;
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
    sclera: string[];
    irisTexRadius: number[];
    texToCanvas: number;
  } | null = null;
  private raf = 0;
  private startTime = 0;

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
    const curr = { ...ZERO_WEIGHTS, ...(this.rig.visemes[this.cues[index].viseme] ?? {}) };
    const next = this.cues[index + 1];
    if (!next || next.t <= this.cues[index].t) return curr;
    const target = { ...ZERO_WEIGHTS, ...(this.rig.visemes[next.viseme] ?? {}) };
    const f = Math.min(1, Math.max(0, (t - this.cues[index].t) / (next.t - this.cues[index].t)));
    const out = { ...ZERO_WEIGHTS };
    for (const key of Object.keys(out) as (keyof BlendWeights)[]) {
      out[key] = curr[key] + (target[key] - curr[key]) * f;
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
    const keys = Object.keys(this.weights) as (keyof BlendWeights)[];
    for (const key of keys) {
      const target = this.targetWeights[key];
      const rate = Math.min(
        0.6,
        (target > this.weights[key] ? 0.28 : 0.16) * this.tuning.smoothness
      );
      this.weights[key] += (target - this.weights[key]) * rate;
    }

    // Speech energy (drives head pose amplitude).
    const instant = this.speaking
      ? Math.min(1, this.weights.jawOpen + this.weights.mouthStretch * 0.5 + this.amplitude())
      : 0;
    this.energy += (instant - this.energy) * 0.06;

    // Eased (sin-curve) blinks.
    if (now >= this.nextBlinkAt) {
      this.nextBlinkAt = now + 2200 + Math.random() * 3200;
      this.blink = 0.0001; // arm
    }
    if (this.blink > 0) {
      this.blink += 16 / 220; // ~220ms full blink
      if (this.blink >= 1) this.blink = 0;
    }

    // Gentle nods on a loose cadence while speaking.
    if (this.speaking && now >= this.nextNodAt) {
      this.nextNodAt = now + 1800 + Math.random() * 2600;
      this.nodPhase = 0;
    }
    if (this.nodPhase < 1) this.nodPhase = Math.min(1, this.nodPhase + 16 / 650);

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
    this.gaze.x += (this.gazeTarget.x - this.gaze.x) * 0.35;
    this.gaze.y += (this.gazeTarget.y - this.gaze.y) * 0.35;

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

    // Blendshape-driven 2D deformation basis on mouth landmarks.
    // Amplitudes are deliberately small — newsreader articulation: lips
    // mostly shape sounds, the jaw barely drops.
    for (const i of mouthIdx) {
      const nx = (pts[i].x - mcx) / (mw / 2); // -1..1 across the mouth
      const ny = (pts[i].y - mcy) / (mh / 2);
      let dx = 0;
      let dy = 0;
      // jawOpen: lower lip drops (scaled by how low the point sits).
      if (ny > 0) dy += w.jawOpen * mh * 0.4 * Math.min(1, ny);
      else dy -= w.jawOpen * mh * 0.06 * -ny; // upper lip lifts slightly
      // pucker/funnel: narrow horizontally, push lips toward an "O".
      dx -= (w.mouthPucker * 0.18 + w.mouthFunnel * 0.1) * nx * (mw / 2);
      if (ny < 0) dy -= w.mouthFunnel * mh * 0.07;
      // stretch/smile: widen; smile lifts the corners.
      dx += (w.mouthStretch * 0.12 + w.mouthSmile * 0.07) * nx * (mw / 2);
      if (Math.abs(nx) > 0.55) dy -= w.mouthSmile * mh * 0.16 * (Math.abs(nx) - 0.55);
      // mouthClose: collapse inner ring toward the lip line.
      if (innerSet.has(i)) dy += (mcy - pts[i].y) * w.mouthClose * 0.8;
      pts[i].x += dx * this.tuning.mouthOpen;
      pts[i].y += dy * this.tuning.mouthOpen;
    }

    // Chin/jaw follows jawOpen with radial falloff below the mouth; cheeks
    // beside the corners bulge outward slightly as the jaw opens.
    if (w.jawOpen > 0.01) {
      const mouthSet = new Set(mouthIdx);
      for (let i = 0; i < pts.length; i++) {
        if (mouthSet.has(i)) continue;
        const dx = pts[i].x - mcx;
        const dyFromMouth = pts[i].y - mcy;
        if (dyFromMouth > 0) {
          const dist = Math.hypot(dx, dyFromMouth);
          const falloff = Math.max(0, 1 - dist / (mw * 1.4));
          pts[i].y += w.jawOpen * mh * 0.3 * falloff * this.tuning.mouthOpen;
        }
        // Cheek bulge: lateral points near mouth height push outward.
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
          pts[i].y += (eyeBottom - pts[i].y) * amount * (0.15 + 0.85 * centrality);
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

      const sclera: string[] = [];
      const irisTexRadius: number[] = [];
      for (let e = 0; e < 2; e++) {
        const c = this.texPoints[centers[e]];
        const rim = IRIS_CLUSTERS[e].slice(1).map((i) => this.texPoints[i]);
        const radius =
          rim.reduce((s, p) => s + Math.hypot(p.x - c.x, p.y - c.y), 0) / rim.length;
        irisTexRadius.push(radius);
        // Sclera: sample a grid strictly INSIDE the eye-opening polygon,
        // skipping the iris disc, and take a high percentile brightness.
        // Sampling by radius alone lands on lashes/liner and comes back
        // muddy; the polygon keeps every sample on actual eye.
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

        const candidates: { lum: number; rgb: [number, number, number] }[] = [];
        const steps = 12;
        for (let ix = 0; ix <= steps; ix++) {
          for (let iy = 0; iy <= steps; iy++) {
            const x = minX + ((maxX - minX) * ix) / steps;
            const y = minY + ((maxY - minY) * iy) / steps;
            if (!inside(x, y)) continue;
            if (Math.hypot(x - c.x, y - c.y) < radius * 1.08) continue; // iris
            const sx = Math.max(0, Math.min(off.width - 1, Math.round(x)));
            const sy = Math.max(0, Math.min(off.height - 1, Math.round(y)));
            const d = offCtx.getImageData(sx, sy, 1, 1).data;
            candidates.push({
              lum: 0.299 * d[0] + 0.587 * d[1] + 0.114 * d[2],
              rgb: [d[0], d[1], d[2]],
            });
          }
        }
        candidates.sort((a, b) => a.lum - b.lum);
        // 85th percentile: the sclera, without catching a specular highlight.
        const pick = candidates[Math.floor(candidates.length * 0.85)];
        const [r, g, b] = pick?.rgb ?? [225, 223, 220];
        sclera.push(`rgb(${r}, ${g}, ${b})`);
      }
      const texToCanvas = (this.rig.image_size[0] / this.texture.naturalWidth) * this.scale;
      this.eyeLayer = { sclera, irisTexRadius, texToCanvas };
    } catch {
      this.eyeLayer = null; // cross-origin texture: skip the eye layer
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
    if (blinkAmount > 0.75) return; // lid is covering the eye
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

      const irisR = layer.irisTexRadius[e] * layer.texToCanvas;
      if (irisR < 1) continue;
      const base = pts[centers[e]];
      if (!base) continue;
      const gx = this.gaze.x * openW * 0.22 * (1 - blinkAmount);
      const gy = this.gaze.y * openW * 0.12 * (1 - blinkAmount);
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
      ctx.fillStyle = layer.sclera[e];
      ctx.beginPath();
      ctx.arc(base.x, base.y, irisR * 1.18, 0, Math.PI * 2);
      ctx.fill();

      // Stamp the iris at its new position.
      const texC = this.texPoints[centers[e]];
      const texR = layer.irisTexRadius[e];
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
  private drawMouthInterior(pts: Point[]): void {
    if (this.innerRing.length < 6) return;
    const ctx = this.ctx;
    const ring = this.innerRing.map((i) => pts[i]);
    const cx = ring.reduce((s, p) => s + p.x, 0) / ring.length;
    const cy = ring.reduce((s, p) => s + p.y, 0) / ring.length;

    // The cavity only opens with the jaw: at rest the lips are closed even
    // if the rig's inner ring has geometric height (the synthetic rig's
    // does), so squash the ring toward its centerline by openness.
    const openness = Math.min(
      1,
      this.weights.jawOpen * 1.3 +
        this.weights.mouthFunnel * 0.25 -
        this.weights.mouthClose * 0.6
    );
    if (openness < 0.12) return;
    const squash = 0.1 + 0.9 * openness;
    // Fade the interior in over a range so it never pops, and only draw
    // teeth/tongue when the mouth is genuinely open — a thin part shows a
    // soft dark line, not a flickering teeth strip.
    const interiorAlpha = Math.min(1, (openness - 0.12) / 0.15);
    // Teeth only peek on wide-open sounds; most speech shows just the
    // dark interior, like a real mouth at conversation distance.
    const showTeeth = openness > this.tuning.teethThreshold;

    // ANGLE-SORT around the centroid — raw index order self-intersects.
    const sorted = [...ring]
      .sort((p, q) => Math.atan2(p.y - cy, p.x - cx) - Math.atan2(q.y - cy, q.x - cx))
      .map((p) => ({ x: p.x, y: cy + (p.y - cy) * squash }));

    const xs = sorted.map((p) => p.x);
    const ys = sorted.map((p) => p.y);
    const mouthW = Math.max(...xs) - Math.min(...xs);
    const mouthH = Math.max(...ys) - Math.min(...ys);
    if (mouthW < 2 || mouthH < 1.5) return; // mouth effectively closed

    ctx.save();
    // Smooth quadratic path through midpoints.
    ctx.beginPath();
    const mid = (p: Point, q: Point) => ({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 });
    let prev = sorted[sorted.length - 1];
    let start = mid(prev, sorted[0]);
    ctx.moveTo(start.x, start.y);
    for (let i = 0; i < sorted.length; i++) {
      const curr = sorted[i];
      const next = sorted[(i + 1) % sorted.length];
      const m = mid(curr, next);
      ctx.quadraticCurveTo(curr.x, curr.y, m.x, m.y);
    }
    ctx.closePath();
    ctx.clip();
    ctx.globalAlpha = interiorAlpha;

    // Cavity base.
    ctx.fillStyle = "#270d0c";
    ctx.fillRect(cx - mouthW, cy - mouthH, mouthW * 2, mouthH * 2);

    const jaw = this.weights.jawOpen;
    const upperY = cy - mouthH / 2;
    const lowerY = cy + mouthH / 2;
    // Short upper band only — at conversation distance you don't see
    // distinct teeth or a lower row, just a soft light strip under the lip.
    const toothH = mouthW * this.tuning.teethHeight;

    if (showTeeth) {
      const teethAlpha = Math.min(1, (openness - this.tuning.teethThreshold) / 0.2);
      ctx.save();
      ctx.globalAlpha = interiorAlpha * teethAlpha * 0.9;
      // Single rounded band, slightly narrower than the mouth.
      const bandW = mouthW * 0.82;
      ctx.fillStyle = "#e9e2d6";
      ctx.beginPath();
      ctx.moveTo(cx - bandW / 2, upperY);
      ctx.lineTo(cx + bandW / 2, upperY);
      ctx.quadraticCurveTo(cx + bandW / 2, upperY + toothH, cx + bandW * 0.4, upperY + toothH);
      ctx.lineTo(cx - bandW * 0.4, upperY + toothH);
      ctx.quadraticCurveTo(cx - bandW / 2, upperY + toothH, cx - bandW / 2, upperY);
      ctx.closePath();
      ctx.fill();
      // Faint tooth separations, barely-there.
      ctx.strokeStyle = "rgba(120, 90, 80, 0.18)";
      ctx.lineWidth = Math.max(0.5, mouthW * 0.006);
      for (let i = 1; i < 6; i++) {
        const tx = cx - bandW / 2 + (bandW * i) / 6;
        ctx.beginPath();
        ctx.moveTo(tx, upperY + toothH * 0.15);
        ctx.lineTo(tx, upperY + toothH * 0.85);
        ctx.stroke();
      }
      ctx.restore();
      ctx.globalAlpha = interiorAlpha;
    }

    // Tongue rises with jaw opening; center groove when open.
    if (showTeeth && jaw > 0.12) {
      const tongueH = mouthH * (0.3 + jaw * 0.25);
      ctx.fillStyle = "#b4524b";
      ctx.beginPath();
      ctx.ellipse(cx, lowerY - toothH * 0.4, mouthW * 0.32, tongueH, 0, Math.PI, 0);
      ctx.fill();
      ctx.strokeStyle = "rgba(90, 25, 22, 0.5)";
      ctx.lineWidth = Math.max(1, mouthW * 0.012);
      ctx.beginPath();
      ctx.moveTo(cx, lowerY - toothH * 0.4);
      ctx.lineTo(cx, lowerY - toothH * 0.4 - tongueH * 0.8);
      ctx.stroke();
    }

    // Inner-lip contact shadow.
    const shadow = ctx.createLinearGradient(0, upperY, 0, upperY + mouthH * 0.5);
    shadow.addColorStop(0, "rgba(0,0,0,0.55)");
    shadow.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = shadow;
    ctx.fillRect(cx - mouthW / 2, upperY, mouthW, mouthH * 0.5);

    ctx.globalAlpha = 1;
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
