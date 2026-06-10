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
import { BlendWeights, Cue, Rig, ZERO_WEIGHTS } from "./types";

// Canonical MediaPipe brow rows, inner -> outer.
const LEFT_BROW = [55, 65, 52, 53, 46];
const RIGHT_BROW = [285, 295, 282, 283, 276];
const LEFT_EYE = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246];
const RIGHT_EYE = [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466];
const NOSE_TIP = 4;

interface Point {
  x: number;
  y: number;
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
  private raf = 0;
  private startTime = 0;

  // Audio
  private audioCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private analyserData: Uint8Array | null = null;
  private currentAudio: HTMLAudioElement | null = null;
  private onAudioEnd: (() => void) | null = null;

  debugMesh: boolean;
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
    this.startTime = performance.now();
    this.nextBlinkAt = this.startTime + 1200 + Math.random() * 2000;
    this.nextNodAt = this.startTime + 2500;
    this.nextBrowPulseAt = this.startTime + 1800 + Math.random() * 2500;
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
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
    this.cues = cues;
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

  private loop(now: number): void {
    if (this.destroyed) return;
    this.tick(now);
    this.render();
    this.raf = requestAnimationFrame(this.loop);
  }

  private tick(now: number): void {
    // Viseme targets from the cue track (+ amplitude fallback when the
    // track is silent but audio clearly isn't).
    const visemeName = this.currentViseme(now);
    const visemeWeights = { ...ZERO_WEIGHTS, ...(this.rig.visemes[visemeName] ?? {}) };
    if (this.speaking && visemeName === "sil") {
      const amp = this.amplitude();
      if (amp > 0.06) visemeWeights.jawOpen = Math.min(0.7, amp * 1.8);
    }
    this.targetWeights = visemeWeights;

    // Critically-damped-ish approach to targets (fast open, slower close).
    // Rates tuned for smoothness: rapid per-character cue tracks would
    // otherwise slam the jaw fully open/shut every ~75ms.
    const keys = Object.keys(this.weights) as (keyof BlendWeights)[];
    for (const key of keys) {
      const target = this.targetWeights[key];
      const rate = target > this.weights[key] ? 0.3 : 0.16;
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
    for (const i of mouthIdx) {
      const nx = (pts[i].x - mcx) / (mw / 2); // -1..1 across the mouth
      const ny = (pts[i].y - mcy) / (mh / 2);
      let dx = 0;
      let dy = 0;
      // jawOpen: lower lip drops (scaled by how low the point sits).
      if (ny > 0) dy += w.jawOpen * mh * 1.15 * Math.min(1, ny);
      else dy -= w.jawOpen * mh * 0.1 * -ny; // upper lip lifts slightly
      // pucker/funnel: narrow horizontally, push lips toward an "O".
      dx -= (w.mouthPucker * 0.30 + w.mouthFunnel * 0.18) * nx * (mw / 2);
      if (ny < 0) dy -= w.mouthFunnel * mh * 0.12;
      // stretch/smile: widen; smile lifts the corners.
      dx += (w.mouthStretch * 0.22 + w.mouthSmile * 0.12) * nx * (mw / 2);
      if (Math.abs(nx) > 0.55) dy -= w.mouthSmile * mh * 0.3 * (Math.abs(nx) - 0.55);
      // mouthClose: collapse inner ring toward the lip line.
      if (innerSet.has(i)) dy += (mcy - pts[i].y) * w.mouthClose * 0.8;
      pts[i].x += dx;
      pts[i].y += dy;
    }

    // Chin/jaw follows jawOpen with radial falloff below the mouth.
    if (w.jawOpen > 0.01) {
      for (let i = 0; i < pts.length; i++) {
        if (mouthIdx.includes(i)) continue;
        const dyFromMouth = pts[i].y - mcy;
        if (dyFromMouth <= 0) continue;
        const dist = Math.hypot(pts[i].x - mcx, dyFromMouth);
        const falloff = Math.max(0, 1 - dist / (mw * 1.4));
        pts[i].y += w.jawOpen * mh * 0.9 * falloff;
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

    // Eased blinks: close the eyes by pulling lid points to the eye center.
    if (this.blink > 0) {
      const amount = Math.sin(this.blink * Math.PI); // ease in-out
      for (const eye of [LEFT_EYE, RIGHT_EYE]) {
        let ecy = 0;
        for (const i of eye) ecy += pts[i].y;
        ecy /= eye.length;
        for (const i of eye) pts[i].y = pts[i].y + (ecy - pts[i].y) * amount * 0.85;
      }
    }

    // Brow layer: lift rows inner->outer on eased sin pulses + rest browInnerUp.
    const browPulse = this.browPulsePhase < 1 ? Math.sin(this.browPulsePhase * Math.PI) : 0;
    const browLift = browPulse * (this.speaking ? 0.8 + this.energy * 0.6 : 0.5);
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
    const amp = 0.35 + this.energy * 0.9;
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

    for (const [a, b, c] of this.rig.triangles) {
      this.drawWarpedTriangle(pts, a, b, c);
    }

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
    if (openness < 0.06) return;
    const squash = 0.1 + 0.9 * openness;

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

    // Cavity base.
    ctx.fillStyle = "#270d0c";
    ctx.fillRect(cx - mouthW, cy - mouthH, mouthW * 2, mouthH * 2);

    const jaw = this.weights.jawOpen;
    const upperY = cy - mouthH / 2;
    const lowerY = cy + mouthH / 2;
    // Anatomically fixed tooth height relative to mouth WIDTH (stable),
    // hanging from the lips; opening grows the dark gap between rows.
    const toothH = mouthW * 0.16;

    // Gum line + upper teeth.
    ctx.fillStyle = "#9e5a55";
    ctx.fillRect(cx - mouthW / 2, upperY, mouthW, toothH * 0.25);
    ctx.fillStyle = "#f3eee4";
    const teeth = 8;
    const toothW = mouthW / teeth;
    for (let i = 0; i < teeth; i++) {
      const tx = cx - mouthW / 2 + i * toothW;
      ctx.beginPath();
      ctx.moveTo(tx + 0.5, upperY + toothH * 0.2);
      ctx.lineTo(tx + toothW - 0.5, upperY + toothH * 0.2);
      ctx.lineTo(tx + toothW - 1, upperY + toothH);
      ctx.quadraticCurveTo(tx + toothW / 2, upperY + toothH * 1.15, tx + 1, upperY + toothH);
      ctx.closePath();
      ctx.fill();
    }
    // Lower teeth hang up from the lower lip.
    ctx.fillStyle = "#e8e2d4";
    for (let i = 0; i < teeth; i++) {
      const tx = cx - mouthW / 2 + i * toothW;
      ctx.fillRect(tx + 1, lowerY - toothH * 0.7, toothW - 2, toothH * 0.7);
    }

    // Tongue rises with jaw opening; center groove when open.
    if (jaw > 0.12) {
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

    ctx.restore();
  }

  private drawDebugMesh(pts: Point[]): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = "rgba(0, 255, 140, 0.35)";
    ctx.lineWidth = 0.5;
    for (const [a, b, c] of this.rig.triangles) {
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
