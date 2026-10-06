import { describe, expect, it } from "vitest";

import {
  BLINK_MIN_GAP_MS,
  BLINK_MS,
  BlinkScheduler,
  blinkEase,
  IDLE_BLINK_JITTER_MS,
  IDLE_BLINK_MIN_MS,
  MAX_DEFER_MS,
  SACCADE_BLINK_THRESHOLD,
} from "../blink";

const seeded = () => {
  let x = 4242;
  return () => ((x = (x * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
};

/** Step the scheduler and count blink onsets (phase leaving zero). */
function run(
  s: BlinkScheduler,
  from: number,
  ms: number,
  ctx: { speaking: boolean; wordActive: boolean },
  frame = 16
): { now: number; onsets: number[] } {
  const onsets: number[] = [];
  let now = from;
  let wasOpen = s.phase === 0;
  for (const end = from + ms; now < end; ) {
    now += frame;
    s.update(frame, now, ctx);
    const open = s.phase === 0;
    if (wasOpen && !open) onsets.push(now);
    wasOpen = open;
  }
  return { now, onsets };
}

describe("blinkEase", () => {
  it("closes faster than it opens", () => {
    let closeAt = 0;
    let openAt = 0;
    for (let t = 0; t <= 1; t += 0.001) {
      if (!closeAt && blinkEase(t) >= 0.95) closeAt = t;
      if (closeAt && !openAt && t > closeAt && blinkEase(t) <= 0.05) openAt = t;
    }
    expect(closeAt).toBeGreaterThan(0);
    expect(openAt - closeAt).toBeGreaterThan(closeAt);
  });

  it("starts and ends open, with a single peak", () => {
    expect(blinkEase(0)).toBeCloseTo(0, 9);
    expect(blinkEase(1)).toBeCloseTo(0, 9);
    let peaks = 0;
    let prev = 0;
    let rising = true;
    for (let t = 0.001; t <= 1; t += 0.001) {
      const v = blinkEase(t);
      if (rising && v < prev) { peaks++; rising = false; }
      prev = v;
    }
    expect(peaks).toBe(1);
  });
});

describe("BlinkScheduler", () => {
  it("still blinks on its own at a natural idle rate", () => {
    const s = new BlinkScheduler(seeded());
    s.reset(0);
    const { onsets } = run(s, 0, 60000, { speaking: false, wordActive: false });
    // 2.4-5.8s cadence over a minute: roughly 10-25 blinks.
    expect(onsets.length).toBeGreaterThanOrEqual(9);
    expect(onsets.length).toBeLessThanOrEqual(26);
    for (let i = 1; i < onsets.length; i++) {
      const gap = onsets[i] - onsets[i - 1];
      expect(gap).toBeGreaterThanOrEqual(IDLE_BLINK_MIN_MS - 20);
      expect(gap).toBeLessThanOrEqual(IDLE_BLINK_MIN_MS + IDLE_BLINK_JITTER_MS + BLINK_MS + 40);
    }
  });

  it("blinks at a pause immediately", () => {
    const s = new BlinkScheduler(seeded());
    s.reset(0);
    s.update(16, 16, { speaking: true, wordActive: true });
    expect(s.phase).toBe(0);
    s.onPause(500);
    expect(s.phase).toBeGreaterThan(0);
  });

  it("merges an event and a timer that land together into one blink", () => {
    const s = new BlinkScheduler(seeded());
    s.reset(0);
    s.onPause(1000);
    const first = s.phase;
    expect(first).toBeGreaterThan(0);
    // Finish the blink, then fire another event inside the refractory gap.
    const { onsets } = run(s, 1000, BLINK_MS + 50, { speaking: true, wordActive: false });
    expect(s.phase).toBe(0);
    s.onSpeechEnd(1000 + BLINK_MIN_GAP_MS - 100);
    expect(s.phase).toBe(0); // refused: too soon
    s.onSpeechEnd(1000 + BLINK_MIN_GAP_MS + 10);
    expect(s.phase).toBeGreaterThan(0); // accepted
    expect(onsets.length).toBe(0); // and the timer did not sneak one in meanwhile
  });

  it("defers a timer blink that falls due mid-word until the next gap", () => {
    const s = new BlinkScheduler(() => 0); // deterministic: timer due at reset+1200
    s.reset(0);
    // Mid-word the whole time: no blink until MAX_DEFER expires.
    const busy = run(s, 0, 1200 + MAX_DEFER_MS - 50, { speaking: true, wordActive: true });
    expect(busy.onsets.length).toBe(0);
    // A gap opens: the deferred blink fires at once.
    s.update(16, busy.now + 16, { speaking: true, wordActive: false });
    expect(s.phase).toBeGreaterThan(0);
  });

  it("does not defer forever through a word-dense sentence", () => {
    const s = new BlinkScheduler(() => 0);
    s.reset(0);
    const { onsets } = run(s, 0, 1200 + MAX_DEFER_MS + 100, { speaking: true, wordActive: true });
    expect(onsets.length).toBe(1);
    expect(onsets[0]).toBeGreaterThanOrEqual(1200 + MAX_DEFER_MS);
  });

  it("only large saccades bring a blink", () => {
    const s = new BlinkScheduler(seeded());
    s.reset(0);
    s.onSaccade(100, SACCADE_BLINK_THRESHOLD * 0.5);
    expect(s.phase).toBe(0);
    s.onSaccade(100, SACCADE_BLINK_THRESHOLD * 1.5);
    expect(s.phase).toBeGreaterThan(0);
  });

  it("an event blink pushes the fallback timer back — no double blink", () => {
    const s = new BlinkScheduler(() => 0);
    s.reset(0); // timer due at 1200
    s.onHeadTurn(1100); // event just before the timer would fire
    const { onsets } = run(s, 1100, 2000, { speaking: false, wordActive: false });
    // Only the event blink in the next two seconds: the timer was reset to
    // 1100 + IDLE_BLINK_MIN_MS = 3500.
    expect(onsets.length).toBe(0);
    expect(s.phase).toBe(0);
  });
});
