/**
 * Where a cached line's sound is when the engine's clock says it is, in a
 * real browser: the Node side of speech-timing.test.ts.
 *
 * A click track (sharp 2 kHz bursts at known samples, 24 kHz like Kokoro) is
 * encoded as the speech cache stores it, played by speech-timing-page.ts as
 * the widget plays it, and the bursts are found again in what the browser
 * decoded.
 */
import { chromium, firefox, webkit, type Browser } from "playwright";

import { bundle, serve } from "./browser";
import { RECORDER } from "./speech-recorder";
import type { ClockSample, DecodedRun, PlaybackRun } from "./speech-timing-page";

export const RATE = 24000;
export const TRACK_MS = 3000;
/** Where the marks start, in ms of the source. The first is near the start:
 *  a decoder that drops or adds a frame at the head shows there. */
export const MARKS_MS = [80, 500, 1000, 1500, 2000, 2500];
/** Each mark is two bursts, the second this long after the first for mark
 *  k: a mark is known by its own gap, wherever a capture starts. */
const gapOf = (k: number) => 40 + 20 * k;
const BURST_MS = 4;
const BURST_HZ = 2000;

function burst(rate: number): Float64Array {
  const n = Math.round((BURST_MS / 1000) * rate);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    out[i] = Math.sin((2 * Math.PI * BURST_HZ * i) / rate) * hann;
  }
  return out;
}

/** The click track as 16-bit mono PCM WAV. */
export function clickTrackWav(): Buffer {
  const length = (RATE * TRACK_MS) / 1000;
  const pcm = new Float64Array(length);
  const shape = burst(RATE);
  MARKS_MS.forEach((ms, k) => {
    for (const at of [ms, ms + gapOf(k)]) {
      const from = Math.round((at / 1000) * RATE);
      for (let i = 0; i < shape.length; i++) pcm[from + i] += 0.8 * shape[i];
    }
  });
  const wav = Buffer.alloc(44 + length * 2);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + length * 2, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); // PCM
  wav.writeUInt16LE(1, 22); // mono
  wav.writeUInt32LE(RATE, 24);
  wav.writeUInt32LE(RATE * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(length * 2, 40);
  for (let i = 0; i < length; i++) wav.writeInt16LE(Math.round(pcm[i] * 32767), 44 + i * 2);
  return wav;
}

function floats(b64: string): Float32Array {
  const bytes = Buffer.from(b64, "base64");
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

/**
 * Where each burst starts in `signal` (sampled at `rate`), in samples: the
 * first sample above a third of the loudest, then the lag that best matches
 * the burst's own shape just before it.
 */
function burstStarts(signal: Float32Array, rate: number): number[] {
  const shape = burst(rate);
  let peak = 0;
  for (const value of signal) peak = Math.max(peak, Math.abs(value));
  if (peak === 0) return [];
  const threshold = peak / 3;
  const starts: number[] = [];
  let i = 0;
  while (i < signal.length) {
    if (Math.abs(signal[i]) < threshold) {
      i++;
      continue;
    }
    let best = i;
    let bestScore = -Infinity;
    const from = Math.max(0, i - shape.length);
    const to = Math.min(signal.length - shape.length, i + Math.round(rate * 0.001));
    for (let lag = from; lag <= to; lag++) {
      let score = 0;
      for (let j = 0; j < shape.length; j++) score += signal[lag + j] * shape[j];
      if (score > bestScore) {
        bestScore = score;
        best = lag;
      }
    }
    starts.push(best);
    i = best + Math.round(rate * 0.02);
  }
  return starts;
}

/** The marks in `signal`: which one (known by its gap), and where it starts, in samples. */
export function marks(signal: Float32Array, rate: number): { k: number; at: number }[] {
  const starts = burstStarts(signal, rate);
  const found: { k: number; at: number }[] = [];
  for (let i = 0; i + 1 < starts.length; i++) {
    const gap = ((starts[i + 1] - starts[i]) / rate) * 1000;
    const k = Math.round((gap - gapOf(0)) / (gapOf(1) - gapOf(0)));
    if (k < 0 || k >= MARKS_MS.length || Math.abs(gap - gapOf(k)) > 3) continue;
    found.push({ k, at: starts[i] });
    i++;
  }
  return found;
}

/** `value` of `samples` at perf time `at`, by a straight line through the
 *  readings within `span` ms of it (the element refreshes its position in
 *  steps). */
function clockAt(samples: ClockSample[], at: number, value: (s: ClockSample) => number, span = 40): number {
  const near = samples.filter((s) => !s.paused && Math.abs(s.perf - at) <= span);
  if (near.length < 3) return Number.NaN;
  const n = near.length;
  const mx = near.reduce((sum, s) => sum + (s.perf - at), 0) / n;
  const my = near.reduce((sum, s) => sum + value(s), 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (const s of near) {
    sxy += (s.perf - at - mx) * (value(s) - my);
    sxx += (s.perf - at - mx) ** 2;
  }
  const slope = sxx > 0 ? sxy / sxx : 0;
  return my - slope * mx;
}

export function median(values: number[]): number {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return Number.NaN;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** One recording in one browser; every offset is ms, one per mark found. */
export interface Timing {
  /** Where each mark is in what decodeAudioData made, minus where it is in
   *  the source: the decoder's own offset, to the sample. */
  decoded: number[];
  /** What the engine's cue clock read when each mark reached the audio
   *  graph, minus the mark's time in the source. Positive: the clock is
   *  ahead of the sound (the mouth leads the voice). It includes the route
   *  through the graph, the same for every format, so a format's own share
   *  is its difference from the WAV's. */
  engine: number[];
  /** As `engine`, for the element's currentTime itself. */
  element: number[];
  /** The marks found in the capture, by their source ms. */
  found: number[];
  /** The start of the line, played natively: ms from the first `playing` to
   *  the element's position first moving; and how far, at most, the
   *  engine's clock ran ahead of where the voice was (the steady playback's
   *  line through the element's positions, taken back to its start), and
   *  for how long by more than 20 ms. */
  startup: { playingToMoving: number; maxLead: number; leadOver20Ms: number };
  rate: number;
}

export type BrowserName = "chromium" | "firefox" | "webkit";

/** `name` as the tests launch it: a voice may play without a click. */
export function launchFor(name: BrowserName): Promise<Browser> {
  switch (name) {
    case "chromium":
      return chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
    case "firefox":
      return firefox.launch({
        firefoxUserPrefs: { "media.autoplay.default": 0, "media.autoplay.block-webaudio": false },
      });
    case "webkit":
      return webkit.launch();
  }
}

const ORIGIN = "https://speech.test";

/**
 * Play `b64` (base64, as the API sends it) of type `mime` in `browser`.
 * `routed`: through the recorder (the marks are found in what was played);
 * else natively, as the widget plays it, for the clocks alone.
 */
export async function measure(browser: Browser, b64: string, mime: string, routed: boolean): Promise<Timing> {
  const script = await bundle("browser-tests/speech-timing-page.ts");
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await serve(page, ORIGIN, (path) =>
    path === "/"
      ? `<!doctype html><meta charset=utf-8><body></body>`
      : path === "/page.js"
        ? script
        : path === "/recorder.js"
          ? RECORDER
          : undefined
  );
  try {
    await page.goto(`${ORIGIN}/`);
    await page.addScriptTag({ url: `${ORIGIN}/page.js` });
    const decoded: DecodedRun = await page.evaluate((audio) => window.decode(audio), b64);
    await page.evaluate(([audio, type, recorder, route]) => window.arm(audio, type, recorder, route), [
      b64,
      mime,
      RECORDER,
      routed,
    ] as const);
    await page.click("#play");
    const run: PlaybackRun = await page.evaluate(() => window.played!);
    if (errors.length) throw new Error(errors.join("\n"));
    if (!run.ended) throw new Error("the recording never ended");
    return analyse(decoded, run);
  } finally {
    await page.close();
  }
}

function startup(run: PlaybackRun): Timing["startup"] {
  const moving = run.samples.find((s) => s.element > 0);
  // Where the voice is: the line through the steady playback's positions,
  // each at the moment it first showed (a browser that refreshes the
  // position every 40 ms holds each value for 40 ms, and a line through
  // every reading would sit half a step behind).
  const steady = run.samples.filter(
    (s, i) => i > 0 && !s.paused && s.element >= 800 && s.element <= 2500 && s.element !== run.samples[i - 1].element
  );
  const n = steady.length;
  const mx = steady.reduce((sum, s) => sum + s.perf, 0) / n;
  const my = steady.reduce((sum, s) => sum + s.element, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (const s of steady) {
    sxy += (s.perf - mx) * (s.element - my);
    sxx += (s.perf - mx) ** 2;
  }
  const voice = (perf: number) => Math.max(0, my + (sxy / sxx) * (perf - mx));
  let maxLead = 0;
  let over = 0;
  const early = run.samples.filter((s) => s.element < 800 && s.engine > 0);
  early.forEach((s, i) => {
    const lead = s.engine - voice(s.perf);
    maxLead = Math.max(maxLead, lead);
    if (lead > 20 && i + 1 < early.length) over += early[i + 1].perf - s.perf;
  });
  return {
    playingToMoving: moving && run.playingAt !== null ? moving.perf - run.playingAt : Number.NaN,
    maxLead,
    leadOver20Ms: over,
  };
}

function analyse(decoded: DecodedRun, run: PlaybackRun): Timing {
  // Context time -> perf time, as the graph renders: ctx.currentTime is the
  // end of what it has rendered when it is read.
  const rendered = median(run.samples.map((s) => s.perf - s.ctx));
  const found = marks(floats(run.audio), run.rate);
  const engine: number[] = [];
  const element: number[] = [];
  for (const { k, at } of found) {
    const perf = rendered + ((run.firstFrame + at) / run.rate) * 1000;
    engine.push(clockAt(run.samples, perf, (s) => s.engine) - MARKS_MS[k]);
    element.push(clockAt(run.samples, perf, (s) => s.element) - MARKS_MS[k]);
  }
  return {
    decoded: marks(floats(decoded.audio), decoded.rate).map(({ k, at }) => (at / decoded.rate) * 1000 - MARKS_MS[k]),
    engine,
    element,
    found: found.map(({ k }) => MARKS_MS[k]),
    startup: startup(run),
    rate: run.rate,
  };
}

export const summary = (values: number[]): string =>
  values.length ? `[${values.map((v) => v.toFixed(1)).join(" ")}]` : "[]";
