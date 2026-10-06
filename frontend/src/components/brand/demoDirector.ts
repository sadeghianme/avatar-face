import type { AvatarEngine, Cue } from "@liveface/embed";

/**
 * Plays the marketing demo: the product's own engine, speaking lines that
 * were rendered by the product's own voices (Kokoro, on the production
 * server) with the cues measured from that audio. Nothing here is a mock.
 *
 * Muted by default — browsers refuse sound before a click, and a landing page
 * that shouts is a landing page people close. The mouth then runs on a timer
 * with exactly the timing the audio has; turning sound on switches the clock
 * to the audio element so lips and voice stay locked together.
 *
 * Framework-free and tiny on purpose: the page imports this eagerly to render
 * captions and chips, while the engine itself arrives later in its own chunk.
 */

export interface DemoWord {
  w: string;
  t: number;
}

export interface DemoLine {
  locale: string;
  voiceName: string;
  text: string;
  durationMs: number;
  cues: Cue[];
  words: DemoWord[];
}

/** `unavailable`: the engine could not load; the still portrait stays. */
export type DemoPhase = "loading" | "scanning" | "ready" | "speaking" | "paused" | "unavailable";

export interface DemoSnapshot {
  phase: DemoPhase;
  lineIndex: number;
  wordIndex: number;
  viseme: string;
  soundOn: boolean;
  /** The face rig has been "found" — the scan intro finished. */
  rigged: boolean;
  line: DemoLine | null;
}

type Engine = Pick<AvatarEngine, "playCues" | "syncCueTime" | "stopSpeech">;

/** How open the mouth is for each viseme, 0..1. Drives the level meters. */
const OPENNESS: Record<string, number> = {
  sil: 0,
  PP: 0.05,
  FF: 0.18,
  TH: 0.3,
  DD: 0.3,
  kk: 0.35,
  CH: 0.35,
  SS: 0.28,
  nn: 0.25,
  RR: 0.35,
  aa: 1,
  E: 0.7,
  ih: 0.55,
  oh: 0.85,
  ou: 0.5,
};

const GAP_MS = 1300;

export class DemoDirector {
  /** Target mouth openness right now; meters smooth toward it per frame. */
  target = 0;
  private snapshot: DemoSnapshot = {
    phase: "loading",
    lineIndex: -1,
    wordIndex: -1,
    viseme: "sil",
    soundOn: false,
    rigged: false,
    line: null,
  };
  private listeners = new Set<() => void>();
  private engine: Engine | null = null;
  private lines: DemoLine[] = [];
  private voiceUrls: string[] = [];
  private audio: HTMLAudioElement | null = null;
  private usingAudio = false;
  private lineStart = 0;
  private raf = 0;
  private timer = 0;
  private started = false;
  private visible = true;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): DemoSnapshot => this.snapshot;

  private set(patch: Partial<DemoSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  attach(engine: Engine, lines: DemoLine[], voiceUrls: string[]): void {
    this.engine = engine;
    this.lines = lines;
    this.voiceUrls = voiceUrls;
  }

  setPhase(phase: DemoPhase): void {
    this.set({ phase });
  }

  markRigged(): void {
    this.set({ rigged: true });
  }

  start(from = 0): void {
    if (!this.engine || !this.lines.length) return;
    this.started = true;
    if (this.visible) this.play(from);
  }

  /**
   * Sound on or off. MUST be called from a click handler when turning sound
   * on: the audio element is created and played inside the gesture, which is
   * what unlocks playback on iOS for every later line.
   */
  setSound(on: boolean): void {
    if (on === this.snapshot.soundOn) return;
    if (on && !this.audio) {
      this.audio = new Audio();
      this.audio.preload = "auto";
    }
    this.set({ soundOn: on });
    if (!on) this.audio?.pause();
    // Restart the current line so the voice starts from its first word.
    if (this.started && this.visible) this.play(Math.max(0, this.snapshot.lineIndex));
  }

  /** Scrolled away or tab hidden: stop cleanly; resume where it was. */
  setVisible(visible: boolean): void {
    if (visible === this.visible) return;
    this.visible = visible;
    if (!visible) {
      this.halt();
      if (this.started) this.set({ phase: "paused" });
    } else if (this.started) {
      window.clearTimeout(this.timer);
      this.timer = window.setTimeout(() => this.play(Math.max(0, this.snapshot.lineIndex)), 350);
    }
  }

  /** The engine is going away (unmount): stop, and forget it. */
  detach(): void {
    this.halt();
    this.started = false;
    this.engine = null;
  }

  /**
   * The stage is unmounting: silence everything and release the audio.
   *
   * Deliberately reversible. React's StrictMode unmounts and remounts every
   * component once in development, and a director that refused to start
   * again after that would sit on "Loading" forever.
   */
  stop(): void {
    this.halt();
    this.started = false;
    this.audio?.removeAttribute("src");
    this.audio = null;
    if (this.snapshot.soundOn) this.set({ soundOn: false });
  }

  private halt(): void {
    cancelAnimationFrame(this.raf);
    window.clearTimeout(this.timer);
    this.audio?.pause();
    this.engine?.stopSpeech();
    this.target = 0;
  }

  private play(index: number): void {
    const engine = this.engine;
    const line = this.lines[index];
    if (!engine || !line) return;
    this.halt();
    this.set({ phase: "speaking", lineIndex: index, wordIndex: 0, viseme: "sil", line });

    this.usingAudio = false;
    if (this.snapshot.soundOn && this.audio) {
      const audio = this.audio;
      audio.src = this.voiceUrls[index];
      audio.currentTime = 0;
      audio.onended = () => this.endLine(index);
      this.usingAudio = true;
      const playing = audio.play();
      playing?.catch(() => {
        // Refused (no gesture yet, or muted by the OS): keep going silently
        // on the timer rather than freezing with an open mouth.
        this.usingAudio = false;
        this.lineStart = performance.now();
        this.set({ soundOn: false });
      });
    }
    engine.playCues(line.cues);
    this.lineStart = performance.now();
    this.raf = requestAnimationFrame(() => this.frame(index));
  }

  private frame(index: number): void {
    const engine = this.engine;
    const line = this.lines[index];
    if (!engine || !line) return;
    const t = this.usingAudio && this.audio ? this.audio.currentTime * 1000 : performance.now() - this.lineStart;
    if (this.usingAudio) engine.syncCueTime(t);

    let word = 0;
    while (word + 1 < line.words.length && line.words[word + 1].t <= t) word++;
    let cue: Cue | undefined;
    for (const c of line.cues) {
      if (c.t > t) break;
      cue = c;
    }
    const viseme = cue?.viseme ?? "sil";
    this.target = (OPENNESS[viseme] ?? 0.3) * (cue?.a ?? 1);
    if (word !== this.snapshot.wordIndex || viseme !== this.snapshot.viseme) this.set({ wordIndex: word, viseme });

    if (!this.usingAudio && t >= line.durationMs) {
      this.endLine(index);
      return;
    }
    this.raf = requestAnimationFrame(() => this.frame(index));
  }

  private endLine(index: number): void {
    cancelAnimationFrame(this.raf);
    this.engine?.stopSpeech();
    this.target = 0;
    const line = this.lines[index];
    this.set({ phase: "ready", wordIndex: line ? line.words.length : -1, viseme: "sil" });
    window.clearTimeout(this.timer);
    if (this.started && this.visible) {
      this.timer = window.setTimeout(() => this.play((index + 1) % this.lines.length), GAP_MS);
    }
  }
}
