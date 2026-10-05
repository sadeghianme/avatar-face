/**
 * The 3D head's idle motion: the 2D engine's own HeadMotion (a critically
 * damped spring chasing a target re-picked every few seconds, still most
 * of the time), scaled to a real turn. The 2D line can only shift a layer
 * by a few pixels; a head with a skull behind it may turn up to 20
 * degrees, which is what the skull is for.
 */
import type { HeadPose, HeadPoseDriver } from "../engine3d";
import { HeadMotion } from "../headmotion";

/** Peak travel at |pose| = 1, which the signed-square draw rarely reaches. */
export const HEAD_POSE_RANGE = { yawDeg: 20, pitchDeg: 12, rollDeg: 4 } as const;

const rad = (deg: number) => (deg * Math.PI) / 180;

export class IdleHeadPose implements HeadPoseDriver {
  private readonly motion: HeadMotion;

  constructor(random: () => number = Math.random) {
    this.motion = new HeadMotion(random);
  }

  update(dt: number, now: number, speaking: boolean): HeadPose {
    this.motion.update(dt, now, speaking);
    return {
      yaw: this.motion.yaw * rad(HEAD_POSE_RANGE.yawDeg),
      pitch: this.motion.pitch * rad(HEAD_POSE_RANGE.pitchDeg),
      roll: this.motion.roll * rad(HEAD_POSE_RANGE.rollDeg),
    };
  }
}

/** A pose held still (stills, tests); change it through `set`. */
export class FixedHeadPose implements HeadPoseDriver {
  private pose: HeadPose = { yaw: 0, pitch: 0, roll: 0 };

  set(yawDeg: number, pitchDeg = 0, rollDeg = 0): void {
    this.pose = { yaw: rad(yawDeg), pitch: rad(pitchDeg), roll: rad(rollDeg) };
  }

  update(): HeadPose {
    return this.pose;
  }
}
