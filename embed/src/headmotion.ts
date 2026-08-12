/**
 * Where the head is, and how it gets somewhere else.
 *
 * A critically damped spring chasing a target that is re-picked every few
 * seconds. The stillness between movements is the point: measured on the
 * previous incarnation of this driver, the head is still ~85% of the time
 * when idle and ~70% while speaking, and autocorrelation dies within
 * seconds — a sum of sines never stops moving and the eye learns the loop.
 *
 * This drives a LAYER, not a mesh. The first attempt at head movement warped
 * face vertices, which moved the face inside a head that stayed put — the
 * user's screenshot of that is why this file exists. The whole head (hair,
 * ears, skull) now travels as one rigid unit; see engine.buildHeadLayer.
 */

const SETTLE_S = 0.9;

/** A stalled tab must not deliver one huge step and fling the head. */
const MAX_STEP_MS = 50;

export class HeadMotion {
  /** Pose in -1..1 of the engine's pixel maxima. */
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
        now + (speaking ? 1400 : 2600) + this.random() * (speaking ? 2200 : 4000);
      // Signed square: same range, most draws near zero, so a wide move
      // stays genuinely occasional rather than the head scanning the room.
      const draw = () => {
        const r = this.random() * 2 - 1;
        return Math.sign(r) * r * r;
      };
      const reach = speaking ? 1 : 0.8;
      this.target.yaw = draw() * reach;
      this.target.pitch = draw() * reach * 0.7;
      // Roll follows yaw the way a neck does; independent roll is a puppet.
      this.target.roll = draw() * 0.5 + this.target.yaw * 0.35;
    }

    // Critically damped: arrives without overshoot, which is what "settles"
    // looks like. A linear ease starts and stops abruptly.
    const omega = (2 * Math.PI) / SETTLE_S;
    const step = Math.min(dt, MAX_STEP_MS) / 1000;
    for (const axis of ["yaw", "pitch", "roll"] as const) {
      const displacement = this[axis] - this.target[axis];
      this.vel[axis] += (-2 * omega * this.vel[axis] - omega * omega * displacement) * step;
      this[axis] += this.vel[axis] * step;
    }
  }
}
