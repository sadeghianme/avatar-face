/**
 * The face's animation, a step at a time and without drawing: the mouth
 * toward the shape the voice asks for now (or the pose a mouth driver
 * gives), the voice's loudness standing in over a silent stretch of the
 * track; the tongue; and the involuntary motion (motion.ts), told how the
 * speech is going. And the speech's course as the motion follows it: an
 * utterance begun, its track grown or re-synced, ended.
 *
 * The expressions (expression-mixer.ts) are stepped here too: the track a
 * text's tags made, walked on the speech's clock, an expression's jaw as a
 * floor while nothing is said, its gaze on top of the motion's.
 *
 * The speech (speech.ts), the motion and the face state (state.ts) are the
 * engine's; this sequences them.
 */
import type { MouthPose } from "../mouth-extension";
import { ZERO_WEIGHTS, type BlendWeights, type Cue, type EngineTuning, type Rig } from "../types";
import { emphasisBeats, utteranceMs, type Beat } from "./cues";
import { ExpressionMixer, type ExpressionCue } from "./expression-mixer";
import { FrameStep } from "./frame-loop";
import type { Motion } from "./motion";
import { articulate, easeTongue, type SpeechTrack } from "./speech";
import type { FaceState } from "./state";

export class FaceAnimation {
  private readonly frameStep = new FrameStep();
  /** The mouth's target while nothing speaks: one, reset each frame, not a
   *  copy a frame. */
  private readonly rest: BlendWeights = { ...ZERO_WEIGHTS };
  /** The expressions over time (engine.setExpression, a text's tags). */
  readonly expressions = new ExpressionMixer();
  /** The speech's accents, walked for the idle brow flash ("2d" motion:
   *  the "3d" personality flashes the brows itself). */
  private beats: Beat[] = [];
  private nextBeat = 0;

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
    const posed = this.pose?.()?.weights;
    const visemeWeights =
      posed ??
      (speech.speaking ? this.blendedCueWeights(now, tuning.smoothness) : Object.assign(this.rest, ZERO_WEIGHTS));
    this.stepExpressions(now, tuning);
    // An expression's jaw (surprise's) only while nothing is said: the
    // voice owns the jaw, and a mouth driver's pose wins over both.
    if (!posed && !speech.speaking) visemeWeights.jawOpen = this.expressions.jaw() * tuning.expression;
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

  /** The expressions at `now`: the track walked on the speech's clock, the
   *  accents' brow flash, the mix into the face state, the gaze. */
  private stepExpressions(now: number, tuning: EngineTuning): void {
    const { speech, expressions } = this;
    if (speech.speaking) {
      const cueTime = speech.cueTime(now);
      expressions.walk(cueTime, now);
      while (this.nextBeat < this.beats.length && this.beats[this.nextBeat].t <= cueTime) {
        this.nextBeat++;
        if (this.motion.mode === "2d") expressions.accent(now);
      }
    }
    this.face.expression = expressions.step(now, speech.speaking);
    const bias = expressions.gaze(this.motion.gazeBias);
    bias.x *= tuning.expression;
    bias.y *= tuning.expression;
  }

  // --- The speech's course, as the motion follows it -------------------------

  /** An utterance of `cues` begins at `now`, with the expression track a
   *  text's tags made (none: an empty track). */
  begin(now: number, cues: Cue[], expressions: readonly ExpressionCue[] = []): void {
    this.speech.begin(cues);
    this.expressions.setTrack(expressions);
    this.beats = emphasisBeats(this.speech.cues);
    this.nextBeat = 0;
    this.motion.beginSpeech(now, utteranceMs(cues), this.beats);
    if (this.motion.mode === "3d") this.motion.setSpeechCues(this.speech.cues);
  }

  /** The speech's track was replaced (it grew), at cue time `ms`. */
  retrack(ms: number): void {
    this.beats = emphasisBeats(this.speech.cues);
    this.placeBeats(ms);
    this.motion.setBeats(this.beats, ms);
    if (this.motion.mode === "3d") this.motion.setSpeechCues(this.speech.cues, ms);
  }

  /** The speech's clock was re-aligned to cue time `ms`. */
  resync(ms: number): void {
    this.placeBeats(ms);
    this.expressions.seek(ms);
    this.motion.placeBeatWalker(ms);
    if (this.motion.mode === "3d") this.motion.setSpeechCues(this.speech.cues, ms);
  }

  /** The speech ended at `now`, on its own or `stopped`: the mouth heads
   *  for rest. A stop releases what the text's tags set; a voice that ended
   *  on its own sets what of its track it did not reach (an expression at
   *  the very end carries into the next chunk; the text's closing release
   *  always lands). */
  end(now: number, stopped = false): void {
    if (stopped) this.expressions.releaseText(now);
    else this.expressions.walk(Infinity, now);
    this.face.targetWeights = { ...ZERO_WEIGHTS };
    this.motion.endSpeech(now);
  }

  /** The accents' walker placed at cue time `ms`. */
  private placeBeats(ms: number): void {
    const i = this.beats.findIndex((b) => b.t > ms);
    this.nextBeat = i < 0 ? this.beats.length : i;
  }
}
