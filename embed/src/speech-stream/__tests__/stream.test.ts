import { describe, expect, it, vi } from "vitest";

import { spokenText } from "../../expression-markup";
import { SpeechError, STREAM_MS_PER_CHAR, streamSpeech } from "../index";

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
  playAudio: vi.fn((_a: string, _m: string, _c: unknown[], onEnd?: () => void, _x?: unknown) => onEnd?.()),
  playCues: vi.fn(),
  syncCueTime: vi.fn(),
  stopSpeech: vi.fn(),
  isSpeaking: () => false,
  updateCueTrack: vi.fn(),
});
const fakePlayer = () => {
  let resolve!: () => void;
  const done = new Promise<void>((r) => (resolve = r));
  return {
    append: vi.fn(),
    finish: vi.fn(() => resolve()),
    stop: vi.fn(() => resolve()),
    done,
    unlock: vi.fn(),
    setExpressions: vi.fn(),
  };
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

  it("places a text's expressions over the speech: guessed, then as long as heard, then exact", async () => {
    const engine = fakeEngine();
    const player = fakePlayer();
    // "[happy] Hi there. [concerned] Oh no." -> the tags out, released at the end.
    const spoken = spokenText("[happy] Hi there. [concerned] Oh no.");
    expect(spoken.text).toBe("Hi there. Oh no.");
    const handle = streamSpeech(
      engine as never,
      async () =>
        ndjson([
          { type: "start", version: 1, mode: "phrases" },
          chunk(0, 0, 24000 * 2),
          chunk(1, 24000 * 2, 24000),
          { type: "done", chunks: 2, total_samples: 24000 * 3, sample_rate: 24000 },
        ]),
      { player: player as never, expressions: spoken }
    );
    await handle.done;
    const calls = player.setExpressions.mock.calls.map(([track]) => track as { t: number; name: string }[]);
    // A guess from the text's length first, before any audio.
    const guess = Math.max(600, spoken.text.length * STREAM_MS_PER_CHAR);
    expect(calls[0].map((c) => c.name)).toEqual(["happy", "concerned", "neutral"]);
    expect(calls[0][2].t).toBe(guess);
    // The last: the speech's real length (3 s), each tag where its word is.
    const last = calls[calls.length - 1];
    expect(last[2].t).toBe(3000);
    expect(last[0].t).toBe(0);
    const at = (3000 * spoken.text.indexOf("Oh")) / spoken.text.length - 150;
    expect(last[1].t).toBe(Math.round(at));
    // Nothing of the tags reached the voice: the caller sends spoken.text.
    expect(spoken.text).not.toMatch(/\[/);
  });

  it("plays a whole recording's expressions on its own length", async () => {
    const engine = fakeEngine();
    const player = fakePlayer();
    const spoken = spokenText("[surprised:0.8] Really?");
    const handle = streamSpeech(
      engine as never,
      async () =>
        ndjson([
          { type: "start", version: 1, mode: "recording" },
          {
            type: "recording",
            audio_b64: "AAAA",
            audio_mime: "audio/wav",
            duration_ms: 800,
            cues: [
              { t: 0, viseme: "aa", a: 1 },
              { t: 800, viseme: "sil", a: 1 },
            ],
            baseline_cues: [
              { t: 0, viseme: "aa", a: 1 },
              { t: 800, viseme: "sil", a: 1 },
            ],
            timing_source: "existing_provider",
          },
          { type: "done", chunks: 0 },
        ]),
      { player: player as never, expressions: spoken }
    );
    await handle.done;
    const track = engine.playAudio.mock.calls[0][4] as unknown as { t: number; name: string; intensity: number }[];
    expect(track).toEqual([
      { t: 0, name: "surprised", intensity: 0.8 },
      { t: 800, name: "neutral", intensity: 0 },
    ]);
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

  it("an error frame's refusal reaches the caller with its code, detail and status", async () => {
    const handle = streamSpeech(
      fakeEngine() as never,
      async () =>
        ndjson([
          { type: "start", version: 1, mode: "recording" },
          {
            type: "error",
            code: "cloned_line_missing",
            detail: "This line has not been rendered in the cloned voice 'Mehdi voice' yet.",
            status: 404,
          },
        ]),
      { player: fakePlayer() as never }
    );
    const error = await handle.done.catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(SpeechError);
    expect(error).toMatchObject({
      code: "cloned_line_missing",
      detail: "This line has not been rendered in the cloned voice 'Mehdi voice' yet.",
      status: 404,
    });
  });

  it("an error frame without its fields is still a SpeechError, generic", async () => {
    const handle = streamSpeech(fakeEngine() as never, async () => ndjson([{ type: "error", status: "x" }]), {
      player: fakePlayer() as never,
    });
    const error = await handle.done.catch((reason: unknown) => reason);
    expect(error).toMatchObject({ code: "speech_stream_failed", status: null });
    expect((error as SpeechError).detail).toMatch(/interrupted/);
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
    await expect(handle.done).rejects.toMatchObject({ code: "http_429", status: 429 });
  });

  it("a refused request says the API's code and sentence", async () => {
    const refusal = new Response(JSON.stringify({ code: "speech_busy", detail: "Speech is already being prepared." }), {
      status: 429,
      headers: { "Content-Type": "application/json" },
    });
    const handle = streamSpeech(fakeEngine() as never, async () => refusal, { player: fakePlayer() as never });
    await expect(handle.done).rejects.toMatchObject({
      name: "SpeechError",
      code: "speech_busy",
      detail: "Speech is already being prepared.",
      status: 429,
      message: "Speech is already being prepared. (429 speech_busy)",
    });
  });

  it("a 200 without a body is an error", async () => {
    const empty = { ok: true, status: 200, body: null } as unknown as Response;
    const handle = streamSpeech(fakeEngine() as never, async () => empty, { player: fakePlayer() as never });
    await expect(handle.done).rejects.toThrow(/without a body/);
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
