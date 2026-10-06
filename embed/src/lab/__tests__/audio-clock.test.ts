import { describe, expect, it, vi } from "vitest";
import { AudioClockComparison } from "../audio-clock";
import { SpeechTrack } from "../../engine/speech";

class FakeAudio extends EventTarget {
  currentTime = 0;
  paused = true;
  play = vi.fn(async () => {
    this.paused = false;
  });
  pause = vi.fn(() => {
    this.paused = true;
    this.dispatchEvent(new Event("pause"));
  });
  removeAttribute = vi.fn();
  load = vi.fn();
  fire(name: string) {
    this.dispatchEvent(new Event(name));
  }
}
const receiver = () => ({ playCues: vi.fn(), syncCueTime: vi.fn(), stopSpeech: vi.fn() });
const track = [
  { t: 0, viseme: "PP" },
  { t: 100, viseme: "aa" },
  { t: 500, viseme: "sil" },
];
function setup() {
  const a = receiver(),
    b = receiver(),
    audio = new FakeAudio();
  const factory = vi.fn(() => audio as unknown as HTMLAudioElement);
  return { a, b, audio, factory, player: new AudioClockComparison(a, b, factory) };
}

describe("audio-locked comparison", () => {
  it("does not move the mouth before audio actually starts", async () => {
    const { player, a, b, audio, factory } = setup();
    const done = player.play("AAAA", "audio/wav", track, track);
    expect(a.playCues).not.toHaveBeenCalled();
    expect(b.playCues).not.toHaveBeenCalled();
    audio.fire("playing");
    expect(a.playCues).toHaveBeenCalledOnce();
    expect(b.playCues).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledOnce();
    player.stop();
    await done;
  });
  it("reads the media clock directly, including seek and visual lead", async () => {
    const { player, audio } = setup();
    const done = player.play("", "audio/wav", track, track);
    audio.currentTime = 0.3;
    expect(player.readTime()).toBe(300);
    player.leadMs = 40;
    expect(player.readTime()).toBe(340);
    audio.currentTime = 0.1;
    expect(player.readTime()).toBe(140);
    player.leadMs = -150;
    expect(player.readTime()).toBe(0);
    player.stop();
    await done;
  });
  it("closes on pause and resynchronizes on resume", async () => {
    const { player, a, b, audio } = setup();
    const done = player.play("", "audio/wav", track, track);
    audio.fire("playing");
    audio.currentTime = 0.2;
    player.pause();
    expect(a.stopSpeech).toHaveBeenCalled();
    expect(b.stopSpeech).toHaveBeenCalled();
    await player.resume();
    audio.fire("playing");
    expect(a.syncCueTime).toHaveBeenLastCalledWith(200);
    expect(b.syncCueTime).toHaveBeenLastCalledWith(200);
    player.stop();
    await done;
  });
  it("closes during buffering and ends exactly once", async () => {
    const { player, a, audio } = setup();
    const done = player.play("", "audio/wav", track, track);
    audio.fire("playing");
    audio.fire("waiting");
    expect(a.stopSpeech).toHaveBeenCalledOnce();
    audio.fire("ended");
    await done;
    const count = a.stopSpeech.mock.calls.length;
    audio.fire("playing");
    audio.fire("ended");
    player.stop();
    expect(a.stopSpeech).toHaveBeenCalledTimes(count);
    expect(player.media).toBeNull();
  });
  it("rejects playback failures instead of reporting success", async () => {
    const { player, audio } = setup();
    audio.play.mockRejectedValueOnce(new Error("autoplay blocked"));
    await expect(player.play("", "audio/wav", track, track)).rejects.toThrow("autoplay blocked");
    expect(player.media).toBeNull();
  });
  it("attaches recording to the shared media before playback", async () => {
    const { player, audio } = setup();
    const attach = vi.fn((media) => {
      expect(media).toBe(audio);
      expect(audio.play).not.toHaveBeenCalled();
    });
    const done = player.play("", "audio/wav", track, track, attach);
    expect(attach).toHaveBeenCalledOnce();
    player.stop();
    await done;
  });
  it("cleans up when attaching a recorder fails", async () => {
    const { player, audio } = setup();
    await expect(
      player.play("", "audio/wav", track, track, () => {
        throw new Error("capture failed");
      })
    ).rejects.toThrow("capture failed");
    expect(audio.play).not.toHaveBeenCalled();
    expect(player.media).toBeNull();
  });
  it("settles a cancelled run and ignores its late failure", async () => {
    const a = receiver(),
      b = receiver();
    const old = new FakeAudio(),
      next = new FakeAudio();
    let rejectPlay: (error: Error) => void = () => {};
    old.play.mockImplementationOnce(
      () =>
        new Promise<void>((_, reject) => {
          rejectPlay = reject;
        })
    );
    const factory = vi.fn().mockReturnValueOnce(old).mockReturnValueOnce(next);
    const player = new AudioClockComparison(a, b, factory);
    const first = player.play("", "audio/wav", track, track);
    const second = player.play("", "audio/wav", track, track);
    await first;
    rejectPlay(new Error("old failure"));
    await Promise.resolve();
    expect(player.media).toBe(next);
    player.destroy();
    await second;
  });
});

describe("renderer clock opt-in", () => {
  // The clock lookup needs no DOM or canvas: a SpeechTrack with no audio
  // element reads the lab's clock when it has one, else the frame clock.
  const hooks = { onSync: () => undefined, onEnded: () => undefined };
  const trackFrom = (cueClock: (() => number) | undefined, startedAt: number) => {
    const speech = new SpeechTrack(cueClock, hooks);
    speech.startClock(startedAt);
    return speech;
  };
  it("retains the original wall clock without opting in", () => {
    expect(trackFrom(undefined, 100).cueTime(700)).toBe(600);
  });
  it("never advances an audio-locked clock while media is stalled", () => {
    const speech = trackFrom(() => 350, 0);
    expect(speech.cueTime(500)).toBe(350);
    expect(speech.cueTime(50000)).toBe(350);
  });
  it("falls back safely for invalid external timing", () => {
    expect(trackFrom(() => NaN, 100).cueTime(500)).toBe(400);
  });
});
