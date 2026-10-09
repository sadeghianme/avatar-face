/**
 * The mouth's surface this frame, painted by whichever mouth is in charge:
 * a mouth extension that paints the whole surface (mouth/), else the
 * character mouth for a profile that has one, else the classic drawn mouth
 * (paint-classic-mouth.ts), which hands an extension that only draws the
 * interior its aperture.
 */
import { characterOpening, lowerEdgePath, openingPath, type CharacterTraits } from "./character-mouth";
import { paintCharacter } from "./character-paint";
import type { KindProfile } from "./kind-profile";
import type { PosedMouth } from "./mouth-pose";
import type { MouthExtension } from "../mouth-extension";
import type { EngineTuning, Rig } from "../types";
import { pixelScale, type Point } from "./geometry";
import type { ClassicMouth } from "./paint-classic-mouth";
import type { FacePicture } from "./picture";
import type { FaceState } from "./state";

export interface MouthSurface {
  ctx: CanvasRenderingContext2D;
  /** Every mesh vertex this frame, canvas px. */
  pts: Point[];
  picture: FacePicture;
  rig: Rig;
  face: FaceState;
  tuning: EngineTuning;
  profile: KindProfile;
  traits: CharacterTraits;
  extension: MouthExtension | undefined;
  classicMouth: ClassicMouth;
  /** The sound being made now (a mouth driver's, else the cue track's). */
  viseme: () => string;
  /** The mouth's frame while the head turns in depth (mouth-pose.ts:
   *  head-placement.ts posedMouth); null when the face did not turn, and
   *  the rest pose is the mouth's frame. */
  posed: PosedMouth | null;
}

export function paintMouthSurface(m: MouthSurface): void {
  const { ctx, pts, picture } = m;
  const { mesh, samples } = picture;
  // Every mouth is placed in the frame the lips are in: the rest pose, or
  // the rest pose as the head's turn showed it. The speech shaped the lips
  // in the rest frame, before the turn (deform.ts).
  const neutral = m.posed?.neutral ?? mesh.basePoints;
  let painted = false;
  if (m.extension?.paint) {
    ctx.save();
    try {
      painted = m.extension.paint(ctx, {
        points: pts,
        neutral,
        turn: m.posed?.turn,
        rig: m.rig,
        weights: m.face.weights,
        lipColour: samples.lipColour,
        skinColour: samples.skinColour ?? undefined,
        faceHighlight: samples.faceHighlight ?? undefined,
        soft: samples.look.soft,
        sharpness: samples.faceSharpness ?? undefined,
        pixelScale: pixelScale(mesh, m.rig, picture.texture),
        viseme: m.viseme(),
      });
    } finally {
      ctx.restore();
    }
  }
  if (painted) return;
  if (picture.field && !m.extension) {
    paintCharacterMouth(m, neutral);
    return;
  }
  m.classicMouth.paint({
    pts,
    neutral,
    weights: m.face.weights,
    lipColour: samples.lipColour,
    skinColour: samples.skinColour,
    mouthOpen: m.tuning.mouthOpen,
    teethThreshold: m.tuning.teethThreshold,
    extension: m.extension,
    viseme: m.viseme,
  });
}

/** The character mouth's opening, read off the moved lips, and painted. */
function paintCharacterMouth(m: MouthSurface, neutral: readonly Point[]): void {
  const opening = characterOpening(m.pts, neutral);
  if (!opening) return;
  paintCharacter(m.ctx, {
    opening,
    clip: openingPath(opening, () => new Path2D()),
    lowerEdge: lowerEdgePath(opening, () => new Path2D()),
    weights: m.face.weights,
    look: m.picture.samples.look,
    traits: m.traits,
    tongueRaise: m.face.tongue,
    cavityShade: m.profile.cavityShade,
  });
}
