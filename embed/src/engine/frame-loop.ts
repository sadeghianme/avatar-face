/**
 * An engine's frame loop: one call per animation frame from the first
 * frame after it is made until it is stopped, pausable while the avatar is
 * off-screen. Both engines run on it.
 *
 * Once stopped it stays stopped — a frame already scheduled finds the flag
 * and does nothing — which is what makes mount -> unmount -> mount safe
 * under React StrictMode.
 */
export class FrameLoop {
  private raf = 0;
  private stopped = false;

  /** Starts at once: `onFrame` runs on the next animation frame. */
  constructor(private readonly onFrame: (now: number) => void) {
    this.raf = requestAnimationFrame(this.onAnimationFrame);
  }

  private readonly onAnimationFrame = (now: number): void => {
    if (this.stopped) return;
    this.onFrame(now);
    this.raf = requestAnimationFrame(this.onAnimationFrame);
  };

  /**
   * Pause or resume, e.g. when the avatar scrolls out of view. Browsers
   * already stop animation frames in hidden tabs; this covers a visible tab
   * where the canvas is simply off-screen.
   */
  setActive(active: boolean): void {
    if (this.stopped) return;
    if (!active) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    } else if (!this.raf) {
      this.raf = requestAnimationFrame(this.onAnimationFrame);
    }
  }

  /** For good. */
  stop(): void {
    this.stopped = true;
    cancelAnimationFrame(this.raf);
  }
}

/**
 * The step between one tick and the next, ms, clamped to 4..64: a hidden
 * tab or a stall resumes the motion where it was rather than lurching, and
 * the first tick counts as one 60 Hz frame.
 */
export class FrameStep {
  private lastTickAt = 0;

  next(now: number): number {
    const dt = Math.min(64, Math.max(4, now - (this.lastTickAt || now - 16.7)));
    this.lastTickAt = now;
    return dt;
  }
}
