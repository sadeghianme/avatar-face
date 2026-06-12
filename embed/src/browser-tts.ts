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

export class BrowserTTS {
  private active = false;

  constructor(private player: CuePlayer) {}

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

  speak(text: string, voiceURI?: string, lang?: string): Promise<void> {
    this.stop();
    return new Promise((resolve, reject) => {
      const utterance = new SpeechSynthesisUtterance(text);
      const voice = speechSynthesis
        .getVoices()
        .find((v) => v.voiceURI === voiceURI || v.name === voiceURI);
      if (voice) utterance.voice = voice;
      else if (lang) utterance.lang = lang;

      // ~60ms/char is a fair guess at rate 1; word-boundary events
      // continuously correct the clock so drift never accumulates.
      const estimate = Math.max(600, text.length * 60);
      const perChar = estimate / Math.max([...text].length, 1);
      const cues = estimatedCues(text, estimate);

      utterance.onstart = () => {
        this.active = true;
        this.player.playCues(cues);
      };
      utterance.onboundary = (event) => {
        if (typeof event.charIndex === "number") {
          this.player.syncCueTime(event.charIndex * perChar);
        }
      };
      const finish = () => {
        this.active = false;
        this.player.stopSpeech();
      };
      utterance.onend = () => {
        finish();
        resolve();
      };
      utterance.onerror = (event) => {
        finish();
        // Cancellation must not surface as an error.
        if (event.error === "canceled" || event.error === "interrupted") resolve();
        else reject(new Error(`speechSynthesis: ${event.error}`));
      };
      speechSynthesis.speak(utterance);
    });
  }

  stop(): void {
    if (BrowserTTS.supported()) speechSynthesis.cancel();
    if (this.active) {
      this.active = false;
      this.player.stopSpeech();
    }
  }
}
