import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AvatarEngine } from "../engine";
import { MAX_EXTRAPOLATION_MS, MediaClock } from "../media-clock";
import type { Cue, Rig } from "../types";

/**
 * Speech on the share page and in the widget is timed by the audio element
 * (media-clock.ts), not by the time since play() was called: an audio that
 * starts late, stalls or is paused must not leave the mouth ahead of the
 * voice. The first block pins the clock; the second pins the engine using
 * it, with a fake audio element whose position the test moves.
 */

/** A stand-in for HTMLAudioElement: the test sets its position and fires
 *  its events. */
class FakeAudio {
  static last: FakeAudio | null = null;
  currentTime = 0;
  paused = true;
  src: string;
  private listeners = new Map<string, (() => void)[]>();
  constructor(src = "") {
    this.src = src;
    FakeAudio.last = this;
  }
  addEventListener(type: string, fn: () => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  removeEventListener() {}
  play() {
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  fire(type: string) {
    if (type === "playing") this.paused = false;
    if (type === "pause") this.paused = true;
    for (const fn of this.listeners.get(type) ?? []) fn();
  }
}

describe("the media clock", () => {
  it("holds at zero until the voice is playing", () => {
    const media = new FakeAudio();
    const clock = new MediaClock(media);
    media.currentTime = 0;
    expect(clock.read(1000)).toBe(0);
    expect(clock.read(1400)).toBe(0);
    expect(clock.playing).toBe(false);
    media.paused = false;
    expect(clock.sync(1500)).toBe(0);
    expect(clock.read(1516)).toBe(16);
  });

  it("follows the element's position when it moves every frame", () => {
    const media = new FakeAudio();
    const clock = new MediaClock(media);
    media.paused = false;
    clock.sync(0);
    for (const [now, position] of [[16, 0.010], [33, 0.031], [50, 0.052]]) {
      media.currentTime = position;
      expect(clock.read(now)).toBeCloseTo(position * 1000);
    }
  });

  it("runs on the frame clock between coarse position updates, never backwards", () => {
    const media = new FakeAudio();
    const clock = new MediaClock(media);
    media.paused = false;
    clock.sync(0);
    media.currentTime = 0.1;
    expect(clock.read(100)).toBe(100);
    // No refresh of currentTime for three frames: extrapolated.
    expect(clock.read(116)).toBe(116);
    expect(clock.read(133)).toBe(133);
    // The refresh reports a little less than extrapolated: held, not rewound.
    media.currentTime = 0.130;
    expect(clock.read(150)).toBe(133);
    expect(clock.read(170)).toBe(150);
  });

  it("stops within a quarter second when the element stalls without saying so", () => {
    const media = new FakeAudio();
    const clock = new MediaClock(media);
    media.paused = false;
    clock.sync(0);
    media.currentTime = 1;
    clock.read(0);
    expect(clock.read(10_000)).toBe(1000 + MAX_EXTRAPOLATION_MS);
  });

  it("stands at the element's position while paused, and a seek may go back", () => {
    const media = new FakeAudio();
    const clock = new MediaClock(media);
    media.paused = false;
    clock.sync(0);
    media.currentTime = 2;
    expect(clock.read(2000)).toBe(2000);
    media.paused = true;
    expect(clock.paused).toBe(true);
    expect(clock.read(5000)).toBe(2000);
    media.currentTime = 0.5;
    media.paused = false;
    expect(clock.sync(6000)).toBe(500);
    expect(clock.read(6100)).toBe(600);
  });
});

const rig = JSON.parse(
  readFileSync(new URL("./fixtures/human-rig.json", import.meta.url), "utf8")
) as Rig;

function quietCanvas() {
  const ctx = new Proxy({
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
    getImageData: (_x: number, _y: number, w: number, h: number) =>
      ({ data: new Uint8ClampedArray(Math.max(1, w * h) * 4).fill(180), width: w, height: h }),
    measureText: () => ({ width: 0 }),
  } as Record<string, unknown>, {
    get: (obj, key: string) => (key in obj ? obj[key] : () => undefined),
    set: (obj, key: string, value) => ((obj[key] = value), true),
  });
  return { width: 256, height: 256, getContext: () => ctx } as unknown as HTMLCanvasElement;
}

class NoopPath {
  moveTo() {}
  lineTo() {}
  quadraticCurveTo() {}
  bezierCurveTo() {}
  arc() {}
  ellipse() {}
  rect() {}
  closePath() {}
  addPath() {}
}

type Internals = { cueTime(now: number): number; currentViseme(now: number): string };

const CUES: Cue[] = [
  { t: 0, viseme: "sil", a: 1 },
  { t: 100, viseme: "PP", a: 1 },
  { t: 200, viseme: "aa", a: 1 },
  { t: 900, viseme: "sil", a: 1 },
];

describe("speech played by the engine", () => {
  let now = 10_000;
  beforeEach(() => {
    now = 10_000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    vi.stubGlobal("Path2D", NoopPath);
    vi.stubGlobal("document", { createElement: () => quietCanvas() });
    vi.stubGlobal("Audio", FakeAudio);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const engineWith = (options = {}) => {
    const image = { naturalWidth: 1024, naturalHeight: 1024, width: 1024, height: 1024 } as HTMLImageElement;
    const engine = new AvatarEngine(quietCanvas(), rig, image, { fullPhoto: true, ...options });
    return { engine, e: engine as unknown as Internals };
  };

  it("keeps the mouth still until the audio actually plays", () => {
    const { engine, e } = engineWith();
    engine.playAudio("", "audio/wav", CUES);
    const audio = FakeAudio.last!;
    // 300 ms of decoding and device start-up: the old clock was at "aa" by now.
    now += 300;
    expect(e.cueTime(now)).toBe(0);
    expect(e.currentViseme(now)).toBe("sil");
    audio.fire("playing");
    now += 150;
    audio.currentTime = 0.15;
    expect(e.cueTime(now)).toBe(150);
    expect(e.currentViseme(now)).toBe("PP");
    engine.destroy();
  });

  it("re-syncs on a seek and follows the element every frame", () => {
    const { engine, e } = engineWith();
    engine.playAudio("", "audio/wav", CUES);
    const audio = FakeAudio.last!;
    audio.fire("playing");
    now += 50;
    audio.currentTime = 0.05;
    expect(e.cueTime(now)).toBe(50);
    audio.currentTime = 0.6;
    audio.fire("seeked");
    expect(e.cueTime(now)).toBe(600);
    expect(e.currentViseme(now)).toBe("aa");
    engine.destroy();
  });

  it("closes the mouth while the audio is paused and resumes where it was", () => {
    const { engine, e } = engineWith();
    engine.playAudio("", "audio/wav", CUES);
    const audio = FakeAudio.last!;
    audio.fire("playing");
    audio.currentTime = 0.25;
    now += 250;
    expect(e.currentViseme(now)).toBe("aa");
    audio.fire("pause");
    now += 2000;
    expect(e.currentViseme(now)).toBe("sil");
    expect(e.cueTime(now)).toBe(250);
    expect(engine.isSpeaking()).toBe(true);
    audio.fire("playing");
    now += 16;
    expect(e.currentViseme(now)).toBe("aa");
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
    // A stopped audio's late events change nothing.
    audio.fire("playing");
    engine.playCues(CUES);
    now += 120;
    expect(e.cueTime(now)).toBe(120);
    expect(e.currentViseme(now)).toBe("PP");
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

  it("leaves an external cue clock (the lab) in charge", () => {
    let external = 700;
    const { engine, e } = engineWith({ cueClock: () => external });
    engine.playAudio("", "audio/wav", CUES);
    expect(e.cueTime(now)).toBe(700);
    FakeAudio.last!.fire("pause");
    external = 250;
    expect(e.currentViseme(now)).toBe("aa");
    engine.destroy();
  });
});
