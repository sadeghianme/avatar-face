/**
 * The voice in flight, as both engines play it: the utterance's prepared
 * cue track, the clock that says where in the track the voice is, and the
 * audio element playing it. The 2D engine's SpeechTrack (speech.ts) adds
 * the amplitude fallback and reads the track for the mouth; the 3D engine
 * uses this as it is.
 */
import { MediaClock } from "./media-clock";
import type { Cue } from "../types";
import { prepareCues } from "./cues";

/** What the voice tells its engine. */
export interface SpeechHooks {
  /** The voice started playing, or was sought: cue time is now `ms`. */
  onSync(ms: number): void;
  /** The voice ended, or failed to play. */
  onEnded(): void;
}

export class Voice {
  /** The utterance's cue track, prepared (cues.ts prepareCues). */
  cues: Cue[] = [];
  speaking = false;
  /** Frame time at which cue time was 0, for the frame clock. */
  private cueStart = 0;
  protected currentAudio: HTMLAudioElement | null = null;
  /** Cue time of the audio playing now, when no external cueClock is given. */
  protected audioClock: MediaClock | null = null;
  private onAudioEnd: (() => void) | null = null;

  /** `cueClock`: the lab's opt-in clock, in audio milliseconds. */
  constructor(
    private readonly cueClock: (() => number) | undefined,
    private readonly hooks: SpeechHooks
  ) {}

  // --- The clock -------------------------------------------------------------

  /**
   * Cue time at frame time `now`, ms: the lab's clock when it has one, else
   * the audio element's own position (media-clock.ts), else the time since
   * the track started.
   */
  cueTime(now: number): number {
    const external = this.cueClock?.();
    if (external !== undefined && Number.isFinite(external)) return Math.max(0, external);
    if (this.audioClock) return this.audioClock.read(now);
    return now - this.cueStart;
  }

  /** Start the frame clock at `now` (cues with no audio element). */
  startClock(now: number): void {
    this.cueStart = now;
  }

  /** Re-align the frame clock so that cue time is `ms` at `now`. */
  seek(ms: number, now: number): void {
    this.cueStart = now - ms;
  }

  /** The voice is paused mid-utterance (the page, the OS, a headset): the
   *  mouth closes rather than freezing on whatever shape it was making. */
  voicePaused(): boolean {
    return this.audioClock?.paused ?? false;
  }

  // --- The utterance -------------------------------------------------------

  /** Take `cues` as the track in flight, and speak. */
  begin(cues: Cue[]): void {
    this.cues = prepareCues(cues);
    this.speaking = true;
  }

  /**
   * An audio element for base64 audio, made the current voice: cue time is
   * its position from now on (re-anchored on `playing` and `seeked`), unless
   * the lab's clock is in charge. `onEnd` is called when it ends.
   */
  load(audioB64: string, mime: string, onEnd: (() => void) | null): HTMLAudioElement {
    this.stopAudio();
    const audio = new Audio(`data:${mime};base64,${audioB64}`);
    this.currentAudio = audio;
    const clock = this.cueClock ? null : new MediaClock(audio);
    this.audioClock = clock;
    if (clock) {
      const sync = () => {
        if (audio !== this.currentAudio) return;
        this.hooks.onSync(clock.sync(performance.now()));
      };
      audio.addEventListener("playing", sync);
      audio.addEventListener("seeked", sync);
    }
    this.onAudioEnd = onEnd;
    return audio;
  }

  /** Play the loaded `audio`; the frame clock starts now. */
  play(audio: HTMLAudioElement): void {
    audio.addEventListener("ended", () => {
      if (audio !== this.currentAudio) return;
      this.hooks.onEnded();
    });
    audio.addEventListener("error", () => {
      if (audio !== this.currentAudio) return;
      this.hooks.onEnded();
    });
    // Undefined from browsers that predate play() returning a promise.
    const playPromise = audio.play() as Promise<void> | undefined;
    this.cueStart = performance.now();
    if (playPromise) {
      // An abort during stop() must NOT surface as an unhandled rejection.
      playPromise.catch(() => {
        if (audio === this.currentAudio) this.hooks.onEnded();
      });
    }
  }

  /** Stopped from outside: the voice cut, the track dropped. */
  stop(): void {
    this.stopAudio();
    this.speaking = false;
    this.cues = [];
  }

  /** Ended on its own: the track dropped and the audio let go of (it has
   *  stopped already). Returns the caller's onEnd, for the engine to call. */
  finish(): (() => void) | null {
    this.speaking = false;
    this.cues = [];
    const done = this.onAudioEnd;
    this.onAudioEnd = null;
    this.currentAudio = null;
    this.audioClock = null;
    return done;
  }

  /** Silence the voice; cue time goes back to the frame clock (playCues,
   *  the next playAudio). */
  stopAudio(): void {
    this.audioClock = null;
    if (this.currentAudio) {
      const audio = this.currentAudio;
      this.currentAudio = null;
      this.onAudioEnd = null;
      audio.pause();
      audio.src = "";
    }
  }
}
