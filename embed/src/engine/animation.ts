/**
 * The face's animation, a step at a time and without drawing: the mouth
 * toward the shape the voice asks for now (or the pose a mouth driver
 * gives), the voice's loudness standing in over a silent stretch of the
 * track; the tongue; and the involuntary motion (motion.ts), told how the
 * speech is going. And the speech's course as the motion follows it: an
 * utterance begun, its track grown or re-synced, ended.
 *
 * The speech (speech.ts), the motion and the face state (state.ts) are the
 * engine's; this sequences them.
 */
import type { MouthPose } from "../mouth-extension";
import { ZERO_WEIGHTS, type BlendWeights, type Cue, type EngineTuning, type Rig } from "../types";
import { emphasisBeats, utteranceMs } from "./cues";
import { FrameStep } from "./frame-loop";
import type { Motion } from "./motion";
import { articulate, easeTongue, type SpeechTrack } from "./speech";
import type { FaceState } from "./state";

export class FaceAnimation {
  private readonly frameStep = new FrameStep();
  /** The mouth's target while nothing speaks: one, reset each frame, not a
   *  copy a frame. */
  private readonly rest: BlendWeights = { ...ZERO_WEIGHTS };

  constructor(
    private readonly speech: SpeechTrack,
    private readonly motion: Motion,
    private readonly face: FaceState,
    private readonly visemes: Rig["visemes"],
    /** A mouth driver's pose, which wins over the cue track's. */
    private readonly pose: (() => MouthPose | null) | undefined
  ) {}

  /** The cue track's co-articulated shape now, or rest when the voice is
   *  paused (SpeechTrack.blendedWeights). */
  blendedCueWeights(now: number, smoothness: number): BlendWeights {
    return this.speech.blendedWeights(now, this.visemes, smoothness);
  }

  /** The sound being made now: a mouth driver's, else the cue track's. */
  visemeNow(now: number): string {
    return this.pose?.()?.viseme ?? this.speech.currentViseme(now);
  }

  /**
   * One step to frame time `now`. `tongue`: the picture has a character
   * mouth's field, whose tongue eases toward the sound being made.
   */
  step(now: number, tuning: EngineTuning, tongue: boolean): void {
    const speech = this.speech;
    const face = this.face;
    // Viseme targets: co-articulated blend across cues (+ amplitude
    // fallback when the track is silent but audio clearly isn't).
    const visemeWeights =
      this.pose?.()?.weights ??
      (speech.speaking ? this.blendedCueWeights(now, tuning.smoothness) : Object.assign(this.rest, ZERO_WEIGHTS));
    const silent = speech.speaking && speech.currentViseme(now) === "sil";
    if (silent) {
      const amp = speech.amplitude();
      if (amp > 0.06) visemeWeights.jawOpen = Math.min(0.5, amp * 1.2);
    }
    // Waiting for the voice to start is not a pause in it. Cue time holds at
    // 0 until the audio plays, which takes hundreds of ms on a phone, and a
    // greeting that opens on /h/ is silence at 0: counted as a pause, it
    // began with a breath, a blink and a glance away before the first word.
    this.motion.notePause(now, silent && !speech.awaitingVoice());
    face.targetWeights = visemeWeights;

    // The frame's step, clamped (frame-loop.ts).
    const dt = this.frameStep.next(now);
    articulate(face.weights, face.targetWeights, dt, tuning.smoothness);

    if (tongue) face.tongue = easeTongue(face.tongue, this.visemeNow(now), dt);

    this.motion.headScale = tuning.headMotion;
    this.motion.update(dt, now, {
      speaking: speech.speaking,
      wordActive: speech.speaking && !silent,
      energy: speech.speaking
        ? Math.min(1, face.weights.jawOpen + face.weights.mouthStretch * 0.5 + speech.amplitude())
        : 0,
      cueTime: () => speech.cueTime(now),
    });
  }

  // --- The speech's course, as the motion follows it -------------------------

  /** An utterance of `cues` begins at `now`: the speech has its track. */
  begin(now: number, cues: Cue[]): void {
    this.motion.beginSpeech(now, utteranceMs(cues), emphasisBeats(this.speech.cues));
    if (this.motion.mode === "3d") this.motion.setSpeechCues(this.speech.cues);
  }

  /** The speech's track was replaced (it grew), at cue time `ms`. */
  retrack(ms: number): void {
    this.motion.setBeats(emphasisBeats(this.speech.cues), ms);
    if (this.motion.mode === "3d") this.motion.setSpeechCues(this.speech.cues, ms);
  }

  /** The speech's clock was re-aligned to cue time `ms`. */
  resync(ms: number): void {
    this.motion.placeBeatWalker(ms);
    if (this.motion.mode === "3d") this.motion.setSpeechCues(this.speech.cues, ms);
  }

  /** The speech ended, stopped or on its own, at `now`: the mouth heads
   *  for rest. */
  end(now: number): void {
    this.face.targetWeights = { ...ZERO_WEIGHTS };
    this.motion.endSpeech(now);
  }
}
