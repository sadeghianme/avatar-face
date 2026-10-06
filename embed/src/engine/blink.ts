/**
 * When to blink.
 *
 * The previous scheduler was a timer: every 2.2-5.4 seconds, blink. It
 * looked mechanical for a reason that is easy to state and hard to notice:
 * people do not blink at random moments, they blink BETWEEN things. At the
 * end of a phrase, when the eyes jump to a new target, as the head starts
 * to turn, when they stop talking. A blink that lands in the middle of a
 * word, or that fails to arrive when the gaze leaps, is what the eye picks
 * up as "puppet" without being able to say why.
 *
 * So blinks are now placed by events, with the timer only as a fallback so
 * a long still stare still blinks. The rules, each from the literature on
 * spontaneous blinking:
 *
 * - A pause in speech gets a blink (blink rate peaks at clause boundaries).
 * - A large saccade gets a blink (gaze shifts and blinks co-occur).
 * - A head turn of any size gets a blink at its onset.
 * - Speech ending gets a blink.
 * - A timer blink that falls due mid-word WAITS for the next word gap —
 *   but not forever, or a long word-dense sentence would never blink.
 * - No two blinks closer than a refractory gap: an event and a timer both
 *   firing at once must produce one blink, not a flutter.
 *
 * The ease is asymmetric, close fast and open slow, which is the shape of
 * a real blink (the close is a muscle contraction; the open is release).
 */

/** Total blink duration. Fast: a real blink is 100-150ms, and the lid
 *  sweep is only ever an approximation, so the less time it is on screen
 *  the better. */
export const BLINK_MS = 150;

/** Fraction of the blink spent closing; the rest is the slower opening. */
export const BLINK_CLOSE_FRACTION = 0.35;

/** Two blinks closer than this become one. */
export const BLINK_MIN_GAP_MS = 600;

/** Fallback cadence for a still, silent face. */
export const IDLE_BLINK_MIN_MS = 2400;
export const IDLE_BLINK_JITTER_MS = 3400;

/** A timer blink that falls due mid-word waits for a gap at most this long. */
export const MAX_DEFER_MS = 900;

/** Saccades smaller than this (in eye-widths) do not pull a blink along. */
export const SACCADE_BLINK_THRESHOLD = 0.28;

/**
 * Blink envelope, 0..1 -> 0..1, closing faster than it opens.
 *
 * One continuous raised cosine over a skewed clock rather than two joined
 * quarter-waves: the old pair met at the peak with a discontinuous velocity,
 * so the lid arrived at its lowest point and reversed in one frame, which
 * reads as a snap. No phase offset: the eye is open at rest, so the curve
 * must start at zero or a single blink renders as shut-open-shut.
 */
export function blinkEase(phase: number): number {
  const t = Math.max(0, Math.min(1, phase));
  const c = BLINK_CLOSE_FRACTION;
  const skewed = t < c ? (t / c) * 0.5 : 0.5 + ((t - c) / (1 - c)) * 0.5;
  return 0.5 - 0.5 * Math.cos(skewed * Math.PI * 2);
}

export interface BlinkContext {
  speaking: boolean;
  /** A viseme other than silence is active right now — mid-word. */
  wordActive: boolean;
}

export class BlinkScheduler {
  /** 0 when the eye is open; (0, 1] while a blink is in progress. */
  phase = 0;

  private nextTimerAt = 0;
  private lastBlinkAt = -Infinity;
  /** When a timer blink fell due and started waiting for a word gap. */
  private deferredSince: number | null = null;

  constructor(private random: () => number = Math.random) {}

  /** First blink soon after appearing; a face that stares for five seconds
   *  before its first blink has already been read as a picture. */
  reset(now: number): void {
    this.nextTimerAt = now + 1200 + this.random() * 2000;
    this.lastBlinkAt = -Infinity;
    this.deferredSince = null;
    this.phase = 0;
  }

  /** Advance the blink in progress, and fire the fallback timer when due. */
  update(dt: number, now: number, ctx: BlinkContext): void {
    if (this.phase > 0) {
      this.phase += dt / BLINK_MS;
      if (this.phase >= 1) this.phase = 0;
    }

    if (now >= this.nextTimerAt && this.deferredSince === null) {
      this.deferredSince = now;
      this.nextTimerAt = now + IDLE_BLINK_MIN_MS + this.random() * IDLE_BLINK_JITTER_MS;
    }
    if (this.deferredSince !== null) {
      const gap = !ctx.speaking || !ctx.wordActive;
      if (gap || now - this.deferredSince >= MAX_DEFER_MS) {
        this.deferredSince = null;
        this.fire(now);
      }
    }
  }

  /** Speech reached a pause: the classic blink moment. */
  onPause(now: number): void {
    this.fire(now);
  }

  /** Speech ended. */
  onSpeechEnd(now: number): void {
    this.fire(now);
  }

  /** The gaze jumped; large jumps carry a blink with them. */
  onSaccade(now: number, magnitude: number): void {
    if (magnitude >= SACCADE_BLINK_THRESHOLD) this.fire(now);
  }

  /** The head began a move. */
  onHeadTurn(now: number): void {
    this.fire(now);
  }

  /** Console/debug: blink now, subject to the same refractory gap. */
  force(now: number): void {
    this.fire(now);
  }

  private fire(now: number): void {
    if (now - this.lastBlinkAt < BLINK_MIN_GAP_MS) return;
    if (this.phase > 0) return;
    this.phase = 0.0001;
    this.lastBlinkAt = now;
    // An event blink resets the fallback clock, so the timer does not add a
    // second blink right after an earned one.
    this.nextTimerAt = now + IDLE_BLINK_MIN_MS + this.random() * IDLE_BLINK_JITTER_MS;
    this.deferredSince = null;
  }
}
