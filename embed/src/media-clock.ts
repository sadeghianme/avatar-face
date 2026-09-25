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
 * widget, which the stable engine may import (the engine never imports lab/).
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
 *   mouth instead of freezing it mid-vowel.
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
  private started = false;
  private anchorMedia = 0;
  private anchorNow = 0;
  private lastMedia = Number.NaN;
  private lastRead = 0;

  constructor(private readonly media: MediaTime) {}

  /** Has the element started playing (a `playing` event has been seen)? */
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
    this.started = true;
    const media = this.position();
    this.anchor(media, now);
    this.lastRead = media;
    return media;
  }

  /** Cue time in ms at frame time `now`. */
  read(now: number): number {
    if (!this.started) return 0;
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
