import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { articulationLead, AvatarEngine } from "../engine";
import { engineSeam, type EngineSeam } from "../engine/seam";
import { SpeechTrack } from "../engine/speech";
import { ContinuousMouth } from "../mouth/continuous-mouth";
import { enamelReveal, RevealRamp, REVEAL_RISE_MS } from "../mouth/lip-occlusion-model";
import { validatePerformanceManifest } from "../mouth/photographic-performance-model";
import { DEFAULT_TUNING, type Cue, type Rig } from "../types";
import { fakeCanvas, NoopPath } from "./browser-fakes";

/**
 * The motion of speech, as the engine makes it from a cue track at 60 fps:
 * read ahead of the voice by the articulation's own delay, a short silence
 * inside a word passed through rather than closed on, and on the
 * production cue track (native Kokoro timing, "Hello, how are you today?
 * I am happy to help you with anything you need.") the photographic
 * mouth's lip gap moving without steps, closing only where a mouth closes.
 * The bounds are what the real engine measured in headless Chrome
 * (scratchpad motion harness, 2026-10-06), with a little room.
 */

const rig = JSON.parse(readFileSync(new URL("./fixtures/human-rig.json", import.meta.url), "utf8")) as Rig;
const track = JSON.parse(readFileSync(new URL("./fixtures/native-cues-hello.json", import.meta.url), "utf8")) as {
  cues: Cue[];
};
const manifest = validatePerformanceManifest(
  JSON.parse(readFileSync(new URL("../../../frontend/public/lab/reference/performance.json", import.meta.url), "utf8"))
);

const FRAME = 1000 / 60;

describe("the articulation of a cue track", () => {
  let now = 10_000;
  beforeEach(() => {
    now = 10_000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    // A constant the body's Box-Muller sampler accepts (0.5 is redrawn forever).
    vi.spyOn(Math, "random").mockReturnValue(0.3);
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    vi.stubGlobal("Path2D", NoopPath);
    vi.stubGlobal("document", { createElement: () => fakeCanvas() });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const engineWith = () => {
    const image = { naturalWidth: 1024, naturalHeight: 1024, width: 1024, height: 1024 } as HTMLImageElement;
    const engine = new AvatarEngine(fakeCanvas(), rig, image, { fullPhoto: true });
    engine.tuning.headMotion = 0;
    engine.tuning.bodyMotion = 0;
    return { engine, e: engineSeam(engine) };
  };

  /** Settle, play, and tick at exactly 60 fps for `ms`, sampling each frame. */
  const play = (e: EngineSeam, engine: AvatarEngine, cues: Cue[], ms: number, sample: (t: number) => void) => {
    for (let i = 0; i < 30; i++) {
      now += FRAME;
      e.tick(now);
    }
    engine.playCues(cues);
    const start = now;
    for (let t = 0; t <= ms; t += FRAME) {
      now = start + t;
      e.tick(now);
      sample(t);
    }
  };

  it("reads the track ahead of the voice by the filter's and the spring's delay", () => {
    expect(articulationLead(1)).toBe(50);
    // The filter half scales with smoothness, the spring's half does not.
    expect(articulationLead(0.5)).toBe(75);
    expect(articulationLead(2)).toBe(37.5);
    expect(articulationLead(0)).toBe(articulationLead(0.15));
  });

  it("peaks a vowel within 40 ms of its sound's centre, and starts it before the sound", () => {
    const { engine, e } = engineWith();
    // One 200 ms vowel, a word's silence either side. (A long silence
    // after it would dilute its peak: a bell as wide as a 700 ms pause
    // still pulls at the vowel's centre, which is the blend's own doing.)
    const cues: Cue[] = [
      { t: 0, viseme: "sil", a: 1 },
      { t: 300, viseme: "aa", a: 1 },
      { t: 500, viseme: "sil", a: 1 },
      { t: 700, viseme: "sil", a: 1 },
    ];
    const jaw: { t: number; open: number }[] = [];
    play(e, engine, cues, 1000, (t) => jaw.push({ t, open: e.face.weights.jawOpen }));
    const peak = jaw.reduce((best, s) => (s.open > best.open ? s : best), jaw[0]);
    expect(Math.abs(peak.t - 400)).toBeLessThanOrEqual(40);
    expect(peak.open).toBeGreaterThan(0.6);
    // Anticipation: the jaw is already on its way when the vowel is heard.
    const atOnset = jaw.find((s) => s.t >= 300)!;
    expect(atOnset.open).toBeGreaterThan(0.1);
    expect(atOnset.open).toBeLessThan(peak.open * 0.8);
    // And closed again not long after the sound: no mouth left hanging open.
    expect(jaw.find((s) => s.t >= 700)!.open).toBeLessThan(0.05);
    engine.destroy();
  });

  it("passes through a short silence inside a word, and closes on a pause", () => {
    // The track as playCues hands it to the engine's SpeechTrack: prepared,
    // on a frame clock started now, blended ahead of the voice by the
    // articulation's lead at the default smoothness.
    const speech = new SpeechTrack(undefined, { onSync: () => undefined, onEnded: () => undefined });
    // "...an-d a" with a 50 ms gap between the /n/ and the /d/ (the kind
    // native timing writes, kept by prepareCues beside transients), then a
    // 300 ms pause before the next word.
    const cues: Cue[] = [
      { t: 0, viseme: "sil", a: 1 },
      { t: 100, viseme: "aa", a: 1 },
      { t: 250, viseme: "nn", a: 1 },
      { t: 300, viseme: "sil", a: 1 },
      { t: 350, viseme: "DD", a: 1 },
      { t: 400, viseme: "aa", a: 1 },
      { t: 700, viseme: "sil", a: 1 },
      { t: 1000, viseme: "aa", a: 1 },
      { t: 1200, viseme: "sil", a: 1 },
      { t: 1500, viseme: "sil", a: 1 },
    ];
    speech.begin(cues);
    speech.startClock(now);
    expect(speech.cues.map((c) => [c.t, c.viseme])).toContainEqual([300, "sil"]);
    const smoothness = DEFAULT_TUNING.smoothness;
    const lead = articulationLead(smoothness);
    const blendAt = (t: number) => speech.blendedWeights(now + t - lead, rig.visemes, smoothness);
    // The short silence pulls toward rest by 50/110 of its bell: the jaw
    // stays part-way open between the /n/ and the /d/ (whole, it fell to 0.11).
    expect(blendAt(325).jawOpen).toBeGreaterThan(0.13);
    // The pause pulls whole: closed in its middle (what is left is the
    // tail of the vowel's own bell, 0.03).
    expect(blendAt(850).jawOpen).toBeLessThan(0.05);
    expect(blendAt(850).mouthClose).toBeCloseTo(rig.visemes.sil.mouthClose!, 2);
    speech.destroy();
  });

  it("moves the photographic mouth without steps on the production track, closing only where a mouth closes", () => {
    const { engine, e } = engineWith();
    const mouth = new ContinuousMouth(manifest);
    const scale = 600;
    const neutral = manifest.poses[0].points.map(([x, y]) => ({ x: x * scale, y: y * scale }));
    const width = manifest.mouth_width * scale;
    const ramp = new RevealRamp();
    const frames: { t: number; gap: number; teeth: number; viseme: string }[] = [];
    const visemeAt = (t: number) => {
      let v = "sil";
      for (const c of e.speech.cues) {
        if (c.t <= t) v = c.viseme;
        else break;
      }
      return v;
    };
    play(e, engine, track.cues, 4000, (t) => {
      const points = neutral.map((p) => ({ ...p }));
      mouth.deform(points, neutral, { inner_lip_ring: manifest.inner_ring } as Rig, e.face.weights);
      const gap = Math.hypot(points[13].x - points[14].x, points[13].y - points[14].y) / width;
      frames.push({ t, gap, teeth: ramp.step(enamelReveal(gap * width, width), FRAME), viseme: visemeAt(t) });
    });
    // It speaks: wide on the vowels, and shut at the end.
    expect(Math.max(...frames.map((f) => f.gap))).toBeGreaterThan(0.25);
    expect(frames[frames.length - 1].gap).toBeLessThan(0.01);
    // No step: the lip gap moves at most 0.07 of the mouth's width a frame
    // (0.063 measured; 0.081 before the spring was softened), and its
    // acceleration stays under 0.04 a frame squared.
    const steps = frames.slice(1).map((f, i) => Math.abs(f.gap - frames[i].gap));
    expect(Math.max(...steps)).toBeLessThan(0.07);
    const accelerations = frames.slice(2).map((f, i) => Math.abs(f.gap - 2 * frames[i + 1].gap + frames[i].gap));
    expect(Math.max(...accelerations)).toBeLessThan(0.04);
    // The teeth never pop on: at most a quarter of their reveal a frame.
    const rises = frames.slice(1).map((f, i) => f.teeth - frames[i].teeth);
    expect(Math.max(...rises)).toBeLessThanOrEqual(FRAME / REVEAL_RISE_MS + 1e-9);
    // Closures (the teeth hidden, gap under 0.03) only on /p/ /b/ /m/ (whose
    // span runs to the next cue: the /m/ of "am" holds 116 ms, its own 34
    // and the folded silence after it), in a pause, or at the end: never
    // between two syllables.
    const pauses = e.speech.cues
      .filter((c, i) => c.viseme === "sil" && (e.speech.cues[i + 1]?.t ?? Infinity) - c.t >= 110)
      .map((c) => [c.t, e.speech.cues[e.speech.cues.indexOf(c) + 1]?.t ?? Infinity]);
    const lead = articulationLead(1);
    const spanOf = (c: Cue) => (e.speech.cues[e.speech.cues.indexOf(c) + 1]?.t ?? c.t + 90) - c.t;
    for (const f of frames) {
      if (f.gap >= 0.03) continue;
      const heard = f.t + lead; // what the lips are shaping is this far ahead
      const bilabial = e.speech.cues.some(
        (c) => c.viseme === "PP" && heard >= c.t - 60 && heard <= c.t + spanOf(c) + 60
      );
      const paused = pauses.some(([from, to]) => heard >= from - 20 && heard <= to + 60);
      expect(bilabial || paused || f.t > 3700, `closed at ${f.t.toFixed(0)} ms (${f.viseme})`).toBe(true);
    }
    // And the bilabials do close: each /p/ /b/ /m/ brings the lips together.
    for (const c of e.speech.cues.filter((c) => c.viseme === "PP")) {
      const near = frames.filter((f) => f.t + lead >= c.t - 20 && f.t + lead <= c.t + 140);
      expect(Math.min(...near.map((f) => f.gap)), `/p/ at ${c.t} ms`).toBeLessThan(0.03);
    }
    engine.destroy();
  });
});
