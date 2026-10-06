/**
 * The speech in flight and the mouth's articulation of it.
 *
 * SpeechTrack is the voice (voice.ts: the prepared cue track, its clock,
 * the audio element) with what the 2D mouth reads of it: the shape the
 * track asks for now, the sound being made, and the voice's loudness
 * through an analyser for the amplitude fallback. `articulate` is the
 * filter that moves the mouth toward the shape the track asks for.
 */
import { TONGUE_RAISE } from "../character-paint";
import { ZERO_WEIGHTS, type BlendWeights, type Cue, type Rig } from "../types";
import { articulationLead, blendCueWeights, prepareCues, visemeAt } from "./cues";
import { Voice } from "./voice";

export class SpeechTrack extends Voice {
  private audioCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private analyserData: Uint8Array | null = null;

  // --- What the track says now --------------------------------------------

  /** The audio has been asked to play and is not heard yet (decoding, the
   *  output device waking): cue time holds at 0 meanwhile. */
  awaitingVoice(): boolean {
    return this.audioClock !== null && !this.audioClock.started;
  }

  currentViseme(now: number): string {
    if (!this.speaking || !this.cues.length || this.voicePaused()) return "sil";
    return visemeAt(this.cues, this.cueTime(now));
  }

  /** The cue track's co-articulated shape now (cues.ts blendCueWeights),
   *  read ahead of the voice by the articulation's own delay. */
  blendedWeights(now: number, visemes: Rig["visemes"], smoothness: number): BlendWeights {
    if (this.voicePaused()) return { ...ZERO_WEIGHTS };
    return blendCueWeights(this.cues, visemes, this.cueTime(now) + articulationLead(smoothness));
  }

  /** The voice's loudness now, 0..1, when the analyser is attached; else 0. */
  amplitude(): number {
    if (!this.analyser || !this.analyserData) return 0;
    this.analyser.getByteFrequencyData(this.analyserData as Uint8Array<ArrayBuffer>);
    let sum = 0;
    for (let i = 0; i < this.analyserData.length; i++) sum += this.analyserData[i];
    return sum / (this.analyserData.length * 255);
  }

  // --- The utterance -------------------------------------------------------

  /** Replace the track without restarting anything (streaming look-ahead). */
  replaceCues(cues: Cue[]): void {
    this.cues = prepareCues(cues);
  }

  /**
   * Play the loaded `audio`. `sparse`: the cue track is too thin to drive
   * the mouth, so the voice goes through the analyser for its amplitude.
   */
  override play(audio: HTMLAudioElement, sparse = false): void {
    // Only reroute through the analyser when the cue track is too sparse to
    // drive the mouth (amplitude fallback needed). Rerouting risks silent
    // playback (suspended AudioContext, Safari data:-URL taint), so rich cue
    // tracks — every Liveface provider — play natively.
    if (sparse) this.attachAnalyser(audio);
    super.play(audio);
  }

  destroy(): void {
    this.stopAudio();
    if (this.audioCtx) void this.audioCtx.close().catch(() => undefined);
    this.audioCtx = null;
  }

  private attachAnalyser(audio: HTMLAudioElement): void {
    try {
      if (!this.audioCtx) {
        const Ctor = window.AudioContext ?? (window as never as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        this.audioCtx = new Ctor();
        this.analyser = this.audioCtx.createAnalyser();
        this.analyser.fftSize = 256;
        this.analyserData = new Uint8Array(this.analyser.frequencyBinCount);
        this.analyser.connect(this.audioCtx.destination);
      }
      const ctx = this.audioCtx;
      // createMediaElementSource REROUTES the element's output through the
      // context — if the context is suspended (autoplay policy), playback
      // goes silent. Only connect once the context is confirmed running;
      // otherwise the element plays natively and we just lose the
      // amplitude fallback.
      void ctx
        .resume()
        .then(() => {
          if (ctx.state !== "running" || audio !== this.currentAudio) return;
          const source = ctx.createMediaElementSource(audio);
          source.connect(this.analyser!);
        })
        .catch(() => undefined);
    } catch {
      // Analyser is an enhancement (amplitude fallback); audio still plays.
    }
  }
}

/**
 * Per-shape inertia, as a multiple of the shared time constant.
 *
 * The jaw and the lips are not the same instrument. The jaw is a bone hung
 * on heavy muscle and it arrives at a vowel; the lips and their ring muscle
 * are light and they snap — which is exactly why /p/ /b/ /m/ read as
 * closures rather than as pauses. Driving both at one rate forced a choice
 * between a jaw that jitters through every consonant and lips too sluggish
 * to shut between two vowels.
 *
 * Kept close to 1 on purpose. The smoothing sits on top of a blend that
 * already reaches each shape in the middle of its own span, so slowing the
 * jaw much further costs peak opening on fast speech, which is a worse
 * fault than the one being fixed.
 */
const INERTIA: Record<keyof BlendWeights, number> = {
  jawOpen: 1.3,
  mouthClose: 0.7,
  mouthPucker: 0.85,
  mouthFunnel: 0.85,
  mouthStretch: 0.8,
  mouthSmile: 0.9,
};

/**
 * Move `weights` toward `target` over `dt` ms, in place.
 *
 * Critically-damped-ish approach to targets. Slow on purpose: a
 * newsreader's articulation is small and fluid, and the damping is the
 * main thing standing between cue tracks and a flapping jaw.
 * Frame-rate INDEPENDENT smoothing. A fixed fraction per frame makes the
 * effective time constant depend on how fast frames happen to arrive, so
 * any jitter in frame timing became jitter in the mouth. Convert to an
 * exponential filter over real elapsed time: rate = 1 - exp(-dt / tau).
 */
export function articulate(weights: BlendWeights, target: BlendWeights, dt: number, smoothness: number): void {
  const smoothing = Math.max(0.15, smoothness);
  // Jaws CLOSE faster than they open (muscle + gravity). Closing slower
  // than opening left the mouth hanging open through a whole sentence —
  // measured only 1% closed frames before that was corrected.
  // A second-order (critically damped) filter with the same mean delay
  // was tried here (2026-10-06): it moves the weights with no corner at
  // a target change, but with the bells already continuous it measured
  // worse (the lip gap's acceleration up 7%, its jerk up 13%: the same
  // travel in a steeper middle), so the first-order filter stays, with
  // its delay given back by ARTICULATION_LEAD_MS instead.
  const TAU_OPEN = 47 / smoothing; // ms; matches the old 0.30/frame @60fps
  const TAU_CLOSE = 33 / smoothing; // ms; matches the old 0.40/frame @60fps
  const keys = Object.keys(weights) as (keyof BlendWeights)[];
  for (const key of keys) {
    const goal = target[key];
    const tau =
      (goal > weights[key] ? TAU_OPEN : TAU_CLOSE) * INERTIA[key];
    const rate = 1 - Math.exp(-dt / tau);
    weights[key] += (goal - weights[key]) * rate;
  }
}

/** The character mouth's tongue height after `dt` ms of following
 *  `sound`, eased: the sounds are discrete and the tongue is not. */
export function easeTongue(tongue: number, sound: string, dt: number): number {
  const target = TONGUE_RAISE[sound] ?? 0;
  return tongue + (target - tongue) * (1 - Math.exp(-dt / 55));
}
