import { afterEach, describe, expect, it, vi } from "vitest";
import { StreamTimeline, StreamingAudioComparison } from "../streaming-audio-clock";

const receiver = () => ({ playCues: vi.fn(), updateCueTrack: vi.fn(), syncCueTime: vi.fn(), stopSpeech: vi.fn() });
class Context {
  currentTime = 0;
  state = "running";
  destination = {};
  sources: { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>; onended: (() => void) | null }[] = [];
  resume = vi.fn(async () => { this.state = "running"; });
  suspend = vi.fn(async () => { this.state = "suspended"; });
  close = vi.fn(async () => { this.state = "closed"; });
  createBuffer = vi.fn(() => ({ copyToChannel: vi.fn() }));
  createBufferSource() {
    const source = { buffer: null, connect: vi.fn(), start: vi.fn(), stop: vi.fn(), disconnect: vi.fn(), onended: null };
    this.sources.push(source); return source;
  }
}
const cues = [{ t: 0, viseme: "aa" }, { t: 1000, viseme: "sil" }];
function setup() {
  vi.useFakeTimers();
  const a = receiver(), b = receiver(), context = new Context(), state = vi.fn();
  const player = new StreamingAudioComparison(a, b, context as unknown as AudioContext, state);
  const at = (time: number) => { context.currentTime = time; vi.advanceTimersByTime(25); };
  return { player, a, b, context, state, at };
}
afterEach(() => vi.useRealTimers());

describe("sample-scheduled streaming", () => {
  it("schedules contiguous audio when the next chunk arrives ahead of playback", () => {
    const timeline = new StreamTimeline();
    const first = timeline.schedule(0, 1.000125, 0);
    const next = timeline.schedule(.2, 1, 1.000125);
    expect(next.start).toBe(first.end);
    expect(timeline.bufferGaps).toBe(0);
    expect(timeline.position(next.start)).toBeCloseTo(1.000125, 8);
  });
  it("holds content time throughout a network gap and recovers without a jump", () => {
    const timeline = new StreamTimeline();
    timeline.schedule(0, 1, 0);
    timeline.schedule(5, 1, 1);
    expect(timeline.position(4)).toBe(1); expect(timeline.active(4)).toBe(false);
    expect(timeline.bufferGaps).toBe(1);
    expect(timeline.position(5.16)).toBeCloseTo(1.1);
  });
  it("starts lips with audible playback and appends cues without restarting motion", async () => {
    const { player, a, b, at, state } = setup();
    await player.unlock();
    player.append(new Float32Array(24000), 0, cues, cues);
    expect(a.playCues).not.toHaveBeenCalled();
    at(.2); expect(a.playCues).toHaveBeenCalledOnce(); expect(b.playCues).toHaveBeenCalledOnce();
    player.append(new Float32Array(24000), 1, cues, cues);
    expect(a.updateCueTrack).toHaveBeenCalledOnce(); expect(a.playCues).toHaveBeenCalledOnce();
    expect(state).toHaveBeenCalledWith("playing", true);
    player.finish(); at(2.2); await player.done;
  });
  it("stops lips during underrun; pause/resume never advances an inactive clock", async () => {
    const { player, a, at, context } = setup();
    player.append(new Float32Array(24000), 0, cues, cues); at(.5);
    await player.pause(); const held = player.readTime(); at(.5);
    expect(player.readTime()).toBe(held); expect(context.state).toBe("suspended");
    await player.resume(); at(1.2); expect(a.stopSpeech).toHaveBeenCalled();
    const end = player.readTime(); at(4); expect(player.readTime()).toBe(end);
    player.append(new Float32Array(24000), 1, cues, cues); at(4.2);
    expect(player.position).toBeCloseTo(1.14);
    player.stop(); await player.done;
  });
  it("cancellation stops every scheduled source and settles even before audio starts", async () => {
    const { player, a, context, at } = setup();
    player.append(new Float32Array(24000), 0, cues, cues);
    player.append(new Float32Array(24000), 1, cues, cues);
    player.stop(); await player.done; at(10);
    expect(a.playCues).not.toHaveBeenCalled();
    for (const source of context.sources) { expect(source.stop).toHaveBeenCalledOnce(); expect(source.disconnect).toHaveBeenCalledOnce(); }
    expect(context.close).toHaveBeenCalledOnce(); player.stop();
    expect(() => player.append(new Float32Array(1), 2, cues, cues)).toThrow();
  });
});
