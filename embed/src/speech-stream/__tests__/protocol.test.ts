import { describe, expect, it } from "vitest";
import { SpeechAssembly, speechEvents } from "../protocol";

const packet = (sequence = 0, start = 0) => ({ type: "chunk", sequence, start_sample: start,
  sample_count: 3, sample_rate: 24000, pcm_b64: btoa("\0\0\xff\x7f\0\x80"),
  cues: [{ t: 0, viseme: "PP" }, { t: .125, viseme: "sil" }], baseline_cues: [{ t: 0, viseme: "aa" }] });

describe("speech stream protocol", () => {
  it("assembles exact PCM and fractional sample-aligned cue offsets for replay", () => {
    const speech = new SpeechAssembly();
    const first = speech.append(packet());
    expect([...first.samples]).toEqual([0, 32767 / 32768, -1]);
    expect(speech.append(packet(1, 3)).offset).toBe(.000125);
    const saved = speech.finish({ type: "done", chunks: 2, total_samples: 6, sample_rate: 24000 });
    const wav = atob(saved.audio_b64);
    expect(wav.slice(0, 4)).toBe("RIFF"); expect(wav.length).toBe(56);
    expect(wav.slice(44, 50)).toBe(wav.slice(50));
    expect(saved.duration_ms).toBe(.25);
    expect(saved.cues.map(c => c.t)).toEqual([0, .125, .25]);
    expect(saved.timing_source).toBe("native_phonemes");
  });
  it.each([
    { sequence: 1 }, { start_sample: 9 }, { sample_rate: 48000 }, { sample_count: -1 },
    { pcm_b64: "AA==" }, { cues: [] }, { cues: [{ t: 90, viseme: "aa" }] },
    { cues: [{ t: 0, viseme: "aa", a: 3 }] },
  ])("rejects an invalid or out-of-order packet: %j", patch => {
    expect(() => new SpeechAssembly().append({ ...packet(), ...patch })).toThrow();
  });
  it("rejects duplicates and missing terminal samples", () => {
    const speech = new SpeechAssembly(); speech.append(packet());
    expect(() => speech.append(packet())).toThrow();
    expect(() => speech.finish({ type: "done", chunks: 1, total_samples: 4, sample_rate: 24000 })).toThrow();
  });
  it("parses UTF-8/JSON split anywhere, including one byte per frame", async () => {
    const bytes = new TextEncoder().encode('\n{"type":"error","detail":"سلام"}\n{"type":"done"}\n');
    const body = new ReadableStream<Uint8Array>({ start(c) { for (const byte of bytes) c.enqueue(new Uint8Array([byte])); c.close(); } });
    const events = [];
    for await (const event of speechEvents(body)) events.push(event);
    expect(events).toEqual([{ type: "error", detail: "سلام" }, { type: "done" }]);
  });
  it("does not silently accept a truncated packet", async () => {
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode('{"type":"done"')); c.close(); } });
    await expect((async () => { for await (const _event of speechEvents(body)) { /* consume */ } })()).rejects.toThrow("inside a packet");
  });
});
