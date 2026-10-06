/**
 * The head and neck nodes' idle motion, over their rest pose: a driver's
 * pose when the model asks for one (head3d's IdleHeadPose), else a slow
 * sum of sines; nods on top while speaking; the neck's breathing.
 */
import * as THREE from "three";

/** A head pose in radians, applied over the model's rest pose. */
export interface HeadPose {
  yaw: number;
  pitch: number;
  roll: number;
}

/** Drives the head's idle motion in place of the built-in drift: called
 *  once per frame with the step in ms, the frame time, whether the avatar
 *  is speaking and its smoothed speech energy (0..1). */
export interface HeadPoseDriver {
  update(dt: number, now: number, speaking: boolean, energy: number): HeadPose;
}

/** What moves the head this frame. */
export interface HeadFrame {
  /** Seconds since the engine started (the drift's phase). */
  t: number;
  /** Frame time, ms. */
  now: number;
  /** The frame's step, ms, clamped. */
  dt: number;
  speaking: boolean;
  /** Smoothed speech energy, 0..1. */
  energy: number;
  /** The nod's lift now, 0..1. */
  nod: number;
  /** The owner's head-motion setting. */
  headMotion: number;
}

export class HeadBones {
  private readonly headRest = new THREE.Euler();
  private readonly neckRest = new THREE.Euler();

  constructor(
    private readonly head: THREE.Object3D | null,
    private readonly neck: THREE.Object3D | null,
    private readonly driver: HeadPoseDriver | null
  ) {
    if (head) this.headRest.copy(head.rotation);
    if (neck) this.neckRest.copy(neck.rotation);
  }

  /** Pose the nodes for frame `f`. The driver is asked only when there is
   *  a head to turn. */
  update(f: HeadFrame): void {
    const amp = (0.35 + f.energy * 0.65) * f.headMotion;
    const head = this.head;
    if (head && this.driver) {
      // A driver's pose, scaled by the owner's head-motion setting, with
      // the speech nods on top.
      const pose = this.driver.update(f.dt, f.now, f.speaking, f.energy);
      const s = f.headMotion;
      head.rotation.y = this.headRest.y + pose.yaw * s;
      head.rotation.x = this.headRest.x + pose.pitch * s + f.nod * 0.05 * f.energy;
      head.rotation.z = this.headRest.z + pose.roll * s;
    } else if (head) {
      head.rotation.y = this.headRest.y + (Math.sin(f.t * 0.43) * 0.05 + Math.sin(f.t * 0.117) * 0.04) * amp;
      head.rotation.x = this.headRest.x + Math.sin(f.t * 0.31 + 1.3) * 0.03 * amp + f.nod * 0.05 * f.energy;
      head.rotation.z = this.headRest.z + Math.sin(f.t * 0.27 + 0.7) * 0.015 * amp;
    }
    if (this.neck) {
      this.neck.rotation.y = this.neckRest.y + Math.sin(f.t * 0.43) * 0.02 * amp;
      this.neck.rotation.x = this.neckRest.x + Math.sin(f.t * 0.9) * 0.006; // breathing
    }
  }
}
