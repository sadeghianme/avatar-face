import type { CuePlayer } from "../browser-tts";
import type { Cue } from "../types";

/** One audio source, two cue tracks. No second audio element and no RAF clock.
 * The improved renderer reads readTime() directly during its own frame. */
export class AudioClockComparison {
  private audio: HTMLAudioElement | null = null;
  private release: (() => void) | null = null;
  private baselineCues: Cue[] = [];
  private improvedCues: Cue[] = [];
  private started = false;
  leadMs = 0;

  constructor(
    private baseline: CuePlayer,
    private improved: CuePlayer,
    private createAudio = (src: string) => new Audio(src)
  ) {}

  readonly readTime = (): number => Math.max(0, (this.audio?.currentTime ?? 0) * 1000 + this.leadMs);

  get media(): HTMLAudioElement | null {
    return this.audio;
  }

  play(
    audioB64: string,
    mime: string,
    baseline: Cue[],
    improved: Cue[],
    onMedia?: (audio: HTMLAudioElement) => void
  ): Promise<void> {
    this.stop();
    this.baselineCues = baseline;
    this.improvedCues = improved;
    const audio = this.createAudio(`data:${mime};base64,${audioB64}`);
    this.audio = audio;
    return new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        if (this.audio !== audio) return;
        cleanup();
        this.audio = null;
        this.release = null;
        this.started = false;
        audio.pause();
        this.baseline.stopSpeech();
        this.improved.stopSpeech();
        audio.removeAttribute("src");
        audio.load();
        if (error) reject(error);
        else resolve();
      };
      const playing = () => {
        if (this.audio !== audio) return;
        this.started = true;
        this.baseline.playCues(this.baselineCues);
        this.improved.playCues(this.improvedCues);
        this.baseline.syncCueTime(audio.currentTime * 1000);
        this.improved.syncCueTime(this.readTime());
      };
      const pause = () => {
        this.baseline.stopSpeech();
        this.improved.stopSpeech();
      };
      const seek = () => {
        if (this.started && !audio.paused) playing();
      };
      const ended = () => finish();
      const failed = () => finish(new Error("Audio playback failed"));
      const cleanup = () => {
        audio.removeEventListener("playing", playing);
        audio.removeEventListener("pause", pause);
        audio.removeEventListener("waiting", pause);
        audio.removeEventListener("seeked", seek);
        audio.removeEventListener("ended", ended);
        audio.removeEventListener("error", failed);
      };
      audio.addEventListener("playing", playing);
      audio.addEventListener("pause", pause);
      audio.addEventListener("waiting", pause);
      audio.addEventListener("seeked", seek);
      audio.addEventListener("ended", ended);
      audio.addEventListener("error", failed);
      this.release = () => finish();
      try {
        onMedia?.(audio);
        void audio
          .play()
          .catch((error: unknown) => finish(error instanceof Error ? error : new Error("Audio playback failed")));
      } catch (error) {
        finish(error instanceof Error ? error : new Error("Audio playback failed"));
      }
    });
  }

  pause(): void {
    this.audio?.pause();
  }
  async resume(): Promise<void> {
    await this.audio?.play();
  }
  stop(): void {
    this.release?.();
  }
  destroy(): void {
    this.stop();
  }
}
