import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TONGUE_RAISE } from "../character-paint";
import { ZERO_WEIGHTS, type BlendWeights, type Cue, type Rig } from "../../types";
import { FakeAudio } from "../../__tests__/browser-fakes";
import { articulationLead, blendCueWeights, prepareCues } from "../cues";
import { SpeechTrack, articulate, easeTongue } from "../speech";

/**
 * The speech in flight (speech.ts): the articulation filter that moves the
 * mouth toward the track's shape, the tongue's easing, and SpeechTrack's
 * clock, read without an engine around it.
 */

const keys = Object.keys(ZERO_WEIGHTS) as (keyof BlendWeights)[];
const weights = (w: Partial<BlendWeights> = {}): BlendWeights => ({ ...ZERO_WEIGHTS, ...w });
const all = (v: number) => weights(Object.fromEntries(keys.map((k) => [k, v])));

describe("articulate", () => {
  it("is a first-order filter in real time: 1 - exp(-dt / tau) of the way", () => {
    const w = weights();
    articulate(w, weights({ jawOpen: 1 }), 16, 1);
    // Opening, tau 47 ms, the jaw's inertia 1.3.
    expect(w.jawOpen).toBeCloseTo(1 - Math.exp(-16 / (47 * 1.3)), 12);
  });

  it("does not depend on the frame rate: two 8 ms steps are one 16 ms step", () => {
    const once = weights({ jawOpen: 0.2, mouthClose: 0.9 });
    const twice = { ...once };
    const target = weights({ jawOpen: 0.8, mouthPucker: 0.5 });
    articulate(once, target, 16, 1);
    articulate(twice, target, 8, 1);
    articulate(twice, target, 8, 1);
    for (const key of keys) expect(twice[key]).toBeCloseTo(once[key], 12);
  });

  it("closes faster than it opens", () => {
    const opening = all(0), closing = all(1);
    articulate(opening, all(1), 30, 1);
    articulate(closing, all(0), 30, 1);
    for (const key of keys) expect(1 - closing[key]).toBeGreaterThan(opening[key]);
  });

  it("moves the lips faster than the jaw", () => {
    const w = weights();
    articulate(w, all(1), 30, 1);
    expect(w.mouthClose).toBeGreaterThan(w.mouthStretch);
    expect(w.mouthStretch).toBeGreaterThan(w.jawOpen);
  });

  it("divides its time constants by the tuning's smoothness, floored at 0.15", () => {
    // `smoothness` scales the rate (tau = 47 ms / smoothness): 2 follows the
    // track twice as fast as 1; 0 is as slow as the floor allows.
    const quick = weights(), slow = weights(), zero = weights(), floor = weights();
    articulate(quick, all(1), 16, 2);
    articulate(slow, all(1), 16, 0.5);
    articulate(zero, all(1), 16, 0);
    articulate(floor, all(1), 16, 0.15);
    expect(quick.jawOpen).toBeCloseTo(1 - Math.exp(-16 / ((47 / 2) * 1.3)), 12);
    expect(quick.jawOpen).toBeGreaterThan(slow.jawOpen);
    expect(zero).toEqual(floor);
  });

  it("stays on its target once there", () => {
    const w = weights({ jawOpen: 0.4 });
    articulate(w, weights({ jawOpen: 0.4 }), 16, 1);
    expect(w).toEqual(weights({ jawOpen: 0.4 }));
  });
});

describe("easeTongue", () => {
  it("eases toward the sound's height with a 55 ms time constant", () => {
    expect(easeTongue(0, "TH", 55)).toBeCloseTo(TONGUE_RAISE.TH * (1 - Math.exp(-1)), 12);
    expect(easeTongue(1, "aa", 55)).toBeCloseTo(1 + (TONGUE_RAISE.aa - 1) * (1 - Math.exp(-1)), 12);
  });

  it("lowers the tongue for a sound that does not raise it", () => {
    expect(easeTongue(0.8, "PP", 1e6)).toBeCloseTo(0, 9);
    expect(easeTongue(0.8, "PP", 0)).toBe(0.8);
  });
});

const VISEMES: Rig["visemes"] = { sil: {}, aa: { jawOpen: 0.7 }, PP: { mouthClose: 1 }, E: { mouthStretch: 0.5 } };
const TRACK: Cue[] = [
  { t: 0, viseme: "sil", a: 1 }, { t: 120, viseme: "PP", a: 1 }, { t: 220, viseme: "aa", a: 1 },
  { t: 520, viseme: "E", a: 1 }, { t: 800, viseme: "sil", a: 1 },
];
const hooks = () => ({ onSync: vi.fn<(ms: number) => void>(), onEnded: vi.fn<() => void>() });

describe("SpeechTrack's clock", () => {
  it("runs on the frame clock without audio, from start and from a seek", () => {
    const speech = new SpeechTrack(undefined, hooks());
    speech.startClock(1000);
    expect(speech.cueTime(1250)).toBe(250);
    speech.seek(600, 2000);
    expect(speech.cueTime(2100)).toBe(700);
  });

  it("lets the lab's clock win, never negative, and falls back when it reads nothing", () => {
    let external = 420;
    const speech = new SpeechTrack(() => external, hooks());
    speech.startClock(0);
    expect(speech.cueTime(9_999)).toBe(420);
    external = -30;
    expect(speech.cueTime(9_999)).toBe(0);
    external = Number.POSITIVE_INFINITY;
    expect(speech.cueTime(9_999)).toBe(9_999);
  });

  it("is silent until it speaks, then says the prepared track's viseme", () => {
    const speech = new SpeechTrack(undefined, hooks());
    speech.startClock(0);
    expect(speech.currentViseme(250)).toBe("sil");
    speech.begin(TRACK);
    expect(speech.cues).toEqual(prepareCues(TRACK));
    expect(speech.currentViseme(130)).toBe("PP");
    expect(speech.currentViseme(250)).toBe("aa");
  });

  it("blends ahead of the voice by the articulation's lead", () => {
    const speech = new SpeechTrack(undefined, hooks());
    speech.begin(TRACK);
    speech.startClock(5000);
    for (const smoothness of [0.5, 1, 2]) {
      for (const t of [100, 300, 610]) {
        expect(speech.blendedWeights(5000 + t, VISEMES, smoothness)).toEqual(
          blendCueWeights(speech.cues, VISEMES, t + articulationLead(smoothness))
        );
      }
    }
  });

  it("keeps speaking and its clock when the track is replaced", () => {
    const speech = new SpeechTrack(undefined, hooks());
    speech.begin(TRACK.slice(0, 3));
    speech.startClock(100);
    speech.replaceCues(TRACK);
    expect(speech.speaking).toBe(true);
    expect(speech.cueTime(400)).toBe(300);
    expect(speech.cues).toEqual(prepareCues(TRACK));
  });

  it("drops the track when stopped", () => {
    const speech = new SpeechTrack(undefined, hooks());
    speech.begin(TRACK);
    speech.stop();
    expect(speech.speaking).toBe(false);
    expect(speech.cues).toEqual([]);
    expect(speech.currentViseme(300)).toBe("sil");
  });
});

describe("SpeechTrack's voice", () => {
  beforeEach(() => {
    vi.stubGlobal("Audio", FakeAudio);
    vi.spyOn(performance, "now").mockReturnValue(1000);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("holds cue time at 0 until the audio plays, then follows it", () => {
    const h = hooks();
    const speech = new SpeechTrack(undefined, h);
    const audio = speech.load("", "audio/wav", null);
    speech.begin(TRACK);
    speech.play(audio, false);
    const fake = FakeAudio.last!;
    expect(speech.awaitingVoice()).toBe(true);
    expect(speech.cueTime(1300)).toBe(0);
    fake.currentTime = 0.05;
    fake.fire("playing");
    expect(h.onSync).toHaveBeenCalledWith(50);
    expect(speech.awaitingVoice()).toBe(false);
    expect(speech.cueTime(1000)).toBe(50);
  });

  it("closes the mouth while the voice is paused", () => {
    const speech = new SpeechTrack(undefined, hooks());
    const audio = speech.load("", "audio/wav", null);
    speech.begin(TRACK);
    speech.play(audio, false);
    FakeAudio.last!.currentTime = 0.3;
    FakeAudio.last!.fire("playing");
    expect(speech.currentViseme(1000)).toBe("aa");
    FakeAudio.last!.fire("pause");
    expect(speech.voicePaused()).toBe(true);
    expect(speech.currentViseme(1000)).toBe("sil");
    expect(speech.blendedWeights(1000, VISEMES, 1)).toEqual(ZERO_WEIGHTS);
  });

  it("says when the voice ends, and hands the caller's onEnd back once", () => {
    const h = hooks();
    const onEnd = vi.fn();
    const speech = new SpeechTrack(undefined, h);
    const audio = speech.load("", "audio/wav", onEnd);
    speech.begin(TRACK);
    speech.play(audio, false);
    FakeAudio.last!.fire("ended");
    expect(h.onEnded).toHaveBeenCalledTimes(1);
    expect(speech.finish()).toBe(onEnd);
    expect(speech.finish()).toBeNull();
    expect(speech.speaking).toBe(false);
  });

  it("ignores a replaced voice's late events", () => {
    const h = hooks();
    const speech = new SpeechTrack(undefined, h);
    const first = speech.load("", "audio/wav", null);
    speech.play(first, false);
    const old = FakeAudio.last!;
    speech.play(speech.load("", "audio/wav", null), false);
    old.fire("playing");
    old.fire("ended");
    expect(h.onSync).not.toHaveBeenCalled();
    expect(h.onEnded).not.toHaveBeenCalled();
    expect(old.src).toBe("");
  });
});
