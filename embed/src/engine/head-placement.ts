/**
 * Where the head is this frame: the head motion's wiring between the
 * motion (motion.ts), the picture (picture.ts) and the deformation
 * (deform.ts).
 *
 * The "2d" motion moves the head as a rigid unit, shifted and rolled
 * (motion.ts headOffset). The "3d" motion turns the face in depth inside
 * the mesh (head-turn.ts), the hair and the head's outline with it (the
 * head's field, head-field.ts, laid when the picture could be read), and
 * the rigid motion carries a share of the turn (rigidShare). Either way, a
 * layered avatar's head hands its motion over to the body down the neck
 * (neck-blend.ts).
 *
 * What it builds for a mesh (the turn fitted to it, the neck's warp) it
 * keeps until the picture is laid again; the outline's weights serve every
 * viewport of the rig, so they are kept for good.
 */
import type { Rig } from "../types";
import type { Point } from "./geometry";
import { YAW_GAIN } from "./head-personality";
import type { HeadPose3D } from "./head-camera";
import type { OutlineBasis } from "./head-outline";
import { HeadTurn, type TurnStats } from "./head-turn";
import { MouthPose, type PosedMouth } from "./mouth-pose";
import type { HeadOffset, Motion } from "./motion";
import { NeckWarp, neckBlendFor, neckPin, type NeckPin } from "./neck-blend";
import type { FacePicture } from "./picture";
import { headMotionAffine } from "./render2d";
import type { Affine } from "./affine";

/** A share of the "3d" turn: of the skull's travel, and of the roll. */
export interface RigidShare {
  readonly travel: number;
  readonly roll: number;
}

/**
 * How much of the "3d" turn the head's rigid motion carries; the face
 * inside the mesh makes up the rest of the travel. Where the head's field
 * ends the picture goes with the rigid motion, so what the rigid motion
 * does not carry of the roll is not seen: a roll, an affine motion of the
 * whole head, is the rigid motion's alone.
 *
 * - layered: half the skull's travel and 40% of the roll move the head
 *   layer, which hands the motion over to the body down the neck
 *   (neck-blend.ts);
 * - cut-out: the bust leans by half the travel and 30% of the roll
 *   (render2d.ts applyBustTransform);
 * - opaque photo: it moves whole, background and all, so a third of the
 *   travel and a fifth of the roll (its edge, in the whole framing, tilts
 *   by that: at most 0.6 degrees, as the "2d" motion's does).
 */
export const RIGID_SHARE: Readonly<Record<"layered" | "cutOut" | "opaque", RigidShare>> = {
  layered: { travel: 0.5, roll: 0.4 },
  cutOut: { travel: 0.5, roll: 0.3 },
  opaque: { travel: 0.35, roll: 0.2 },
};

export function rigidShare(layered: boolean, cutOut: boolean): RigidShare {
  return layered ? RIGID_SHARE.layered : cutOut ? RIGID_SHARE.cutOut : RIGID_SHARE.opaque;
}

/** The head this frame. */
export interface PlacedHead {
  /** The rigid motion: of the head layer, a cut-out's bust, or the picture. */
  offset: HeadOffset;
  /** The "3d" turn of the face inside the mesh; undefined in the "2d"
   *  motion and while the head is at rest. */
  turn: ((pts: Point[]) => void) | undefined;
  /** The head's field, turned by the turn just applied to the face. */
  head: ((pts: Point[]) => void) | undefined;
  /** A layered avatar's neck: null for any other picture, and while the
   *  head rests on its body. */
  neck: NeckPin | null;
}

export class HeadPlacement {
  /** The "3d" turn, fitted to the mesh it was built for, and the
   *  outline's weights. */
  private turner: HeadTurn | null = null;
  private turnerFor: unknown = null;
  private basis: OutlineBasis | null = null;
  /** A layered avatar's neck warp, for the mesh it was laid for, and the
   *  canvas its layers are drawn on. */
  private neckWarp: NeckWarp | null = null;
  private neckWarpFor: unknown = null;
  private scratch: HTMLCanvasElement | null = null;
  /** This frame's turn, which the two steps below apply: made once, not a
   *  pair of closures a frame. */
  private pose: HeadPose3D = { yaw: 0, pitch: 0, roll: 0 };
  private rigid: Affine | null = null;
  private brow = 0;
  private readonly turnFace = (pts: Point[]) => this.turner?.apply(pts, this.pose, this.rigid, this.brow);
  private readonly turnField = (pts: Point[]) => this.turner?.field(pts);
  /** The last frame turned the face in depth (the "3d" motion, not at rest). */
  turning = false;
  /** The mouth's frame under the turn (mouth-pose.ts). */
  private readonly mouth = new MouthPose();

  constructor(private readonly triangles: Rig["triangles"]) {}

  /**
   * The head this frame, for `picture` moved by `motion` at `scale` (the
   * tuning's headMotion); `travel` is how far the "2d" motion's rigid unit
   * may go (render2d.ts motionTravel).
   */
  place(picture: FacePicture, motion: Motion, layered: boolean, scale: number, travel: number): PlacedHead {
    const turned = motion.mode === "3d" ? this.turnInDepth(picture, motion, layered, scale) : null;
    const offset = turned?.offset ?? motion.headOffset(picture.headGeom, travel);
    const neck = this.neckFor(picture, layered, offset);
    this.turning = !!turned?.turn;
    return { offset, turn: turned?.turn, head: turned?.head, neck };
  }

  /** The last "3d" frame's turn: fold counts, the share of the turn the
   *  fold clamp kept, the largest shift. */
  stats(): Readonly<TurnStats> | null {
    return this.turner?.stats ?? null;
  }

  /**
   * The mouth's frame this frame (mouth-pose.ts), for the face whose rest
   * pose is `base`: the rest pose as the last turn showed it, and the turn.
   * Null when the face did not turn in depth: the rest pose is the frame.
   */
  posedMouth(base: readonly Point[]): PosedMouth | null {
    return this.turning && this.turner ? this.mouth.pose(this.turner, base) : null;
  }

  /** The canvas a layered avatar's layers are drawn on through the neck. */
  neckCanvas(): HTMLCanvasElement {
    return (this.scratch ??= document.createElement("canvas"));
  }

  /** The neck's canvas is the stage's size: give its pixels back. */
  destroy(): void {
    if (this.scratch) this.scratch.width = this.scratch.height = 1;
  }

  /** The "3d" motion's rigid share of the turn, and the turn of the face
   *  inside the mesh that makes up the rest (rigidShare). */
  private turnInDepth(picture: FacePicture, motion: Motion, layered: boolean, scale: number): Omit<PlacedHead, "neck"> {
    const geom = picture.headGeom;
    if (this.turnerFor !== picture.mesh) {
      this.turnerFor = picture.mesh;
      this.turner = HeadTurn.build(picture.mesh, this.triangles, this.basis);
      if (this.turner) this.basis = this.turner.basis;
    }
    const turner = this.turner;
    const { pose, brow } = motion.pose3d(scale);
    const still: HeadOffset = { dx: 0, dy: 0, roll: 0, fdx: 0, fdy: 0 };
    if (!turner || !geom) return { offset: still, turn: undefined, head: undefined };
    const share = rigidShare(layered, picture.cutOut);
    const skull = turner.skullShift(pose);
    const offset: HeadOffset = {
      // The rigid motion follows the skull's yaw as far as it did at a 7
      // degree limit: the two degrees more (YAW_GAIN) are the face's and the
      // hair's alone (head-field.ts), so the body, the shoulders and the
      // picture's edge move no more than they did.
      dx: (skull.x * share.travel) / YAW_GAIN,
      dy: skull.y * share.travel,
      roll: pose.roll * share.roll,
      fdx: 0,
      fdy: 0,
    };
    // The turn takes out the rigid motion's shift (or lean); its roll turns
    // the face and the outline alike (head-turn.ts apply).
    this.pose = pose;
    this.rigid = headMotionAffine(geom, { ...offset, roll: 0 }, picture.cutOut && !layered);
    this.brow = brow;
    const quiet = Math.abs(pose.yaw) + Math.abs(pose.pitch) + brow < 1e-6;
    return {
      offset,
      turn: quiet ? undefined : this.turnFace,
      head: quiet || !turner.head ? undefined : this.turnField,
    };
  }

  /** A layered avatar's neck (neck-blend.ts): the warp the body and head
   *  layers are drawn through and the neck band is placed by, for the head
   *  moved by `offset` relative to the body. */
  private neckFor(picture: FacePicture, layered: boolean, offset: HeadOffset): NeckPin | null {
    const geom = picture.headGeom;
    if (!layered || !geom) return null;
    if (this.neckWarpFor !== picture.mesh) {
      this.neckWarpFor = picture.mesh;
      const blend = neckBlendFor(picture.mesh);
      this.neckWarp = blend ? new NeckWarp(blend, picture.mesh.picture) : null;
    }
    if (!this.neckWarp || (!offset.dx && !offset.dy && !offset.roll)) return null;
    return neckPin(this.neckWarp, headMotionAffine(geom, offset, false));
  }
}
