import type { CuePlayer } from "../browser-tts";
import type { Cue } from "../types";

type Receiver = CuePlayer & { updateCueTrack?: (cues: Cue[]) => void };
interface Span { start: number; end: number; offset: number }

/**
 * Maps scheduled audio time to content time, excluding buffer underruns.
 * Scheduling is Web Audio's, not JS timers or animation-frame cadence: a
 * phrase is queued to start the instant the previous one ends, and a gap
 * only opens when the network is slower than the voice.
 */
export class StreamTimeline {
  spans: Span[] = [];
  schedule(now: number, duration: number, offset: number): Span {
    const start = Math.max(now + 0.06, this.spans[this.spans.length - 1]?.end ?? 0);
    const span = { start, end: start + duration, offset };
    this.spans.push(span);
    return span;
  }
  position(now: number): number {
    let position = 0;
    for (const span of this.spans) {
      if (now < span.start) break;
      position = span.offset + Math.min(now - span.start, span.end - span.start);
    }
    return position;
  }
  active(now: number): boolean {
    return this.spans.some((s) => now >= s.start && now < s.end);
  }
  get end(): number {
    return this.spans[this.spans.length - 1]?.end ?? Infinity;
  }
  get bufferGaps(): number {
    return this.spans.filter((span, i) => i > 0 && span.start - this.spans[i - 1].end > 0.02).length;
  }
}

/**
 * Plays a phrase stream into one engine.
 *
 * Graduated from the lab's two-receiver comparison player. Audio phrases are
 * appended as they arrive and scheduled back to back; cues extend the
 * engine's track without restarting articulation, and the engine's cue clock
 * is re-synced to the output clock every tick so the mouth follows the
 * audio, not a timer. A buffer gap freezes time and closes the lips rather
 * than letting the mouth run ahead of silence.
 */
export class StreamingSpeechPlayer {
  readonly timeline = new StreamTimeline();
  readonly done: Promise<void>;
  private resolveDone!: () => void;
  private sources = new Set<AudioBufferSourceNode>();
  private timer: ReturnType<typeof setInterval>;
  private stopped = false;
  private sealed = false;
  private speaking = false;
  private dirty = false;
  private first = true;
  private paused = false;
  private cues: Cue[] = [];
  private lastTime = 0;
  private lastState = "";

  constructor(
    private engine: Receiver,
    private context = new AudioContext({ latencyHint: "interactive", sampleRate: 24000 }),
    private onState: (state: "playing" | "buffering", first: boolean) => void = () => {}
  ) {
    this.done = new Promise((resolve) => {
      this.resolveDone = resolve;
    });
    this.timer = setInterval(() => this.tick(), 20);
  }

  /** Call inside the click gesture, before waiting on the network. */
  async unlock(): Promise<void> {
    await this.context.resume();
    if (!this.stopped && this.context.state !== "running") {
      throw new Error("Allow audio playback, then try again");
    }
  }

  private outputTime(): number {
    if (this.paused || this.context.state !== "running") return this.lastTime;
    const stamp = this.context.getOutputTimestamp?.();
    const output =
      stamp &&
      typeof stamp.contextTime === "number" &&
      stamp.contextTime > 0 &&
      typeof stamp.performanceTime === "number" &&
      stamp.performanceTime > 0
        ? stamp.contextTime + Math.max(0, (performance.now() - stamp.performanceTime) / 1000)
        : this.context.currentTime - (this.context.baseLatency || 0) - (this.context.outputLatency || 0);
    this.lastTime = Math.max(this.lastTime, Math.min(this.context.currentTime, Math.max(0, output)));
    return this.lastTime;
  }

  get position(): number {
    return this.timeline.position(this.outputTime());
  }

  /** Queue one phrase: PCM at 24 kHz, its offset in seconds, and the whole
   *  cue track so far (the assembly already joined the offsets). */
  append(samples: Float32Array, offset: number, cues: Cue[]): void {
    if (this.stopped || this.sealed) throw new Error("Speech stream is no longer active");
    const buffer = this.context.createBuffer(1, samples.length, 24000);
    buffer.copyToChannel(new Float32Array(samples), 0);
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.context.destination);
    const span = this.timeline.schedule(this.context.currentTime, samples.length / 24000, offset);
    this.sources.add(source);
    source.onended = () => {
      source.disconnect();
      this.sources.delete(source);
    };
    source.start(span.start);
    this.cues = cues;
    this.dirty = true;
    this.tick();
  }

  private closeMouth(): void {
    if (this.speaking) {
      this.engine.stopSpeech();
      this.speaking = false;
    }
  }

  private tick(): void {
    if (this.stopped) return;
    const now = this.outputTime();
    if (this.paused || this.context.state !== "running") {
      this.closeMouth();
      return;
    }
    if (this.sealed && now >= this.timeline.end) {
      this.stop();
      return;
    }
    const active = this.timeline.active(now);
    if (active) {
      if (!this.speaking) this.engine.playCues(this.cues);
      else if (this.dirty) (this.engine.updateCueTrack ?? this.engine.playCues).call(this.engine, this.cues);
      this.speaking = true;
      this.dirty = false;
      this.engine.syncCueTime(this.position * 1000);
    } else {
      this.closeMouth();
    }
    const state = active ? "playing" : "buffering";
    if (state !== this.lastState) {
      this.lastState = state;
      this.onState(state, active && this.first);
      if (active) this.first = false;
    }
  }

  /** No more phrases will arrive; stop once the last one has played. */
  finish(): void {
    this.sealed = true;
    this.tick();
  }

  async pause(): Promise<void> {
    this.outputTime();
    this.paused = true;
    this.closeMouth();
    await this.context.suspend();
  }

  async resume(): Promise<void> {
    await this.unlock();
    this.paused = false;
    this.lastState = "";
    this.tick();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.timer);
    this.closeMouth();
    for (const source of this.sources) {
      source.onended = null;
      source.stop();
      source.disconnect();
    }
    this.sources.clear();
    void this.context.close().catch(() => {});
    this.resolveDone();
  }
}
