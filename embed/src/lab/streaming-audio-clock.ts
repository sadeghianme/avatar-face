import type { CuePlayer } from "../browser-tts";
import type { Cue } from "../types";

type StreamReceiver = CuePlayer & { updateCueTrack?: (cues: Cue[]) => void };
interface Span { start: number; end: number; offset: number; }

/** Maps scheduled audio time to content time, excluding network underruns.
 * Scheduling is done by Web Audio, not JS timers or animation frame cadence. */
export class StreamTimeline {
  spans: Span[] = [];
  schedule(now: number, duration: number, offset: number): Span {
    const start = Math.max(now + .06, this.spans[this.spans.length - 1]?.end ?? 0);
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
  active(now: number): boolean { return this.spans.some(s => now >= s.start && now < s.end); }
  get end(): number { return this.spans[this.spans.length - 1]?.end ?? Infinity; }
  get bufferGaps(): number {
    return this.spans.filter((span, i) => i > 0 && span.start - this.spans[i - 1].end > .02).length;
  }
}

/** One physical audio output for both previews. Native timings are appended
 * without restarting speech animation. A gap freezes time and closes lips. */
export class StreamingAudioComparison {
  readonly timeline = new StreamTimeline();
  readonly done: Promise<void>;
  leadMs = 0;
  private resolveDone!: () => void;
  private sources = new Set<AudioBufferSourceNode>();
  private timer: ReturnType<typeof setInterval>;
  private stopped = false;
  private sealed = false;
  private speaking = false;
  private dirty = false;
  private first = true;
  private paused = false;
  private baselineCues: Cue[] = [];
  private improvedCues: Cue[] = [];
  private lastTime = 0;
  private lastState = "";

  constructor(private baseline: StreamReceiver, private improved: StreamReceiver,
    private context = new AudioContext({ latencyHint: "interactive", sampleRate: 24000 }),
    private onState: (state: "playing" | "buffering", first: boolean) => void = () => {},
  ) {
    this.done = new Promise(resolve => { this.resolveDone = resolve; });
    this.timer = setInterval(() => this.tick(), 20);
  }

  // Call in the click gesture, before waiting for the network response.
  async unlock(): Promise<void> {
    await this.context.resume();
    if (!this.stopped && this.context.state !== "running") throw new Error("Allow audio playback, then try again");
  }

  private outputTime(): number {
    if (this.paused || this.context.state !== "running") return this.lastTime;
    const stamp = this.context.getOutputTimestamp?.();
    const output = stamp && typeof stamp.contextTime === "number" && stamp.contextTime > 0
        && typeof stamp.performanceTime === "number" && stamp.performanceTime > 0
      ? stamp.contextTime + Math.max(0, (performance.now() - stamp.performanceTime) / 1000)
      : this.context.currentTime - (this.context.baseLatency || 0) - (this.context.outputLatency || 0);
    this.lastTime = Math.max(this.lastTime, Math.min(this.context.currentTime, Math.max(0, output)));
    return this.lastTime;
  }
  get position(): number { return this.timeline.position(this.outputTime()); }
  readonly readTime = (): number => Math.max(0, this.position * 1000 + this.leadMs);

  append(samples: Float32Array, offset: number, baseline: Cue[], improved: Cue[]): void {
    if (this.stopped || this.sealed) throw new Error("Speech stream is no longer active");
    const buffer = this.context.createBuffer(1, samples.length, 24000);
    buffer.copyToChannel(new Float32Array(samples), 0);
    const source = this.context.createBufferSource();
    source.buffer = buffer; source.connect(this.context.destination);
    const span = this.timeline.schedule(this.context.currentTime, samples.length / 24000, offset);
    this.sources.add(source);
    source.onended = () => { source.disconnect(); this.sources.delete(source); };
    source.start(span.start);
    this.baselineCues = baseline; this.improvedCues = improved; this.dirty = true;
    this.tick();
  }

  private closeMouth(): void {
    if (this.speaking) { this.baseline.stopSpeech(); this.improved.stopSpeech(); this.speaking = false; }
  }

  private tick(): void {
    if (this.stopped) return;
    const now = this.outputTime();
    if (this.paused || this.context.state !== "running") { this.closeMouth(); return; }
    if (this.sealed && now >= this.timeline.end) { this.stop(); return; }
    const active = this.timeline.active(now);
    if (active) {
      if (!this.speaking) {
        this.baseline.playCues(this.baselineCues); this.improved.playCues(this.improvedCues);
      } else if (this.dirty) {
        (this.baseline.updateCueTrack ?? this.baseline.playCues).call(this.baseline, this.baselineCues);
        (this.improved.updateCueTrack ?? this.improved.playCues).call(this.improved, this.improvedCues);
      }
      this.speaking = true; this.dirty = false;
      this.baseline.syncCueTime(this.position * 1000); this.improved.syncCueTime(this.readTime());
    } else this.closeMouth();
    const state = active ? "playing" : "buffering";
    if (state !== this.lastState) {
      this.lastState = state;
      this.onState(state, active && this.first);
      if (active) this.first = false;
    }
  }
  finish(): void { this.sealed = true; this.tick(); }
  async pause(): Promise<void> {
    this.outputTime(); this.paused = true; this.closeMouth();
    await this.context.suspend();
  }
  async resume(): Promise<void> {
    await this.unlock();
    this.paused = false; this.lastState = ""; this.tick();
  }
  stop(): void {
    if (this.stopped) return;
    this.stopped = true; clearInterval(this.timer); this.closeMouth();
    for (const source of this.sources) { source.onended = null; source.stop(); source.disconnect(); }
    this.sources.clear();
    void this.context.close().catch(() => {});
    this.resolveDone();
  }
}
