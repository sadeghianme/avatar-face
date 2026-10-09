/**
 * The page side of speech-timing.test.ts: a recording played the way the
 * widget and the share page play it (the engine's Voice: an audio element
 * on a data: URL of the API's base64, its MediaClock reading the element's
 * position), the element's position and the engine's cue clock sampled
 * every few milliseconds.
 *
 * Routed, the element's output goes through an AudioWorklet that keeps
 * every sample the browser decoded, stamped with the audio context's frame,
 * and the context's clock is sampled too, so the test can say what the
 * clocks read when each mark came out. Natively, nothing but the element
 * and the clocks: no audio context at all, as for a widget's speech. And
 * the same bytes decoded by decodeAudioData, for comparison.
 *
 * Quiet: routed, the recorder's output is zeros and the element's own
 * output is taken over by the graph; natively, the element plays at 2%.
 */
import { Voice } from "../src/engine/voice";

/** One reading of the clocks, all in ms. */
export interface ClockSample {
  perf: number;
  /** audio.currentTime. */
  element: number;
  /** The engine's cue time (Voice.cueTime: the MediaClock). */
  engine: number;
  /** The audio context's currentTime, routed: what the graph has rendered. */
  ctx: number | null;
  paused: boolean;
}

/** What one playback recorded. Audio (routed) as base64 of little-endian float32. */
export interface PlaybackRun {
  rate: number;
  firstFrame: number;
  audio: string;
  samples: ClockSample[];
  ended: boolean;
  /** perf ms: play() called, and the first `playing` event. */
  playAt: number;
  playingAt: number | null;
}

export interface DecodedRun {
  rate: number;
  audio: string;
}

declare global {
  interface Window {
    /** Make everything ready to play, short of starting it. */
    arm(b64: string, mime: string, recorderSource: string, routed: boolean): Promise<void>;
    /** Started by the page's button (a user's click: autoplay rules). */
    played: Promise<PlaybackRun> | null;
    decode(b64: string): Promise<DecodedRun>;
  }
}

function base64(samples: Float32Array): string {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

function bytesOf(b64: string): ArrayBuffer {
  const text = atob(b64);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return bytes.buffer;
}

interface Recorder {
  ctx: AudioContext;
  stop(): Promise<{ firstFrame: number; audio: Float32Array }>;
}

/** The recorder (speech-recorder.ts) on a new context, `audio` routed into it. */
async function record(audio: HTMLAudioElement, recorderSource: string): Promise<Recorder> {
  const ctx = new AudioContext();
  // As a blob: module, or where WebKit refuses one, from the page's origin
  // (where Chromium's worklet fetch bypasses the test's request routing).
  try {
    await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([recorderSource], { type: "text/javascript" })));
  } catch {
    await ctx.audioWorklet.addModule("/recorder.js");
  }
  const node = new AudioWorkletNode(ctx, "recorder", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
  });
  const chunks: { frame: number; data: Float32Array }[] = [];
  let stopped!: () => void;
  const flushed = new Promise<void>((resolve) => (stopped = resolve));
  node.port.onmessage = (event: MessageEvent<{ frame: number; data: Float32Array } | "stopped">) => {
    if (event.data === "stopped") stopped();
    else chunks.push(event.data);
  };
  node.connect(ctx.destination);
  ctx.createMediaElementSource(audio).connect(node);
  return {
    ctx,
    async stop() {
      node.port.postMessage("stop");
      await flushed;
      await ctx.close();
      chunks.sort((a, b) => a.frame - b.frame);
      const firstFrame = chunks[0]?.frame ?? 0;
      const last = chunks[chunks.length - 1];
      const all = new Float32Array(last ? last.frame + last.data.length - firstFrame : 0);
      for (const chunk of chunks) all.set(chunk.data, chunk.frame - firstFrame);
      return { firstFrame, audio: all };
    },
  };
}

let start: (() => void) | null = null;

window.played = null;

window.arm = async (b64, mime, recorderSource, routed) => {
  let ended!: () => void;
  const finished = new Promise<void>((resolve) => (ended = resolve));
  // Exactly as the engines play a recording (voice.ts): the element, its clock.
  const voice = new Voice(undefined, { onSync: () => undefined, onEnded: () => ended() });
  const audio = voice.load(b64, mime, null);
  let playingAt: number | null = null;
  audio.addEventListener("playing", () => (playingAt ??= performance.now()));
  const recorder = routed ? await record(audio, recorderSource) : null;
  if (!recorder) audio.volume = 0.02;

  start = () => {
    window.played = (async () => {
      // In the click: a context made outside a gesture starts suspended.
      void recorder?.ctx.resume().catch(() => undefined);
      voice.begin([]);
      const playAt = performance.now();
      voice.play(audio);
      const samples: ClockSample[] = [];
      const timer = setInterval(() => {
        const perf = performance.now();
        samples.push({
          perf,
          element: audio.currentTime * 1000,
          engine: voice.cueTime(perf),
          ctx: recorder ? recorder.ctx.currentTime * 1000 : null,
          paused: audio.paused,
        });
      }, 2);
      let ok = true;
      await Promise.race([
        finished,
        new Promise<void>((resolve) =>
          setTimeout(
            () => {
              ok = false;
              resolve();
            },
            (audio.duration || 10) * 1000 + 5000
          )
        ),
      ]);
      clearInterval(timer);
      await new Promise((resolve) => setTimeout(resolve, 200));
      const captured = recorder ? await recorder.stop() : null;
      return {
        rate: recorder?.ctx.sampleRate ?? 0,
        firstFrame: captured?.firstFrame ?? 0,
        audio: captured ? base64(captured.audio) : "",
        samples,
        ended: ok,
        playAt,
        playingAt,
      };
    })();
  };
};

window.decode = async (b64) => {
  const ctx = new OfflineAudioContext(1, 1, 24000);
  const buffer = await ctx.decodeAudioData(bytesOf(b64));
  return { rate: buffer.sampleRate, audio: base64(buffer.getChannelData(0)) };
};

const button = document.createElement("button");
button.id = "play";
button.textContent = "play";
button.addEventListener("click", () => start?.());
document.body.append(button);
