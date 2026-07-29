/**
 * Free client-side TTS via the Web Speech API (speechSynthesis).
 *
 * Much better voice quality than the server's offline tone generator —
 * real system voices, no API keys — at the cost of: no audio stream (so no
 * caching or server metering) and no native viseme events. Lip-sync is
 * driven by estimated per-character cues, re-synchronized on every word
 * boundary event the engine emits.
 */
import { Cue } from "./types";

const LATIN: Record<string, string> = {
  a: "aa", e: "E", i: "ih", o: "oh", u: "ou", y: "ih",
  b: "PP", p: "PP", m: "PP", f: "FF", v: "FF", w: "ou",
  t: "DD", d: "DD", k: "kk", g: "kk", q: "kk", c: "kk", x: "SS",
  j: "CH", h: "kk", s: "SS", z: "SS", n: "nn", l: "nn", r: "RR",
};
const ROTATION = ["aa", "ih", "oh", "E", "ou", "kk", "nn", "DD"];

function charViseme(ch: string): string {
  const base = ch.normalize("NFD")[0]?.toLowerCase() ?? "";
  if (LATIN[base]) return LATIN[base];
  if (/\p{L}/u.test(ch)) return ROTATION[(ch.codePointAt(0) ?? 0) % ROTATION.length];
  return "sil";
}

export function estimatedCues(text: string, durationMs: number): Cue[] {
  const chars = [...text];
  if (!chars.length) return [{ t: 0, viseme: "sil" }];
  const step = durationMs / chars.length;
  const cues: Cue[] = [];
  let last: string | null = null;
  chars.forEach((ch, i) => {
    const viseme = charViseme(ch);
    if (viseme !== last) {
      cues.push({ t: Math.round(i * step), viseme });
      last = viseme;
    }
  });
  cues.push({ t: durationMs, viseme: "sil" });
  return cues;
}

/** What BrowserTTS needs from an engine (both 2D and 3D provide it). */
export interface CuePlayer {
  playCues(cues: Cue[]): void;
  syncCueTime(ms: number): void;
  stopSpeech(): void;
}

/** Timing for one utterance: cue track plus word-start anchors. */
export interface CueTiming {
  cues: Cue[];
  durationMs: number;
  /** ms offset of each word start, keyed by its character index. */
  wordMarks: { char: number; t: number }[];
}

export class BrowserTTS {
  private active = false;

  /**
   * @param cueSource Fetches server-modelled timing for the text. The browser
   *   voice plays audio we never get a handle on, so timing cannot come from
   *   the waveform. Without this we fall back to a flat ms-per-character
   *   guess, which is what made the mouth look unrelated to the speech.
   */
  constructor(
    private player: CuePlayer,
    private cueSource?: (text: string) => Promise<CueTiming | null>
  ) {}

  static supported(): boolean {
    return typeof window !== "undefined" && "speechSynthesis" in window;
  }

  /** Voice list (async: some browsers populate it lazily). */
  static voices(): Promise<SpeechSynthesisVoice[]> {
    return new Promise((resolve) => {
      const have = speechSynthesis.getVoices();
      if (have.length) return resolve(have);
      const timer = setTimeout(() => resolve(speechSynthesis.getVoices()), 1200);
      speechSynthesis.addEventListener(
        "voiceschanged",
        () => {
          clearTimeout(timer);
          resolve(speechSynthesis.getVoices());
        },
        { once: true }
      );
    });
  }

  isSpeaking(): boolean {
    return this.active;
  }

  private heartbeat = 0;
  private startTimeout = 0;

  async speak(text: string, voiceURI?: string, lang?: string): Promise<void> {
    this.stop();
    // Fetch BEFORE speaking: cues must be ready the instant onstart fires,
    // or the first word plays against a still-closed mouth.
    let timing: CueTiming | null = null;
    if (this.cueSource) {
      try {
        timing = await this.cueSource(text);
      } catch {
        timing = null; // Offline or API down: the local estimate still works.
      }
    }
    return new Promise((resolve, reject) => {
      const utterance = new SpeechSynthesisUtterance(text);
      const voice = speechSynthesis
        .getVoices()
        .find((v) => v.voiceURI === voiceURI || v.name === voiceURI);
      if (voice) utterance.voice = voice;
      else if (lang) utterance.lang = lang;

      const estimate = timing?.durationMs ?? Math.max(600, text.length * 60);
      const perChar = estimate / Math.max([...text].length, 1);
      const cues = timing?.cues ?? estimatedCues(text, estimate);
      // Word-boundary events correct the clock so drift never accumulates.
      // With server timing each word start has an exact offset; otherwise we
      // fall back to interpolating at a uniform rate.
      const marks = timing?.wordMarks ?? [];
      const timeAtChar = (charIndex: number): number => {
        if (!marks.length) return charIndex * perChar;
        let lo = 0;
        let hi = marks.length - 1;
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1;
          if (marks[mid].char <= charIndex) lo = mid;
          else hi = mid - 1;
        }
        const mark = marks[lo];
        if (mark.char > charIndex) return mark.t;
        // Interpolate within the word so mid-word boundaries land sensibly.
        const next = marks[lo + 1];
        if (!next) return Math.min(estimate, mark.t + (charIndex - mark.char) * perChar);
        const span = next.char - mark.char;
        const frac = span > 0 ? (charIndex - mark.char) / span : 0;
        return mark.t + (next.t - mark.t) * Math.min(1, frac);
      };
      let settled = false;

      utterance.onstart = () => {
        clearTimeout(this.startTimeout);
        this.active = true;
        this.player.playCues(cues);
        // Chrome bug #2: long speech silently dies after ~15s unless the
        // engine is poked with resume() periodically.
        this.heartbeat = window.setInterval(() => {
          if (speechSynthesis.speaking) speechSynthesis.resume();
        }, 5000);
      };
      utterance.onboundary = (event) => {
        if (typeof event.charIndex === "number") {
          this.player.syncCueTime(timeAtChar(event.charIndex));
        }
      };
      const finish = () => {
        clearInterval(this.heartbeat);
        clearTimeout(this.startTimeout);
        this.active = false;
        this.player.stopSpeech();
      };
      utterance.onend = () => {
        finish();
        settled = true;
        resolve();
      };
      utterance.onerror = (event) => {
        finish();
        settled = true;
        // Cancellation must not surface as an error.
        if (event.error === "canceled" || event.error === "interrupted") resolve();
        else reject(new Error(`speechSynthesis: ${event.error}`));
      };

      // Chrome bug #1: speak() in the same tick as cancel() is silently
      // dropped. Defer the actual speak, and if onstart never fires the
      // promise must still settle so callers don't hang forever.
      setTimeout(() => {
        speechSynthesis.resume(); // a stuck paused engine also blocks speech
        speechSynthesis.speak(utterance);
        this.startTimeout = window.setTimeout(() => {
          if (!settled && !speechSynthesis.speaking) {
            finish();
            settled = true;
            reject(new Error("speechSynthesis: utterance never started"));
          }
        }, 4000);
      }, 100);
    });
  }

  stop(): void {
    clearInterval(this.heartbeat);
    clearTimeout(this.startTimeout);
    if (BrowserTTS.supported()) speechSynthesis.cancel();
    if (this.active) {
      this.active = false;
      this.player.stopSpeech();
    }
  }
}
