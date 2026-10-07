/**
 * The involuntary motion: blinks, the gaze and its saccades, the head's
 * drift and its nods on the speech's accents, the body's sway and breath,
 * and the catch-breath at a pause.
 *
 * Durations are in real milliseconds. These used to be per-frame
 * increments, which made every one of them run at a speed that depended on
 * the frame rate — a blink took 440ms on a 30fps device. The blink's own
 * timing lives in blink.ts, the body's in bodymotion.ts, the head's drift
 * in headmotion.ts; this schedules them and turns them into transforms.
 */
import { BlinkScheduler } from "./blink";
import { BodyMotion, BREATH_RISE, SWAY_TRAVEL } from "./bodymotion";
import { HeadMotion } from "./headmotion";
import { HeadPersonality } from "./head-personality";
import type { HeadPose3D } from "./head-turn";
import type { Beat } from "./cues";
import type { Cue } from "../types";
import type { HeadGeom, Point } from "./geometry";
import type { FaceState } from "./state";

/** Pivot depth for body sway, as a multiple of canvas height. Below the
 *  frame: a standing body turns about its feet, not its middle. */
const BODY_PIVOT_DEPTH = 1.75;

/** A head is wider than the face landmarks that sit inside it. Used only to
 *  express the sway target in the same units it was measured in. */
const FACE_TO_HEAD_WIDTH = 1.4;

/** Silence inside speech longer than this is a pause, and a pause gets a
 *  catch-breath. Shorter gaps are the space between words. */
const PAUSE_BREATH_MS = 260;

/** A saccade is ballistic and fast — ~35ms to cross, whatever the frame rate. */
const SACCADE_MS = 35;

/** A beat gesture is quick — a dip and back, not a slow ambient nod. */
const BEAT_NOD_MS = 420;
/** Ambient nods, when a cue track carries no usable emphasis. */
const AMBIENT_NOD_MS = 1050;

/** How the head is displaced this frame, canvas px and radians, plus the
 *  face's parallax share (always none: see headOffset). */
export interface HeadOffset {
  dx: number;
  dy: number;
  roll: number;
  fdx: number;
  fdy: number;
}

/** The body's lean this frame: a rotation about a pivot below the frame,
 *  and a rise for the breath. */
export interface BodyLean {
  pivot: Point;
  angle: number;
  rise: number;
}

/** What the speech is doing this frame, for the motion to follow. */
export interface SpeechFrame {
  speaking: boolean;
  /** A word is sounding (speaking, and not on a silence). */
  wordActive: boolean;
  /** The speech's energy this instant, 0..1: drives the head's nods. */
  energy: number;
  /** Cue time now; read only when there are beats to walk. */
  cueTime: () => number;
}

export class Motion {
  /** Smoothed speech energy, drives head motion. */
  energy = 0;
  readonly blinks = new BlinkScheduler();
  readonly body = new BodyMotion();
  /** The head's drift (headmotion.ts). It moves the head as one rigid unit
   *  (render2d.ts), never the face's vertices: the first attempt moved face
   *  vertices, and the face slid around inside a stationary head. */
  readonly head = new HeadMotion();
  /**
   * "2d" (the default): the head moves as a rigid layer (headOffset), with
   * the drift above and nods on the beats. "3d" (a prototype,
   * EngineOptions.headMotion): the head turns in depth inside the face
   * mesh (head-turn.ts), driven by `personality` instead.
   */
  mode: "2d" | "3d" = "2d";
  /** The tuning's headMotion, which scales the 3D pose and with it how
   *  far the eyes counter it (the engine sets it every tick). */
  headScale = 1;
  /** The 3D mode's pose, gaze and brows (head-personality.ts). */
  readonly personality = new HeadPersonality(1);
  /** Where the eyes are going: offsets in eye-widths. */
  gazeTarget: Point = { x: 0, y: 0 };
  private nextSaccadeAt = 0;
  /** When the current run of silence inside speech began, for catch-breaths;
   *  null while a viseme is active. */
  private silenceSince: number | null = null;
  private nextNodAt = 0;
  private nodPhase = 1; // 1 = finished
  private nodMs = AMBIENT_NOD_MS;
  private nodStrength = 1;
  /** Emphasis beats for the utterance in flight, and how far through them
   *  the cue clock has walked. */
  private beats: Beat[] = [];
  private nextBeat = 0;
  /** Where the body pivots, and its reach (measureBody). */
  private bodyPivot = { x: 0, y: 0 };
  private swayAngle = 0; // radians at full deflection
  private breathRise = 0; // pixels at the top of an inhale

  /** `face`: the shared state whose blink and gaze this motion moves. */
  constructor(private readonly face: FaceState) {}

  /** The first fixation and nod, timed from `now`. */
  start(now: number): void {
    this.personality.start(now);
    this.blinks.reset(now);
    this.nextNodAt = now + 2500;
    this.nextSaccadeAt = now + 600 + Math.random() * 1200;
  }

  /**
   * Where the body pivots, and how far it may travel.
   *
   * The pivot goes below the canvas, roughly where the feet would be. A small
   * rotation about a distant point is very nearly a translation that grows
   * with height — which is both what an inverted pendulum does and the reason
   * the bottom of the frame stays put while the head moves.
   */
  measureBody(basePoints: readonly Point[], canvasHeight: number): void {
    const xs = basePoints.map((p) => p.x);
    const ys = basePoints.map((p) => p.y);
    const faceW = Math.max(1, Math.max(...xs) - Math.min(...xs));
    const faceH = Math.max(1, Math.max(...ys) - Math.min(...ys));
    const faceCentreY = (Math.min(...ys) + Math.max(...ys)) / 2;

    this.bodyPivot = {
      x: (Math.min(...xs) + Math.max(...xs)) / 2,
      y: canvasHeight * BODY_PIVOT_DEPTH,
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

  /** Speech starts: the body paces its exhale over `durationMs`, the head
   *  will mark `beats`, and the eyes go to the person being spoken to. */
  beginSpeech(now: number, durationMs: number, beats: Beat[]): void {
    this.body.beginSpeech(now, durationMs);
    this.beats = beats;
    this.nextBeat = 0;
    this.gazeTarget = { x: 0, y: 0 }; // look at the person you are talking to
  }

  /** A new track mid-utterance: its beats, walked from cue time `ms`. */
  setBeats(beats: Beat[], ms: number): void {
    this.beats = beats;
    this.placeBeatWalker(ms);
  }

  /** Re-place the beat walker at `ms`: after a seek the beats behind the new
   *  position are spent, not pending. */
  placeBeatWalker(ms: number): void {
    this.nextBeat = this.beats.findIndex((b) => b.t > ms);
    if (this.nextBeat < 0) this.nextBeat = this.beats.length;
  }

  endSpeech(now: number): void {
    if (this.mode === "3d") this.personality.endSpeech(now);
    this.body.endSpeech();
    this.blinks.onSpeechEnd(now);
    this.beats = [];
  }

  /**
   * Note whether the speech is in a pause (`inPause`): one that has lasted
   * long enough to be a pause, not the gap between two words, gets a
   * catch-breath, a blink and sometimes a glance away, once per run of
   * silence; speech resuming after it brings the eyes back.
   */
  notePause(now: number, inPause: boolean): void {
    if (inPause) {
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
  }

  /** Advance everything by `dt` ms to frame time `now`. */
  update(dt: number, now: number, speech: SpeechFrame): void {
    // Speech energy (drives head pose amplitude).
    this.energy += (speech.energy - this.energy) * (1 - Math.exp(-dt / 270));

    // Blinks are placed by events (pauses, saccades, head turns, speech
    // end) with a timer only as a fallback — see blink.ts.
    this.blinks.update(dt, now, { speaking: speech.speaking, wordActive: speech.wordActive });
    this.face.blink = this.blinks.phase;

    // (The order of the 2D branch's calls is kept as it was: each draws on
    // Math.random.)
    if (this.mode !== "3d") this.nod(dt, now, speech);
    this.body.update(dt, now);
    if (this.mode === "3d") {
      const p = this.personality;
      p.update(dt, now, speech.speaking, this.energy, speech.cueTime);
      // A head move of more than a few degrees carries a blink.
      if (p.movedAt === now && p.moveSize * this.headScale > 0.06) this.blinks.onHeadTurn(now);
    } else {
      this.head.update(dt, now, speech.speaking);
      if (this.head.movedAt === now && this.head.moveSize > 0.35) this.blinks.onHeadTurn(now);
    }

    this.saccade(dt, now, speech.speaking);
  }

  /** The 3D mode's cue track: its phrases and accents, from cue ms `ms`. */
  setSpeechCues(cues: readonly Cue[], ms = 0): void {
    this.personality.setSpeech(cues, ms);
  }

  /** The 3D pose now at `scale` (the tuning's headMotion), radians, and
   *  the brows' raise. */
  pose3d(scale: number): { pose: HeadPose3D; brow: number } {
    const p = this.personality.pose;
    return {
      pose: { yaw: p.yaw * scale, pitch: p.pitch * scale, roll: p.roll * scale },
      brow: this.personality.brow * Math.min(1, scale),
    };
  }

  /**
   * Gentle nods on a loose cadence while speaking.
   * Emphasis beats: the head marks the syllables the voice leaned on.
   * Walked on the CUE clock, not wall time, so a beat stays on its
   * syllable when playback is re-synced (syncCueTime).
   */
  private nod(dt: number, now: number, speech: SpeechFrame): void {
    if (speech.speaking && this.beats.length) {
      const cueTime = speech.cueTime();
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
    } else if (speech.speaking && now >= this.nextNodAt) {
      // No usable emphasis in this track (a browser voice, or a cue track
      // with flat amplitudes): the old loose cadence still reads better
      // than a head that never moves while talking.
      this.nextNodAt = now + 1800 + Math.random() * 2600;
      this.nodPhase = 0;
      this.nodMs = AMBIENT_NOD_MS;
      this.nodStrength = 1;
    }
    if (this.nodPhase < 1) this.nodPhase = Math.min(1, this.nodPhase + dt / this.nodMs);
  }

  /**
   * Saccades: eyes jump to a new fixation, then hold. While speaking the
   * gaze returns near-center more often (engaged with the listener);
   * idle gaze wanders further and rests longer.
   */
  private saccade(dt: number, now: number, speaking: boolean): void {
    const gaze = this.face.gaze;
    if (now >= this.nextSaccadeAt) {
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
      this.blinks.onSaccade(now, Math.hypot(this.gazeTarget.x - gaze.x, this.gazeTarget.y - gaze.y));
    }
    // Saccades are ballistic: fast jump, then a still fixation.
    // In 3D the eyes also hold the listener against the head's turn and
    // lead it on a glance (head-personality.ts), the wander halved.
    const saccadeRate = 1 - Math.exp(-dt / SACCADE_MS);
    const head3d = this.mode === "3d" ? this.personality.gaze : null;
    const k = Math.min(1, this.headScale);
    const tx = head3d ? this.gazeTarget.x * 0.5 + head3d.x * k : this.gazeTarget.x;
    const ty = head3d ? this.gazeTarget.y * 0.5 + head3d.y * k : this.gazeTarget.y;
    gaze.x += (tx - gaze.x) * saccadeRate;
    gaze.y += (ty - gaze.y) * saccadeRate;
  }

  /**
   * The head's displacement now, for a head placed at `geom`, at
   * `strength` (1 full travel, 0 still).
   */
  headOffset(geom: HeadGeom | null, strength: number): HeadOffset {
    const g = geom;
    if (!g) return { dx: 0, dy: 0, roll: 0, fdx: 0, fdy: 0 };
    const s = strength;
    // sin² envelope, not sin: sin starts at its steepest, which read as the
    // head being yanked downward at every nod onset. sin² starts and ends
    // with zero velocity, so the dip eases in and out.
    const p = this.nodPhase;
    const nod = p < 1 ? Math.sin(p * Math.PI) ** 2 : 0;
    const dx = this.head.yaw * g.yawPx * s;
    const dy = (this.head.pitch * g.pitchPx + nod * this.nodStrength * this.energy * g.faceH * 0.013) * s;
    const roll = this.head.roll * 0.02 * s;
    // NO face parallax. The face mesh redrawn at its own offset over the
    // head layer duplicates whatever crosses the mesh hull — bangs over a
    // forehead become two sets of bangs a few px apart, which reads as cuts
    // through the face. One rigid unit, one offset, nothing to mismatch.
    return { dx, dy, roll, fdx: 0, fdy: 0 };
  }

  /** The body's lean now at `strength` (1 full sway, 0 none: null). */
  bodyLean(strength: number): BodyLean | null {
    if (strength <= 0) return null;
    return {
      pivot: this.bodyPivot,
      angle: this.body.sway * this.swayAngle * strength,
      rise: this.body.breath * this.breathRise * strength,
    };
  }
}
