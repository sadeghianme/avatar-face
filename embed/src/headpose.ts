/**
 * Where the head is looking, and how it gets there.
 *
 * Split out of the engine so the motion can be simulated and measured without
 * a canvas: "does this look natural" is not a question you can answer by
 * reading a sine wave, but it does decompose into things you can measure —
 * how much of the time the head is still, how far it travels, whether it ever
 * jerks, and whether it repeats.
 *
 * The model is a critically damped spring chasing a target that is re-picked
 * every few seconds. The stillness between movements is the point. A sum of
 * sines never stops moving, and the eye picks out the loop within about ten
 * seconds; a head that goes somewhere, stays, and then goes somewhere else
 * reads as making decisions.
 */

/**
 * Peak angles in radians — roughly 11, 7 and 4 degrees.
 *
 * Set by measuring rather than by taste: at the first values the nose swung
 * about 3% of the face width, which reads as a still photograph with a slight
 * wobble. Conversational head movement is nearer 6%. Going much past this
 * starts to look rubbery, because a photograph warped this way has no real
 * depth to rotate.
 */
export const HEAD_YAW_MAX = 0.2;
export const HEAD_PITCH_MAX = 0.13;
export const HEAD_ROLL_MAX = 0.07;

/** Seconds for a movement to arrive and settle. */
export const HEAD_SETTLE_S = 0.9;

const HOLD_MS = 2600;
const HOLD_JITTER_MS = 4000;
const HOLD_SPEAKING_MS = 1400;
const HOLD_SPEAKING_JITTER_MS = 2200;

/** A stalled tab must not deliver one enormous step and fling the head. */
const MAX_STEP_MS = 50;

export class HeadPose {
  /** Current pose, in -1..1 of the maxima above. */
  yaw = 0;
  pitch = 0;
  roll = 0;

  private vel = { yaw: 0, pitch: 0, roll: 0 };
  private target = { yaw: 0, pitch: 0, roll: 0 };
  private nextMoveAt = 0;

  /** Injectable so tests are deterministic. */
  constructor(private random: () => number = Math.random) {}

  update(dt: number, now: number, speaking: boolean): void {
    if (now >= this.nextMoveAt) {
      this.nextMoveAt =
        now +
        (speaking ? HOLD_SPEAKING_MS : HOLD_MS) +
        this.random() * (speaking ? HOLD_SPEAKING_JITTER_MS : HOLD_JITTER_MS);
      this.pick(speaking);
    }

    // Critically damped: arrives without overshoot or ringing, which is what
    // settling looks like. A linear ease starts and stops abruptly, and an
    // under-damped spring wobbles like a bobblehead.
    const omega = (2 * Math.PI) / HEAD_SETTLE_S;
    const step = Math.min(dt, MAX_STEP_MS) / 1000;
    for (const axis of ["yaw", "pitch", "roll"] as const) {
      const displacement = this[axis] - this.target[axis];
      this.vel[axis] += (-2 * omega * this.vel[axis] - omega * omega * displacement) * step;
      this[axis] += this.vel[axis] * step;
    }
  }

  private pick(speaking: boolean): void {
    // Signed square: same range, but most draws land near zero, so a wide
    // turn stays genuinely occasional. Drawing uniformly puts the head at an
    // extreme most of the time, which reads as scanning a room rather than
    // talking to someone.
    const draw = () => {
      const r = this.random() * 2 - 1;
      return Math.sign(r) * r * r;
    };
    const reach = speaking ? 1.0 : 0.8;
    this.target.yaw = draw() * reach;
    this.target.pitch = draw() * reach * 0.7;
    // Roll follows yaw: a real neck tips the head slightly the same way it
    // turns. Rolling independently of yaw looks like a puppet on a stick.
    this.target.roll = draw() * 0.5 + this.target.yaw * 0.35;
  }
}
