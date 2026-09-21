import type { Cue } from "../types";

export interface LabSpeech {
  audio_b64: string;
  audio_mime: string;
  duration_ms: number;
  cues: Cue[];
  baseline_cues: Cue[];
  timing_source: "native_phonemes" | "existing_provider";
}

export interface SpeechChunk {
  type: "chunk";
  sequence: number;
  start_sample: number;
  sample_count: number;
  sample_rate: number;
  pcm_b64: string;
  cues: Cue[];
  baseline_cues: Cue[];
}

/** Fetch frames need not align with UTF-8 characters or JSON lines. A missing
 * terminal frame is an error, not a successful shortened recording. */
export async function* speechEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      if (pending.length > 16_000_000) throw new Error("Speech packet is too large");
      let end: number;
      while ((end = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, end).trim();
        pending = pending.slice(end + 1);
        if (line) {
          const event: unknown = JSON.parse(line);
          if (!event || typeof event !== "object" || !("type" in event)) throw new Error("Invalid speech event");
          yield event as Record<string, unknown>;
        }
      }
      if (done) {
        if (pending.trim()) throw new Error("Speech stream ended inside a packet");
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function validateCues(value: unknown, duration: number): asserts value is Cue[] {
  if (!Array.isArray(value) || !value.length || value.length > 12000) throw new Error("Missing speech timings");
  let previous = -1;
  for (const cue of value) {
    if (!cue || !Number.isFinite(cue.t) || cue.t < previous || cue.t < 0 || cue.t > duration + 2
        || typeof cue.viseme !== "string" || cue.viseme.length > 12
        || (cue.a !== undefined && (!Number.isFinite(cue.a) || cue.a < 0 || cue.a > 1))) {
      throw new Error("Invalid speech timings");
    }
    previous = cue.t;
  }
}

const base64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (let at = 0; at < bytes.length; at += 8192) binary += String.fromCharCode(...bytes.subarray(at, at + 8192));
  return btoa(binary);
};

/** Validated PCM plus global native cues, also used for no-cost replay/export. */
export class SpeechAssembly {
  readonly sampleRate = 24000;
  samples = 0;
  chunks = 0;
  cues: Cue[] = [];
  baseline: Cue[] = [];
  private pcm: Uint8Array[] = [];

  append(event: Record<string, unknown>): { samples: Float32Array; offset: number } {
    const chunk = event as unknown as SpeechChunk;
    if (chunk.type !== "chunk" || chunk.sequence !== this.chunks || chunk.start_sample !== this.samples
        || chunk.sample_rate !== this.sampleRate || !Number.isInteger(chunk.sample_count)
        || chunk.sample_count <= 0 || chunk.sample_count > this.sampleRate * 90
        || this.samples + chunk.sample_count > this.sampleRate * 180 || typeof chunk.pcm_b64 !== "string") {
      throw new Error("Speech chunks arrived out of order or with an invalid format");
    }
    const duration = chunk.sample_count * 1000 / this.sampleRate;
    validateCues(chunk.cues, duration); validateCues(chunk.baseline_cues, duration);
    const binary = atob(chunk.pcm_b64);
    if (binary.length !== chunk.sample_count * 2) throw new Error("Incomplete speech audio");
    const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
    const view = new DataView(bytes.buffer);
    const samples = new Float32Array(chunk.sample_count);
    for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
    const offset = this.samples / this.sampleRate;
    const join = (previous: Cue[], next: Cue[]) => [
      ...previous.filter(c => c.t < offset * 1000),
      ...next.map(c => ({ ...c, t: offset * 1000 + Math.min(c.t, duration) })),
    ];
    this.cues = join(this.cues, chunk.cues);
    this.baseline = join(this.baseline, chunk.baseline_cues);
    this.pcm.push(bytes); this.samples += chunk.sample_count; this.chunks++;
    return { samples, offset };
  }

  finish(event: Record<string, unknown>): LabSpeech {
    if (event.type !== "done" || !this.chunks || event.chunks !== this.chunks
        || event.total_samples !== this.samples || event.sample_rate !== this.sampleRate) {
      throw new Error("Speech ended before all audio arrived");
    }
    const bytes = new Uint8Array(44 + this.samples * 2);
    const view = new DataView(bytes.buffer);
    const tag = (at: number, text: string) => [...text].forEach((c, i) => bytes[at + i] = c.charCodeAt(0));
    tag(0, "RIFF"); view.setUint32(4, bytes.length - 8, true); tag(8, "WAVE"); tag(12, "fmt ");
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, this.sampleRate, true); view.setUint32(28, this.sampleRate * 2, true);
    view.setUint16(32, 2, true); view.setUint16(34, 16, true); tag(36, "data");
    view.setUint32(40, this.samples * 2, true);
    let at = 44;
    for (const part of this.pcm) { bytes.set(part, at); at += part.length; }
    return { audio_b64: base64(bytes), audio_mime: "audio/wav", duration_ms: this.samples * 1000 / this.sampleRate,
      cues: this.cues, baseline_cues: this.baseline, timing_source: "native_phonemes" };
  }
}

export function bufferedRecording(event: Record<string, unknown>): LabSpeech {
  if (event.type !== "recording" || typeof event.audio_b64 !== "string" || !event.audio_b64.length
      || typeof event.audio_mime !== "string" || !event.audio_mime.startsWith("audio/")
      || !Number.isFinite(event.duration_ms) || (event.duration_ms as number) <= 0
      || event.timing_source !== "existing_provider") throw new Error("Invalid recording");
  validateCues(event.cues, event.duration_ms as number);
  validateCues(event.baseline_cues, event.duration_ms as number);
  return event as unknown as LabSpeech;
}
