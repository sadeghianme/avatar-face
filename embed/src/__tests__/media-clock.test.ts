import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AvatarEngine } from "../engine";
import { engineSeam, type EngineSeam } from "../engine/seam";
import { MAX_EXTRAPOLATION_MS, MediaClock } from "../engine/media-clock";
import type { Cue, Rig } from "../types";
import { FakeAudio, fakeCanvas, NoopPath } from "./browser-fakes";

/**
 * Speech on the share page and in the widget is timed by the audio element
 * (media-clock.ts), not by the time since play() was called: an audio that
 * starts late, stalls or is paused must not leave the mouth ahead of the
 * voice. The first block pins the clock; the second pins the engine using
 * it, with a fake audio element whose position the test moves.
 * (engine3d-clock.test.ts pins the 3D engine on the same clock.)
 */

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
    media.currentTime = 0.016;
    expect(clock.read(1516)).toBe(16);
    expect(clock.read(1530)).toBe(30);
  });

  it("holds at zero after `playing` until the position moves", () => {
    // Safari's media stack fires `playing` as play() starts the player, and
    // the position (with the sound) follows up to a second later: measured
    // in Playwright's WebKit, 16-1012 ms (browser-tests/speech-timing.test.ts).
    // A clock that ran on from `playing` was 250 ms ahead of the voice, and
    // then stood still while the voice caught up.
    const media = new FakeAudio();
    const clock = new MediaClock(media);
    media.paused = false;
    clock.sync(1000);
    for (const now of [1016, 1100, 1180]) expect(clock.read(now)).toBe(0);
    expect(clock.started).toBe(false);
    media.currentTime = 0.004;
    expect(clock.started).toBe(true);
    expect(clock.read(1196)).toBe(4);
    expect(clock.read(1212)).toBe(20);
  });

  it("says when the voice has started, and a pause does not unsay it", () => {
    const media = new FakeAudio();
    const clock = new MediaClock(media);
    // Asked to play, not heard yet: waiting, which is neither playing nor paused.
    media.paused = false;
    expect([clock.started, clock.playing, clock.paused]).toEqual([false, false, false]);
    clock.sync(0);
    // `playing`, and the position not moving yet: still waiting.
    expect([clock.started, clock.playing, clock.paused]).toEqual([false, false, false]);
    media.currentTime = 0.01;
    expect([clock.started, clock.playing, clock.paused]).toEqual([true, true, false]);
    clock.read(10);
    media.paused = true;
    expect([clock.started, clock.playing, clock.paused]).toEqual([true, false, true]);
  });

  it("follows the element's position when it moves every frame", () => {
    const media = new FakeAudio();
    const clock = new MediaClock(media);
    media.paused = false;
    clock.sync(0);
    for (const [now, position] of [
      [16, 0.01],
      [33, 0.031],
      [50, 0.052],
    ]) {
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
    media.currentTime = 0.13;
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
    // Standing at the new position until it moves from there.
    expect(clock.read(6050)).toBe(500);
    media.currentTime = 0.55;
    expect(clock.read(6060)).toBe(550);
    expect(clock.read(6100)).toBe(590);
  });
});

const rig = JSON.parse(readFileSync(new URL("./fixtures/human-rig.json", import.meta.url), "utf8")) as Rig;

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
    vi.stubGlobal("document", { createElement: () => fakeCanvas() });
    vi.stubGlobal("Audio", FakeAudio);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const engineWith = (options = {}) => {
    const image = { naturalWidth: 1024, naturalHeight: 1024, width: 1024, height: 1024 } as HTMLImageElement;
    const engine = new AvatarEngine(fakeCanvas(), rig, image, { fullPhoto: true, ...options });
    return { engine, e: engineSeam(engine) };
  };

  it("keeps the mouth still until the audio actually plays", () => {
    const { engine, e } = engineWith();
    engine.playAudio("", "audio/wav", CUES);
    const audio = FakeAudio.last!;
    // 300 ms of decoding and device start-up: the old clock was at "aa" by now.
    now += 300;
    expect(e.speech.cueTime(now)).toBe(0);
    expect(e.speech.currentViseme(now)).toBe("sil");
    audio.fire("playing");
    now += 150;
    audio.currentTime = 0.15;
    expect(e.speech.cueTime(now)).toBe(150);
    expect(e.speech.currentViseme(now)).toBe("PP");
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
    expect(e.speech.currentViseme(now)).toBe("aa");
    engine.destroy();
  });

  it("closes the mouth while the audio is paused and resumes where it was", () => {
    const { engine, e } = engineWith();
    engine.playAudio("", "audio/wav", CUES);
    const audio = FakeAudio.last!;
    audio.fire("playing");
    audio.currentTime = 0.25;
    now += 250;
    expect(e.speech.currentViseme(now)).toBe("aa");
    audio.fire("pause");
    now += 2000;
    expect(e.speech.currentViseme(now)).toBe("sil");
    expect(e.speech.cueTime(now)).toBe(250);
    expect(engine.isSpeaking()).toBe(true);
    audio.fire("playing");
    now += 16;
    expect(e.speech.currentViseme(now)).toBe("aa");
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
    expect(e.speech.cueTime(now)).toBe(120);
    expect(e.speech.currentViseme(now)).toBe("PP");
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
    expect(e.speech.cueTime(now)).toBe(700);
    FakeAudio.last!.fire("pause");
    external = 250;
    expect(e.speech.currentViseme(now)).toBe("aa");
    engine.destroy();
  });

  describe("a pause in the speech (a catch-breath, a blink, sometimes a glance away)", () => {
    /** "Hello, ...": the /h/ is silence at 0, and the comma is a real pause
     *  (420-900 ms), longer than the gap between two words. */
    const HELLO: Cue[] = [
      { t: 0, viseme: "sil", a: 1 },
      { t: 90, viseme: "E", a: 1 },
      { t: 170, viseme: "nn", a: 1 },
      { t: 240, viseme: "oh", a: 1 },
      { t: 420, viseme: "sil", a: 1 },
      { t: 900, viseme: "aa", a: 1 },
      { t: 1100, viseme: "PP", a: 1 },
      { t: 1180, viseme: "aa", a: 1 },
      { t: 1400, viseme: "sil", a: 1 },
    ];

    /** Frame by frame for `ms`, the audio's position moving while it plays. */
    const run = (e: EngineSeam, audio: FakeAudio, ms: number) => {
      for (let elapsed = 0; elapsed < ms; elapsed += 1000 / 60) {
        now += 1000 / 60;
        if (!audio.paused) audio.currentTime += 1 / 60;
        e.tick(now);
      }
    };

    const speak = () => {
      // Every draw 0.3: a pause glances away (45% of pauses do), and each
      // fixation the saccade timer picks is the listener, so nothing but the
      // pause behaviour moves the gaze. (A constant the body's Box-Muller
      // sampler accepts: 0.1 and 0.5 would be redrawn forever.)
      vi.mocked(Math.random).mockReturnValue(0.3);
      const { engine, e } = engineWith();
      const breath = vi.spyOn(e.motion.body, "catchBreath");
      const blink = vi.spyOn(e.motion.blinks, "onPause");
      engine.playAudio("", "audio/wav", HELLO);
      return { engine, e, audio: FakeAudio.last!, breath, blink };
    };

    it("is not taken while the voice has yet to start", () => {
      const { engine, e, audio, breath, blink } = speak();
      // 600 ms of decoding and device start-up, as on a phone. The /h/ at
      // time 0 is all the cue track says meanwhile.
      run(e, audio, 600);
      expect(e.speech.currentViseme(now)).toBe("sil");
      expect(breath).not.toHaveBeenCalled();
      expect(blink).not.toHaveBeenCalled();
      expect(e.motion.gazeTarget).toEqual({ x: 0, y: 0 });
      // The voice starts: its /h/ runs into the vowel, with no pause between.
      audio.fire("playing");
      run(e, audio, 300);
      expect(e.speech.currentViseme(now)).toBe("oh");
      expect(breath).not.toHaveBeenCalled();
      expect(blink).not.toHaveBeenCalled();
      expect(e.motion.gazeTarget).toEqual({ x: 0, y: 0 });
      engine.destroy();
    });

    it("is not taken between an early `playing` and the voice (Safari)", () => {
      const { engine, e, audio, breath, blink } = speak();
      audio.fire("playing");
      // The position stands at 0 for 400 ms after `playing`, as WebKit's does.
      for (let elapsed = 0; elapsed < 400; elapsed += 1000 / 60) {
        now += 1000 / 60;
        e.tick(now);
      }
      expect(e.speech.cueTime(now)).toBe(0);
      expect(e.speech.awaitingVoice()).toBe(true);
      expect(breath).not.toHaveBeenCalled();
      expect(blink).not.toHaveBeenCalled();
      expect(e.motion.gazeTarget).toEqual({ x: 0, y: 0 });
      run(e, audio, 300);
      expect(e.speech.currentViseme(now)).toBe("oh");
      expect(breath).not.toHaveBeenCalled();
      expect(blink).not.toHaveBeenCalled();
      engine.destroy();
    });

    it("is still taken at a real pause once the voice plays, once", () => {
      const { engine, e, audio, breath, blink } = speak();
      run(e, audio, 600);
      audio.fire("playing");
      // Into the comma, past the length of a pause but not out of it.
      run(e, audio, 800);
      expect(e.speech.currentViseme(now)).toBe("sil");
      expect(breath).toHaveBeenCalledTimes(1);
      expect(blink).toHaveBeenCalledTimes(1);
      expect(e.motion.gazeTarget).not.toEqual({ x: 0, y: 0 });
      // Speech resumes: back to the listener.
      run(e, audio, 200);
      expect(e.speech.currentViseme(now)).not.toBe("sil");
      expect(e.motion.gazeTarget).toEqual({ x: 0, y: 0 });
      engine.destroy();
    });

    it("is taken when a voice that has started is paused", () => {
      const { engine, e, audio, breath, blink } = speak();
      audio.fire("playing");
      run(e, audio, 300);
      audio.fire("pause");
      run(e, audio, 400);
      expect(breath).toHaveBeenCalledTimes(1);
      expect(blink).toHaveBeenCalledTimes(1);
      engine.destroy();
    });
  });
});
