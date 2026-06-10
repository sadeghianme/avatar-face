/**
 * Streaming speech: multilingual sentence splitting + a prefetching queue.
 *
 * Long text starts in first-sentence latency: synth(chunk N+1) runs WHILE
 * chunk N plays. Cancellation uses a generation counter — anything resolved
 * for a stale generation is dropped silently.
 */
import { Cue, SynthesisPayload } from "./types";

// Sentence terminators: Latin . ! ? ; … plus CJK 。！？ Arabic ؟ Devanagari ।
const SENTENCE_END = /[.!?;…。！？؟।]+["')\]»]?/g;
const MAX_CHUNK = 220;
const MIN_CHUNK = 24;

/** Split text into speakable chunks: sentences, hard-wrapped, tiny ones merged. */
export function splitSentences(text: string): string[] {
  const raw: string[] = [];
  for (const line of text.split(/\n+/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let last = 0;
    for (const match of trimmed.matchAll(SENTENCE_END)) {
      const end = match.index! + match[0].length;
      const sentence = trimmed.slice(last, end).trim();
      if (sentence) raw.push(sentence);
      last = end;
    }
    const tail = trimmed.slice(last).trim();
    if (tail) raw.push(tail);
  }

  // Hard-wrap anything over MAX_CHUNK chars (split on spaces where possible).
  const wrapped: string[] = [];
  for (const sentence of raw) {
    if (sentence.length <= MAX_CHUNK) {
      wrapped.push(sentence);
      continue;
    }
    let rest = sentence;
    while (rest.length > MAX_CHUNK) {
      let cut = rest.lastIndexOf(" ", MAX_CHUNK);
      if (cut < MAX_CHUNK * 0.4) cut = MAX_CHUNK; // no usable space: hard cut
      wrapped.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) wrapped.push(rest);
  }

  // Merge tiny fragments into their neighbor.
  const merged: string[] = [];
  for (const chunk of wrapped) {
    const prev = merged[merged.length - 1];
    if (prev && (chunk.length < MIN_CHUNK || prev.length < MIN_CHUNK) &&
        prev.length + chunk.length + 1 <= MAX_CHUNK) {
      merged[merged.length - 1] = `${prev} ${chunk}`;
    } else {
      merged.push(chunk);
    }
  }
  return merged;
}

export type SynthFn = (text: string) => Promise<SynthesisPayload>;

export interface SpeechPlayer {
  playAudio(audioB64: string, mime: string, cues: Cue[], onEnd?: () => void): void;
  stopSpeech(): void;
}

export class SpeechQueue {
  private generation = 0;
  private active = false;

  constructor(
    private player: SpeechPlayer,
    private synth: SynthFn
  ) {}

  isSpeaking(): boolean {
    return this.active;
  }

  stop(): void {
    this.generation++;
    this.active = false;
    this.player.stopSpeech();
  }

  /** Speak long text chunk-by-chunk with prefetch. Resolves when done or stopped. */
  async speak(text: string): Promise<void> {
    this.stop();
    const generation = ++this.generation;
    const chunks = splitSentences(text);
    if (!chunks.length) return;
    this.active = true;

    let pending: Promise<SynthesisPayload> | null = this.synth(chunks[0]);
    try {
      for (let i = 0; i < chunks.length; i++) {
        const payload = await pending;
        if (generation !== this.generation || !payload) return;
        // Prefetch the NEXT chunk while this one plays.
        pending = i + 1 < chunks.length ? this.synth(chunks[i + 1]) : null;
        await new Promise<void>((resolve) => {
          this.player.playAudio(payload.audio_b64, payload.audio_mime, payload.cues, resolve);
        });
        if (generation !== this.generation) return;
      }
    } catch (err) {
      // A fetch aborted by stop() must not surface as an error.
      if (generation !== this.generation) return;
      throw err;
    } finally {
      if (generation === this.generation) this.active = false;
    }
  }
}
