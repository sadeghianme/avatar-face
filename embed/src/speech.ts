/**
 * Streaming speech: multilingual sentence splitting + a prefetching queue.
 *
 * Long text starts in first-sentence latency: synth(chunk N+1) runs WHILE
 * chunk N plays. Cancellation uses a generation counter — anything resolved
 * for a stale generation is dropped silently.
 */
import type { ExpressionCue } from "./engine/expression-mixer";
import {
  TAG_PATTERN,
  expressionMarks,
  timeExpressionMarks,
  type ExpressionMark,
  type ExpressionMode,
} from "./expression-markup";
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
    if (prev && (chunk.length < MIN_CHUNK || prev.length < MIN_CHUNK) && prev.length + chunk.length + 1 <= MAX_CHUNK) {
      merged[merged.length - 1] = `${prev} ${chunk}`;
    } else {
      merged.push(chunk);
    }
  }
  return merged;
}

/** Synthesise `text`; with `wordMarks`, ask for each word's start time too
 *  (the API's word_marks), which places a text's expressions. */
export type SynthFn = (text: string, options?: { wordMarks?: boolean }) => Promise<SynthesisPayload>;

export interface SpeechPlayer {
  /** `expressions`: the chunk's expression track (expression-markup.ts), on
   *  the same clock as `cues`. */
  playAudio(audioB64: string, mime: string, cues: Cue[], onEnd?: () => void, expressions?: ExpressionCue[]): void;
  stopSpeech(): void;
}

/** How a queue reads the expressions in a text (docs/emotions.md). */
export interface SpeechQueueOptions {
  /** "tags" (the default): `[happy]` and the like; "auto": those, or the
   *  automatic mode's guess for a text without any; "off": none (tags are
   *  still stripped). */
  expressions?: ExpressionMode;
  /** The text's language, for the automatic mode's words. */
  locale?: string;
}

/** A chunk to say: what is spoken, and its expressions. */
interface Chunk {
  text: string;
  marks: ExpressionMark[];
}

/**
 * The chunks of `text`, each with its tags taken out and its marks. A chunk
 * that is only tags says nothing: its marks go to the start of the next. The
 * last chunk of a text with any mark releases them at its end.
 */
export function speechChunks(text: string, mode: ExpressionMode = "tags", locale?: string): Chunk[] {
  const chunks: Chunk[] = [];
  let carried: ExpressionMark[] = [];
  // Each tag held out of the sentence split ("[happy:0.5]" holds a full
  // stop), as a token no rule splits, and put back in its chunk.
  const tags: string[] = [];
  const masked = text.replace(TAG_PATTERN, (tag) => `\uE000${tags.push(tag) - 1}\uE001`);
  for (const piece of splitSentences(masked)) {
    const raw = piece.replace(/\uE000(\d+)\uE001/g, (_, k: string) => tags[Number(k)]);
    const parsed = expressionMarks(raw, mode, locale);
    const marks = [...carried.map((m) => ({ ...m, char: 0 })), ...parsed.marks];
    if (!parsed.text) {
      carried = marks;
      continue;
    }
    carried = [];
    chunks.push({ text: parsed.text, marks });
  }
  const last = chunks[chunks.length - 1];
  if (last && chunks.some((c) => c.marks.length))
    last.marks.push({ char: last.text.length, name: "neutral", intensity: 0 });
  return chunks;
}

export class SpeechQueue {
  private generation = 0;
  private active = false;

  constructor(
    private player: SpeechPlayer,
    private synth: SynthFn,
    private options: SpeechQueueOptions = {}
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
    const chunks = speechChunks(text, this.options.expressions, this.options.locale);
    if (!chunks.length) return;
    this.active = true;
    // Word times only for a chunk with expressions to place.
    const synth = (c: Chunk) => (c.marks.length ? this.synth(c.text, { wordMarks: true }) : this.synth(c.text));

    let pending: Promise<SynthesisPayload> | null = synth(chunks[0]);
    try {
      for (let i = 0; i < chunks.length; i++) {
        const payload = await pending;
        if (generation !== this.generation || !payload) return;
        // Prefetch the NEXT chunk while this one plays.
        pending = i + 1 < chunks.length ? synth(chunks[i + 1]) : null;
        const { text: said, marks } = chunks[i];
        const track = marks.length
          ? timeExpressionMarks(marks, said, payload.duration_ms, payload.word_marks)
          : undefined;
        await new Promise<void>((resolve) => {
          const { audio_b64, audio_mime, cues } = payload;
          if (track) this.player.playAudio(audio_b64, audio_mime, cues, resolve, track);
          else this.player.playAudio(audio_b64, audio_mime, cues, resolve);
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
