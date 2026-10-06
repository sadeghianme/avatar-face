import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Avatar3DEngine } from "../engine3d";
import { morphModel, stubCanvas, stubRenderer } from "../engine3d/__tests__/three-fakes";
import { engine3dSeam } from "../engine3d/seam";
import type { Cue } from "../types";
import { FakeAudio } from "./browser-fakes";

/**
 * The 3D engine plays speech on the same clock as the photo engine
 * (media-clock.ts, pinned in media-clock.test.ts): the audio element's own
 * position, held until the voice is heard, re-synced on a seek, and standing
 * still with the mouth closed while the voice is paused. A clock started at
 * play() ran ahead of the voice by however long the audio took to start.
 * Driven through the public API; the clock is read through the seam.
 */

/** A face with the Ready Player Me viseme morphs; its influences are what
 *  the engine drives each frame. */
const MORPHS = ["viseme_sil", "viseme_PP", "viseme_aa"];

const CUES: Cue[] = [
  { t: 0, viseme: "sil", a: 1 },
  { t: 100, viseme: "PP", a: 1 },
  { t: 200, viseme: "aa", a: 1 },
  { t: 900, viseme: "sil", a: 1 },
];

describe("speech played by the 3D engine", () => {
  let now = 10_000;
  beforeEach(() => {
    now = 10_000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    vi.stubGlobal("window", { devicePixelRatio: 1 });
    vi.stubGlobal("Audio", FakeAudio);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const engineWith = () => {
    const { root, influence } = morphModel(MORPHS, false);
    const engine = new Avatar3DEngine(stubCanvas(), root, stubRenderer().renderer);
    return { engine, e: engine3dSeam(engine), aa: () => influence("viseme_aa") };
  };

  /** Frame by frame for `ms`, the audio's position moving while it plays. */
  const run = (engine: Avatar3DEngine, audio: FakeAudio, ms: number) => {
    for (let elapsed = 0; elapsed < ms; elapsed += 1000 / 60) {
      now += 1000 / 60;
      if (!audio.paused) audio.currentTime += 1 / 60;
      engine.step(now);
    }
  };

  it("keeps the mouth still until the audio actually plays", () => {
    const { engine, e, aa } = engineWith();
    engine.playAudio("", "audio/wav", CUES);
    const audio = FakeAudio.last!;
    // 400 ms of decoding and device start-up: the old clock was at "aa" by now.
    run(engine, audio, 400);
    expect(e.speech.cueTime(now)).toBe(0);
    expect(aa()).toBe(0);
    audio.fire("playing");
    now += 150;
    audio.currentTime = 0.15;
    expect(e.speech.cueTime(now)).toBe(150);
    run(engine, audio, 200);
    expect(aa()).toBeGreaterThan(0.3);
    engine.destroy();
  });

  it("re-syncs on a seek and follows the element every frame", () => {
    const { engine, e } = engineWith();
    engine.playAudio("", "audio/wav", CUES);
    const audio = FakeAudio.last!;
    audio.fire("playing");
    now += 50;
    audio.currentTime = 0.05;
    expect(e.speech.cueTime(now)).toBe(50);
    audio.currentTime = 0.6;
    audio.fire("seeked");
    expect(e.speech.cueTime(now)).toBe(600);
    now += 16;
    audio.currentTime = 0.616;
    expect(e.speech.cueTime(now)).toBe(616);
    engine.destroy();
  });

  it("closes the mouth while the audio is paused and resumes where it was", () => {
    const { engine, e, aa } = engineWith();
    engine.playAudio("", "audio/wav", CUES);
    const audio = FakeAudio.last!;
    audio.fire("playing");
    run(engine, audio, 300);
    const open = aa();
    expect(open).toBeGreaterThan(0.5);
    audio.fire("pause");
    const position = e.speech.cueTime(now);
    run(engine, audio, 1000);
    expect(aa()).toBeLessThan(0.01);
    expect(e.speech.cueTime(now)).toBe(position);
    expect(engine.isSpeaking()).toBe(true);
    audio.fire("playing");
    run(engine, audio, 200);
    expect(aa()).toBeGreaterThan(0.5);
    engine.destroy();
  });

  it("stops as before: the audio is released and the frame clock is back", () => {
    const { engine, e } = engineWith();
    const ended = vi.fn();
    engine.playAudio("", "audio/wav", CUES, ended);
    const audio = FakeAudio.last!;
    audio.fire("playing");
    engine.stopSpeech();
    expect(audio.paused).toBe(true);
    expect(audio.src).toBe("");
    expect(engine.isSpeaking()).toBe(false);
    expect(ended).not.toHaveBeenCalled();
    // A stopped audio's late events change nothing, and cues without audio
    // (a browser voice) run on the frame clock.
    audio.fire("playing");
    engine.playCues(CUES);
    now += 120;
    expect(e.speech.cueTime(now)).toBe(120);
    engine.destroy();
  });

  it("ends when the audio ends", () => {
    const { engine } = engineWith();
    const ended = vi.fn();
    engine.playAudio("", "audio/wav", CUES, ended);
    FakeAudio.last!.fire("playing");
    FakeAudio.last!.fire("ended");
    expect(ended).toHaveBeenCalledTimes(1);
    expect(engine.isSpeaking()).toBe(false);
    engine.destroy();
  });
});
