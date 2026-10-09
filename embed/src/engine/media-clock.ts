/**
 * The cue clock of speech played through an audio element: the element's own
 * position, not the time since play() was called.
 *
 * Why: `audio.play()` returns before a sound is heard. Decoding a data: URL,
 * waking the output device and filling its buffer take tens to hundreds of
 * milliseconds, more on a phone, and a stall mid-sentence adds its own. A
 * clock started at play() and never re-read runs ahead of the voice by all
 * of it for the rest of the utterance: every mouth shape early. The lab
 * compares renderers on the audio position read every frame
 * (lab/audio-clock.ts); this is the same clock for the share page and the
 * widget, which the stable engines may import (they never import lab/): the
 * photo engine and the 3D one play speech by it alike.
 *
 * The rules:
 * - until the voice is heard, time holds at 0: the mouth waits for the voice
 *   instead of mouthing words nobody hears yet. Heard means the element's
 *   position has moved since a `playing`: `playing` alone is not enough.
 *   Measured in Playwright's WebKit (Safari's media stack), `playing` fires
 *   16 ms to a second before the position (and the sound) starts, and in
 *   Firefox 30-120 ms before (embed/browser-tests/speech-timing.test.ts);
 *   a clock that ran on from `playing` was ahead of the voice by as much as
 *   it was allowed to run (MAX_EXTRAPOLATION_MS), then stood still for as
 *   long while the voice caught up, at the start of every line;
 * - `playing` and `seeked` re-anchor on the element's position, and after
 *   either the clock again stands at that position until it moves;
 * - every frame follows `currentTime`, and between two updates of it
 *   (Firefox refreshes it every 40 ms or so) runs on the frame clock, at
 *   most MAX_EXTRAPOLATION_MS past the last value seen, so a stall the
 *   element does not announce stops the mouth within a quarter second
 *   rather than letting it run on alone;
 * - within one run of playback time never goes backwards: a position that
 *   refreshes late must not shake the mouth between two shapes;
 * - paused (the page, the OS, a headset button), the clock stands at the
 *   element's position and `paused` says so, so the engine can close the
 *   mouth instead of freezing it mid-vowel;
 * - until the voice is heard, `started` is false: the engine is waiting
 *   for the voice, and the silence it reads at time 0 is not a pause in the
 *   speech (no catch-breath, no blink, no glance away before a word).
 */

/** The slice of an HTMLMediaElement the clock reads; a test passes a stub. */
export interface MediaTime {
  readonly currentTime: number;
  readonly paused: boolean;
}

/** How far past the element's last reported position the frame clock may
 *  carry cue time. Above the 15-250 ms between `currentTime` refreshes that
 *  browsers are allowed, below what reads as a mouth running on alone. */
export const MAX_EXTRAPOLATION_MS = 250;

export class MediaClock {
  /** A `playing` (or `seeked`) has been seen. */
  private synced = false;
  /** The position has moved since one: the voice is out. */
  private heard = false;
  /** The position has moved since the last `playing` or `seeked`. */
  private moving = false;
  private anchorMedia = 0;
  private anchorNow = 0;
  private lastMedia = Number.NaN;
  private lastRead = 0;

  constructor(private readonly media: MediaTime) {}

  /** The voice has started (its position has moved after a `playing`),
   *  whether or not it has paused since. */
  get started(): boolean {
    return this.heard || (this.synced && !this.media.paused && this.position() !== this.lastMedia);
  }

  /** Has the voice started, and is it playing now? */
  get playing(): boolean {
    return this.started && !this.media.paused;
  }

  /** Stopped after it started: the voice is silent, whatever the cues say. */
  get paused(): boolean {
    return this.started && this.media.paused;
  }

  /**
   * `playing` or `seeked`: the element's position is authoritative. Returns
   * it, in ms, for the caller to re-place anything walked on cue time.
   */
  sync(now: number): number {
    this.synced = true;
    this.moving = false;
    const media = this.position();
    this.anchor(media, now);
    this.lastRead = media;
    return media;
  }

  /** Cue time in ms at frame time `now`. */
  read(now: number): number {
    if (!this.synced) return 0;
    const media = this.position();
    if (this.media.paused) {
      this.moving = false;
      this.anchor(media, now);
      this.lastRead = media;
      return media;
    }
    if (media !== this.lastMedia) {
      this.anchor(media, now);
      this.moving = this.heard = true;
    }
    const ahead = this.moving ? Math.min(Math.max(0, now - this.anchorNow), MAX_EXTRAPOLATION_MS) : 0;
    this.lastRead = Math.max(this.lastRead, this.anchorMedia + ahead);
    return this.lastRead;
  }

  private position(): number {
    const seconds = this.media.currentTime;
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
  }

  private anchor(media: number, now: number): void {
    this.anchorMedia = media;
    this.anchorNow = now;
    this.lastMedia = media;
  }
}
