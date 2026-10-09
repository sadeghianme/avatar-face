/**
 * The mouth's frame while the head turns in depth (head-turn.ts).
 *
 * The speech deforms the lips in the rest frame, before the turn
 * (deform.ts); the turn then moves the lips as one piece. What a mouth
 * paints over and behind them (the cavity, the teeth, a drawn mouth) is
 * placed from two things this module keeps:
 *  - `neutral`: the rest pose as the turn showed it, each landmark at rest
 *    moved by the shift the last apply gave it, so the corners, width and
 *    angle a mouth reads off it are the turned lips';
 *  - `turn` (MouthTurn, mouth-extension.ts): where a point deeper than the
 *    lips is seen. Turned about the head's pivot as the lips are, it moves
 *    a little less than they do (parallax).
 * Both are rewritten every frame (no allocation per frame) and valid for
 * the frame they are handed in.
 */
import type { MouthPoint, MouthTurn } from "../mouth-extension";
import type { Point } from "./geometry";
import { CANON_IOD_CM } from "./head-depth";
import type { AppliedTurn, HeadTurn } from "./head-turn";

/** The landmarks whose mean shift carries the mouth's frame: the inner
 *  lips' middle and the corners (the lips move as one piece, which the fold
 *  clamp may have eased a little apart). */
export const LIP_FRAME: readonly number[] = [13, 14, 61, 291];
/** The inner lips' middle: the lips' line, whose depth is the lips'. */
const LIP_LINE: readonly number[] = [13, 14];

/** The mouth's frame under a turn, as paint-mouth.ts hands it on. */
export interface PosedMouth {
  /** The rest pose as this frame's turn shows it (MouthSurfaceFrame.neutral). */
  readonly neutral: readonly Point[];
  readonly turn: MouthTurn;
}

/**
 * MouthTurn from a HeadTurn's last apply. A point `depth` behind the lips
 * at (x, y) (as if on the lips, in the posed frame) is taken back to rest
 * by the lips' own shift, turned at the lips' depth and at its own, and
 * seen where the lips put it plus the difference between the two: the
 * parallax, through the rigid motion the turn took out, at the share of
 * the turn the clamp kept. Zero at depth 0, and at no turn.
 */
class LipTurn implements MouthTurn {
  yaw = 0;
  pitch = 0;
  mm = 1;
  private turner: HeadTurn | null = null;
  private applied: AppliedTurn | null = null;
  private lipDepth = 0;
  private readonly lipShift: Point = { x: 0, y: 0 };
  private readonly atLips: Point = { x: 0, y: 0 };
  private readonly atDepth: Point = { x: 0, y: 0 };

  update(turner: HeadTurn, applied: AppliedTurn): void {
    this.turner = turner;
    this.applied = applied;
    this.yaw = applied.pose.yaw * applied.share;
    this.pitch = applied.pose.pitch * applied.share;
    this.mm = turner.iod / (10 * CANON_IOD_CM);
    this.lipDepth = mean(turner.depth, LIP_LINE, 1, 0);
    this.lipShift.x = mean(applied.shift, LIP_FRAME, 2, 0);
    this.lipShift.y = mean(applied.shift, LIP_FRAME, 2, 1);
  }

  behindLips(out: MouthPoint, x: number, y: number, depth: number): MouthPoint {
    const { turner, applied } = this;
    if (!turner || !applied) {
      out.x = x;
      out.y = y;
      return out;
    }
    const rx = x - this.lipShift.x,
      ry = y - this.lipShift.y;
    const near = turner.project(rx, ry, this.lipDepth, applied.pose, this.atLips);
    const far = turner.project(rx, ry, this.lipDepth - depth, applied.pose, this.atDepth);
    let dx = far.x - near.x,
      dy = far.y - near.y;
    const back = applied.back;
    if (back) {
      const t = back.a * dx + back.c * dy;
      dy = back.b * dx + back.d * dy;
      dx = t;
    }
    out.x = x + applied.share * dx;
    out.y = y + applied.share * dy;
    return out;
  }
}

/** The mouth's frame for the turn in depth: one per engine. */
export class MouthPose {
  private readonly neutral: Point[] = [];
  private readonly turn = new LipTurn();
  private readonly posed: PosedMouth = { neutral: this.neutral, turn: this.turn };

  /**
   * The mouth's frame after `turner`'s last apply, for the face whose rest
   * pose is `base`; null before the first apply. Landmarks past the turn's
   * (none, for a rig's own mesh) are left at rest.
   */
  pose(turner: HeadTurn, base: readonly Point[]): PosedMouth | null {
    const applied = turner.applied();
    if (!applied) return null;
    const shift = applied.shift;
    const turned = Math.min(base.length, shift.length / 2);
    const out = this.neutral;
    out.length = base.length;
    for (let i = 0; i < base.length; i++) {
      const p = (out[i] ??= { x: 0, y: 0 });
      p.x = base[i].x + (i < turned ? shift[2 * i] : 0);
      p.y = base[i].y + (i < turned ? shift[2 * i + 1] : 0);
    }
    this.turn.update(turner, applied);
    return this.posed;
  }
}

/** The mean of `values[stride * i + offset]` over the landmarks `ids`. */
function mean(values: ArrayLike<number>, ids: readonly number[], stride: number, offset: number): number {
  let sum = 0;
  for (const i of ids) sum += values[stride * i + offset];
  return sum / ids.length;
}
