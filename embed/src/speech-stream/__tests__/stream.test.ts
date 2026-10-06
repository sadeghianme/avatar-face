import { describe, expect, it, vi } from "vitest";

import { streamSpeech } from "../index";

/**
 * The orchestration between wire and engine. The player is faked (it needs
 * Web Audio) and the protocol has its own tests; what is checked here is the
 * contract callers rely on: phrases reach the player in order with joined
 * cues, a whole recording plays through the engine's ordinary path, an
 * error frame rejects and stops, and stop aborts cleanly.
 */
const pcm = (samples: number) => {
  const bytes = new Uint8Array(samples * 2);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};
const chunk = (sequence: number, start: number, samples: number) => ({
  type: "chunk",
  sequence,
  start_sample: start,
  sample_count: samples,
  sample_rate: 24000,
  pcm_b64: pcm(samples),
  cues: [
    { t: 0, viseme: "aa", a: 1 },
    { t: samples / 24, viseme: "sil", a: 1 },
  ],
  baseline_cues: [
    { t: 0, viseme: "aa", a: 1 },
    { t: samples / 24, viseme: "sil", a: 1 },
  ],
});
const ndjson = (frames: object[]) =>
  new Response(new Blob([frames.map((f) => JSON.stringify(f)).join("\n") + "\n"]).stream(), { status: 200 });

const fakeEngine = () => ({
  playAudio: vi.fn((_a: string, _m: string, _c: unknown[], onEnd?: () => void) => onEnd?.()),
  playCues: vi.fn(),
  syncCueTime: vi.fn(),
  stopSpeech: vi.fn(),
  isSpeaking: () => false,
  updateCueTrack: vi.fn(),
});
const fakePlayer = () => {
  let resolve!: () => void;
  const done = new Promise<void>((r) => (resolve = r));
  return { append: vi.fn(), finish: vi.fn(() => resolve()), stop: vi.fn(() => resolve()), done, unlock: vi.fn() };
};

describe("streamSpeech", () => {
  it("queues phrases in order with cues joined at their offsets", async () => {
    const engine = fakeEngine();
    const player = fakePlayer();
    const handle = streamSpeech(
      engine as never,
      async () =>
        ndjson([
          { type: "start", version: 1, mode: "phrases" },
          chunk(0, 0, 2400),
          chunk(1, 2400, 4800),
          { type: "done", chunks: 2, total_samples: 7200, sample_rate: 24000 },
        ]),
      { player: player as never }
    );
    await handle.done;
    expect(player.append).toHaveBeenCalledTimes(2);
    const [, offset1, cues1] = player.append.mock.calls[1];
    expect(offset1).toBeCloseTo(0.1, 6);
    // The first phrase's closing silence at the boundary is superseded by the
    // second phrase starting there: one track, no double cue at the join.
    expect(cues1.map((c: { t: number }) => c.t)).toEqual([0, 100, 300]);
    expect(player.finish).toHaveBeenCalled();
    const recording = await handle.recording;
    expect(recording.duration_ms).toBe(300);
    expect(recording.audio_mime).toBe("audio/wav");
  });

  it("plays a whole recording through the engine's ordinary path", async () => {
    const engine = fakeEngine();
    const player = fakePlayer();
    const handle = streamSpeech(
      engine as never,
      async () =>
        ndjson([
          { type: "start", version: 1, mode: "recording" },
          {
            type: "recording",
            audio_b64: "AAAA",
            audio_mime: "audio/wav",
            duration_ms: 500,
            cues: [
              { t: 0, viseme: "aa", a: 1 },
              { t: 500, viseme: "sil", a: 1 },
            ],
            baseline_cues: [
              { t: 0, viseme: "aa", a: 1 },
              { t: 500, viseme: "sil", a: 1 },
            ],
            timing_source: "existing_provider",
          },
          { type: "done", chunks: 0 },
        ]),
      { player: player as never }
    );
    await handle.done;
    expect(engine.playAudio).toHaveBeenCalledTimes(1);
    expect(player.append).not.toHaveBeenCalled();
    expect((await handle.recording).duration_ms).toBe(500);
  });

  it("an error frame rejects, stops the player and closes the mouth", async () => {
    const engine = fakeEngine();
    const player = fakePlayer();
    const handle = streamSpeech(
      engine as never,
      async () =>
        ndjson([
          { type: "start", version: 1, mode: "phrases" },
          chunk(0, 0, 2400),
          { type: "error", code: "speech_stream_failed", detail: "boom" },
        ]),
      { player: player as never }
    );
    await expect(handle.done).rejects.toThrow("boom");
    await expect(handle.recording).rejects.toThrow();
    expect(player.stop).toHaveBeenCalled();
    expect(engine.stopSpeech).toHaveBeenCalled();
  });

  it("a stream that ends without done is an error, not a shortened recording", async () => {
    const player = fakePlayer();
    const handle = streamSpeech(
      fakeEngine() as never,
      async () => ndjson([{ type: "start", version: 1, mode: "phrases" }, chunk(0, 0, 2400)]),
      { player: player as never }
    );
    await expect(handle.done).rejects.toThrow(/without finishing/);
  });

  it("a non-2xx response is an error", async () => {
    const handle = streamSpeech(fakeEngine() as never, async () => new Response("nope", { status: 429 }), {
      player: fakePlayer() as never,
    });
    await expect(handle.done).rejects.toThrow("429");
  });

  it("stop() aborts and later frames are ignored", async () => {
    const engine = fakeEngine();
    const player = fakePlayer();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const handle = streamSpeech(
      engine as never,
      async () => {
        await gate;
        return ndjson([
          { type: "start", version: 1, mode: "phrases" },
          chunk(0, 0, 2400),
          { type: "done", chunks: 1, total_samples: 2400, sample_rate: 24000 },
        ]);
      },
      { player: player as never }
    );
    handle.stop();
    release();
    await handle.done;
    expect(player.append).not.toHaveBeenCalled();
    expect(player.stop).toHaveBeenCalled();
  });
});
