import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ROOT } from "./browser";
import {
  MARKS_MS,
  clickTrackWav,
  launchFor,
  measure,
  median,
  summary,
  type BrowserName,
  type Timing,
} from "./speech-timing";

/**
 * Cached speech in sync with the mouth, in real browsers.
 *
 * The speech cache stores every line as MP3 (backend
 * app/services/tts/speech_codec.py), and an MP3 starts late by its
 * encoder's delay unless the decoder honours the LAME header that names it:
 * 46 ms at Kokoro's 24 kHz, the mouth that far ahead of the voice. Here a
 * click track (speech-timing.ts) is encoded by that very module
 * (backend/scripts/encode_speech.py) and played as the widget plays it
 * (speech-timing-page.ts), and the clicks are found again in what the
 * browser produced:
 *
 * - decodeAudioData must put every mark on its own sample;
 * - through the audio element, what the engine's cue clock reads when each
 *   mark comes out must be where it reads for the WAV (the route through
 *   the audio graph is the same for both, so the difference is the
 *   format's), and near the mark's own time;
 * - at the start of a line, played natively, the clock must not run ahead
 *   of the voice (media-clock.ts: some browsers fire `playing` well before
 *   the sound).
 *
 * Every number is printed. SPEECH_TIMING_BROWSERS (default chromium) names
 * the browsers; CI runs chromium, firefox and webkit. The encoder needs
 * soundfile and numpy: backend/.venv's Python, or LIVEFACE_PYTHON.
 */

const BROWSERS = (process.env.SPEECH_TIMING_BROWSERS ?? "chromium").split(",") as BrowserName[];
/** Where to keep what each page recorded (CI uploads it when a test fails). */
const DUMPS = process.env.SPEECH_TIMING_DUMP_DIR;
const dumpOf = (name: string) => (DUMPS ? join(DUMPS, `${name}.json`) : undefined);

/** How far the MP3 may play from where the WAV plays, ms. */
const FORMAT_TOLERANCE_MS = 10;
/** How far the clock may be from a mark's time when it comes out, ms: the
 *  browser's own route through the audio graph included. */
const CLOCK_TOLERANCE_MS = 40;
/** How far ahead of the voice the clock may run at the start of a line, ms:
 *  a browser's own first position can be ahead by about 20. */
const STARTUP_LEAD_MS = 40;

interface Clip {
  b64: string;
  mime: string;
}

/** The click track as the speech cache stores it, and as the WAV it came from. */
function encodeAsTheCacheDoes(): { wav: Clip; cached: Clip } {
  const venv = join(ROOT, "../backend/.venv/bin/python");
  const python = process.env.LIVEFACE_PYTHON ?? (existsSync(venv) ? venv : "python3");
  const dir = mkdtempSync(join(tmpdir(), "speech-timing-"));
  try {
    const wav = clickTrackWav();
    writeFileSync(join(dir, "marks.wav"), wav);
    const script = join(ROOT, "../backend/scripts/encode_speech.py");
    const run = spawnSync(python, [script, join(dir, "marks.wav"), join(dir, "marks.out")], { encoding: "utf8" });
    if (run.status !== 0) {
      throw new Error(
        `the speech cache's encoder did not run with ${python}: it needs soundfile and numpy ` +
          `(pip install -c backend/constraints.txt soundfile numpy), or LIVEFACE_PYTHON set to a Python ` +
          `that has them\n${run.error ? String(run.error) : run.stderr}`
      );
    }
    return {
      wav: { b64: wav.toString("base64"), mime: "audio/wav" },
      cached: { b64: readFileSync(join(dir, "marks.out")).toString("base64"), mime: run.stdout.trim() },
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Played through the recorder until at least three marks came out (WebKit's
 *  route into the audio graph sometimes starts late and drops some). */
async function routed(browser: Browser, clip: Clip, name: string): Promise<Timing> {
  let timing: Timing | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    timing = await measure(browser, clip.b64, clip.mime, true, dumpOf(`${name}-routed-${attempt}`));
    if (timing.found.length >= 3) return timing;
  }
  throw new Error(`only marks ${timing!.found.join(", ")} came out of ${clip.mime}`);
}

let clips: { wav: Clip; cached: Clip };

beforeAll(() => {
  clips = encodeAsTheCacheDoes();
});

describe.each(BROWSERS)("cached speech in %s", (name) => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await launchFor(name);
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
  });

  it("is stored as MP3", () => {
    expect(clips.cached.mime).toBe("audio/mpeg");
  });

  it("decodes with every mark on its own sample, and plays where the WAV does", async () => {
    const wav = await routed(browser, clips.wav, `${name}-wav`);
    const mp3 = await routed(browser, clips.cached, `${name}-mp3`);
    const format = median(mp3.engine) - median(wav.engine);
    console.log(
      `${name}: decodeAudioData, MP3 marks minus source (ms) ${summary(mp3.decoded)}\n` +
        `${name}: engine clock minus source when each mark came out (ms), at ${wav.rate} Hz\n` +
        `  WAV marks ${wav.found.join(",")}: ${summary(wav.engine)} (element ${summary(wav.element)})\n` +
        `  MP3 marks ${mp3.found.join(",")}: ${summary(mp3.engine)} (element ${summary(mp3.element)})\n` +
        `  MP3 minus WAV, medians: ${format.toFixed(1)} ms`
    );
    expect(mp3.decoded).toHaveLength(MARKS_MS.length);
    for (const offset of mp3.decoded) expect(Math.abs(offset)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(format)).toBeLessThanOrEqual(FORMAT_TOLERANCE_MS);
    expect(Math.abs(median(wav.engine))).toBeLessThanOrEqual(CLOCK_TOLERANCE_MS);
  }, 120_000);

  it("starts the mouth with the voice, not with `playing`", async () => {
    for (const [label, clip] of [
      ["wav", clips.wav],
      ["mp3", clips.cached],
    ] as const) {
      const { startup } = await measure(browser, clip.b64, clip.mime, false, dumpOf(`${name}-${label}-native`));
      console.log(
        `${name}: ${clip.mime} played natively: position moved ${startup.playingToMoving.toFixed(0)} ms after \`playing\`; ` +
          `clock at most ${startup.maxLead.toFixed(0)} ms ahead of the voice, ${startup.leadOver20Ms.toFixed(0)} ms of it by over 20`
      );
      expect(startup.maxLead).toBeLessThanOrEqual(STARTUP_LEAD_MS);
    }
  }, 120_000);
});
