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
 * - before the first `playing`, time holds at 0: the mouth waits for the
 *   voice instead of mouthing words nobody hears yet;
 * - `playing` and `seeked` re-anchor on the element's position;
 * - every frame follows `currentTime`, and between two updates of it
 *   (some browsers refresh it only every few frames) runs on the frame
 *   clock, at most MAX_EXTRAPOLATION_MS past the last value seen, so a
 *   stall the element does not announce stops the mouth within a quarter
 *   second rather than letting it run on alone;
 * - within one run of playback time never goes backwards: a position that
 *   refreshes late must not shake the mouth between two shapes;
 * - paused (the page, the OS, a headset button), the clock stands at the
 *   element's position and `paused` says so, so the engine can close the
 *   mouth instead of freezing it mid-vowel;
 * - until the first `playing`, `started` is false: the engine is waiting
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
  private heard = false;
  private anchorMedia = 0;
  private anchorNow = 0;
  private lastMedia = Number.NaN;
  private lastRead = 0;

  constructor(private readonly media: MediaTime) {}

  /** The voice has started (a `playing` event has been seen), whether or
   *  not it has paused since. */
  get started(): boolean {
    return this.heard;
  }

  /** Has the element started playing, and is it playing now? */
  get playing(): boolean {
    return this.heard && !this.media.paused;
  }

  /** Stopped after it started: the voice is silent, whatever the cues say. */
  get paused(): boolean {
    return this.heard && this.media.paused;
  }

  /**
   * `playing` or `seeked`: the element's position is authoritative. Returns
   * it, in ms, for the caller to re-place anything walked on cue time.
   */
  sync(now: number): number {
    this.heard = true;
    const media = this.position();
    this.anchor(media, now);
    this.lastRead = media;
    return media;
  }

  /** Cue time in ms at frame time `now`. */
  read(now: number): number {
    if (!this.heard) return 0;
    const media = this.position();
    if (this.media.paused) {
      this.anchor(media, now);
      this.lastRead = media;
      return media;
    }
    if (media !== this.lastMedia) this.anchor(media, now);
    const estimate = this.anchorMedia + Math.min(Math.max(0, now - this.anchorNow), MAX_EXTRAPOLATION_MS);
    this.lastRead = Math.max(this.lastRead, estimate);
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
