/**
 * The 3D face's life between words and through them: blinks, saccades and
 * nods, each on its own schedule, stepped once per frame.
 *
 * The steps are per frame, not per millisecond (a blink is 15 frames, a nod
 * about 40), as the engine has always run them; the schedules are in frame
 * time. `random` is read at the moment each draw is made, so a page (or a
 * test) that seeds Math.random after the engine exists still seeds it.
 */

/** Where the eyes look: offsets in the eyeLook* morphs' units. */
export interface Gaze { x: number; y: number }

/** The blink's sweep: up to fully closed by 0.4 of its phase, open again by 1. */
export function blinkAmount(phase: number): number {
  if (phase <= 0) return 0;
  if (phase < 0.4) return Math.sin((phase / 0.4) * (Math.PI / 2));
  return Math.cos(((phase - 0.4) / 0.6) * (Math.PI / 2));
}

/** The ARKit eyeLook* values for a gaze, damped by how closed the lids are
 *  (models that lack the morphs ignore them). */
export function lookMorphs(gaze: Gaze, blink: number): Record<string, number> {
  const damp = 1 - blink;
  return {
    eyeLookOutLeft: Math.max(0, -gaze.x) * damp,
    eyeLookInLeft: Math.max(0, gaze.x) * damp,
    eyeLookOutRight: Math.max(0, gaze.x) * damp,
    eyeLookInRight: Math.max(0, -gaze.x) * damp,
    eyeLookUpLeft: Math.max(0, -gaze.y) * damp,
    eyeLookUpRight: Math.max(0, -gaze.y) * damp,
    eyeLookDownLeft: Math.max(0, gaze.y) * damp,
    eyeLookDownRight: Math.max(0, gaze.y) * damp,
  };
}

/** The blink per frame, and the nod's. */
const BLINK_STEP = 16 / 240;
const NOD_STEP = 16 / 650;

export class FaceLife {
  /** Blink phase: 0 open, (0, 1) mid-blink. */
  private blinkPhase = 0;
  /** Nod phase: 1 at rest, [0, 1) mid-nod. */
  private nodPhase = 1;
  private readonly gaze: Gaze = { x: 0, y: 0 };
  private gazeTarget: Gaze = { x: 0, y: 0 };
  private nextBlinkAt = 0;
  private nextSaccadeAt = 0;
  private nextNodAt = 0;

  constructor(private readonly random: () => number = () => Math.random()) {}

  /** The first blink, nod and glance, from `now`: a blink soon, a glance
   *  sooner. */
  start(now: number): void {
    this.nextBlinkAt = now + 1200 + this.random() * 2000;
    this.nextNodAt = now + 2500;
    this.nextSaccadeAt = now + 600 + this.random() * 1200;
  }

  /** Step the blink one frame (starting one when it is due); how closed
   *  the lids are now, 0..1. */
  blink(now: number): number {
    if (now >= this.nextBlinkAt) {
      this.nextBlinkAt = now + 2200 + this.random() * 3200;
      this.blinkPhase = 0.0001;
    }
    if (this.blinkPhase > 0) {
      this.blinkPhase += BLINK_STEP;
      if (this.blinkPhase >= 1) this.blinkPhase = 0;
    }
    return blinkAmount(this.blinkPhase);
  }

  /** Step the gaze one frame toward its target, re-picking the target when
   *  a saccade is due: nearer the viewer and more often while speaking. */
  look(now: number, speaking: boolean): Readonly<Gaze> {
    if (now >= this.nextSaccadeAt) {
      const spread = speaking ? 0.16 : 0.3;
      this.nextSaccadeAt = now + (speaking ? 900 : 1400) + this.random() * (speaking ? 1600 : 2600);
      this.gazeTarget = {
        x: (this.random() * 2 - 1) * spread,
        y: (this.random() * 2 - 1) * spread * 0.5,
      };
    }
    this.gaze.x += (this.gazeTarget.x - this.gaze.x) * 0.35;
    this.gaze.y += (this.gazeTarget.y - this.gaze.y) * 0.35;
    return this.gaze;
  }

  /** Step the nod one frame, starting one when due while speaking; the
   *  nod's lift now, 0..1. */
  nod(now: number, speaking: boolean): number {
    if (speaking && now >= this.nextNodAt) {
      this.nextNodAt = now + 1800 + this.random() * 2600;
      this.nodPhase = 0;
    }
    if (this.nodPhase < 1) this.nodPhase = Math.min(1, this.nodPhase + NOD_STEP);
    return this.nodPhase < 1 ? Math.sin(this.nodPhase * Math.PI) : 0;
  }
}
