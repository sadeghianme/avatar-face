/**
 * Standing still, which nobody actually does.
 *
 * Produces a rigid transform — a fraction of a degree of rotation about a
 * pivot below the frame, plus a small vertical rise. Deliberately rigid: the
 * previous attempt at head movement warped the mesh to fake a rotation, which
 * distorts a face rather than turning it. Translating and tipping the whole
 * picture is what a camera actually sees when a subject sways, so there is
 * nothing to get wrong.
 *
 * Rotating about a point below the frame — roughly where the feet are — does
 * two jobs at once. It is the inverted pendulum a standing body actually is,
 * so displacement grows with height and the head moves further than the
 * chest. And it keeps the bottom of the frame nearly still, so nothing drags
 * an empty edge into view.
 *
 * Three motions, modelled separately because they have different causes:
 *
 * - Sway. Standing is continuous correction, never a hold. The model is
 *   Ornstein-Uhlenbeck — a random walk pulled back toward centre — because
 *   real sway is aimless and non-repeating. Sines were tried for head motion
 *   and the loop is visible within about ten seconds.
 * - Weight shifts. Every ten to thirty seconds people move their weight from
 *   one foot to the other. This is the motion that reads as a person rather
 *   than as drift.
 * - Breathing. About fifteen a minute, and asymmetric: the inhale is quicker
 *   than the exhale.
 * - Speech breathing, which is a different pattern altogether. Nobody speaks
 *   on a resting rhythm: there is a quick, deeper inhale as speech begins,
 *   then a long slow exhale for the whole phrase — speaking IS exhaling —
 *   with quick catch-breaths at pauses, and a release when the sentence
 *   ends. The inhale before the first word is the single most convincing
 *   "it is alive" cue there is, and the cue track tells us exactly when it
 *   should happen.
 */

/**
 * Peak-to-peak horizontal head travel, as a fraction of HEAD width.
 *
 * Two sources agree on this number, which is why it is this and not taste.
 *
 * Measured: a SitePal avatar's head centroid moved 8.5px in a frame sampled
 * 300px wide, but that frame spanned the whole 736px subject — shoulders
 * included — so the real displacement is about 21px. Their head is roughly
 * 40% of subject width, which puts the travel near 7% of head width. An
 * earlier version of this constant said 2.8% because it took the measured
 * percentage as a fraction of head width when it was a fraction of subject
 * width; the avatar then moved about a third as much as intended.
 *
 * Physiology: quiet standing sways the head 1-2cm, and a head is about 15cm
 * across, which is 7-13% of head width.
 *
 * At 0.07 the rendered travel measured 2.18% of the sampled frame against
 * SitePal's 2.83%. The transform is exactly linear in this constant, so 0.085
 * lands near 2.6% — close to the reference, still well inside the
 * physiological range, and calm rather than restless.
 */
export const SWAY_TRAVEL = 0.085;

/** How far the head rises on an inhale, as a fraction of face height. */
export const BREATH_RISE = 0.006;

/** Seconds per breath — about fifteen a minute, at rest. */
export const BREATH_PERIOD_S = 4.0;

/** Fraction of the breath cycle spent inhaling. Exhale is the remainder and
 *  is therefore slower, which is what real breathing does. */
const INHALE_FRACTION = 0.4;

/**
 * Speech breathing, in units of the resting breath (0..1 at rest).
 *
 * A speech inhale is deeper than a resting one, so its peak exceeds 1 — the
 * renderer multiplies linearly, so 1.6 is a rise 60% taller than the
 * deepest resting breath. Not more: this is a person starting a sentence,
 * not a swimmer surfacing.
 */
export const SPEECH_INHALE_PEAK = 1.6;
/** How long the pre-speech inhale takes to reach its peak. */
export const SPEECH_INHALE_MS = 320;
/** Where the long exhale settles if the phrase runs on. Not zero: lungs are
 *  never empty mid-sentence, and a chest that sinks to rest while still
 *  talking looks deflated. */
const SPEECH_EXHALE_FLOOR = 0.25;
/** A catch-breath at a pause: smaller and quicker than the opening inhale. */
const CATCH_PEAK = 1.0;
const CATCH_MS = 220;
/** No two catch-breaths closer than this; real pauses that close are one
 *  breath, not two. */
const CATCH_MIN_GAP_MS = 1200;

/** Correlation time of the sway, in seconds. Higher drifts more slowly. */
const SWAY_TAU_S = 2.6;

/** Standing sd of the sway, in units of the peak amplitude. */
const SWAY_SD = 0.30;

/**
 * Inertia, in seconds.
 *
 * An Ornstein-Uhlenbeck process is driven by white noise, so it carries
 * high-frequency content that a body with mass cannot. Following the process
 * through a lag rather than using it directly low-passes that away and leaves
 * the aimless wandering, which is the part worth having.
 */
const SWAY_INERTIA_S = 0.32;

const SHIFT_MIN_MS = 10000;
const SHIFT_JITTER_MS = 20000;

/** A stalled tab must not deliver one huge step and fling the body. */
const MAX_STEP_MS = 50;

export class BodyMotion {
  /** Sway, in -1..1 of the peak amplitude. What the renderer should use. */
  sway = 0;
  /** Breath, 0 at rest to 1 at the top of an inhale. */
  breath = 0;

  private drift = 0;  // the raw process; `sway` follows it with inertia
  private centre = 0; // where the drift is currently pulled toward
  private nextShiftAt = 0;
  private phase = 0;
  private spare: number | null = null;

  // Speech breathing. Analytic in elapsed time rather than integrated, so
  // the same utterance breathes the same way at 30fps and 144fps.
  private speech: {
    startedAt: number;
    exhaleTauMs: number;
    from: number; // breath value the inhale started from — no jump
    catchAt: number; // when the latest catch-breath began, or -Infinity
    catchFrom: number;
  } | null = null;

  constructor(private random: () => number = Math.random) {}

  /**
   * Speech is starting: take a breath, then spend it over the phrase.
   *
   * `durationMs` is the utterance length when known (the last cue's time).
   * The exhale is paced to it — a long sentence is spent slowly, a short one
   * more freely — and clamped so a single word does not look like a gasp
   * and a monologue does not deflate in its first seconds.
   */
  beginSpeech(now: number, durationMs = 4000): void {
    this.speech = {
      startedAt: now,
      exhaleTauMs: Math.max(1500, Math.min(6000, durationMs * 0.6)),
      from: this.breath,
      catchAt: -Infinity,
      catchFrom: 0,
    };
  }

  /** A pause inside the phrase: a small quick breath, then carry on. */
  catchBreath(now: number): void {
    const sp = this.speech;
    if (!sp) return;
    if (now - sp.startedAt < SPEECH_INHALE_MS + CATCH_MIN_GAP_MS) return;
    if (now - sp.catchAt < CATCH_MIN_GAP_MS) return;
    sp.catchAt = now;
    sp.catchFrom = this.breath;
  }

  /**
   * Speech is over: hand the chest back to the resting rhythm exactly where
   * it is. The resting cycle is re-phased so its exhale continues from the
   * current value, rather than restarting at zero with a visible drop.
   */
  endSpeech(): void {
    if (!this.speech) return;
    this.speech = null;
    this.phase = phaseForExhaleValue(this.breath);
  }

  /** The breath value during speech, as a function of time since it began. */
  private speechBreath(now: number): number {
    const sp = this.speech!;
    const t = now - sp.startedAt;
    if (t < SPEECH_INHALE_MS) {
      return sp.from + (SPEECH_INHALE_PEAK - sp.from) * smoothstep(t / SPEECH_INHALE_MS);
    }
    // The long exhale: from the peak toward the floor, exponentially, so it
    // is fastest just after the inhale — which is also how lungs empty.
    const since = t - SPEECH_INHALE_MS;
    let value =
      SPEECH_EXHALE_FLOOR + (SPEECH_INHALE_PEAK - SPEECH_EXHALE_FLOOR) * Math.exp(-since / sp.exhaleTauMs);
    const sinceCatch = now - sp.catchAt;
    if (sinceCatch >= 0 && sinceCatch < CATCH_MS) {
      value = sp.catchFrom + (CATCH_PEAK - sp.catchFrom) * smoothstep(sinceCatch / CATCH_MS);
    } else if (sinceCatch >= CATCH_MS && sinceCatch < CATCH_MS + sp.exhaleTauMs * 3) {
      // Exhale again from the catch peak, blending back onto the main curve.
      const decay = Math.exp(-(sinceCatch - CATCH_MS) / sp.exhaleTauMs);
      value = value + (CATCH_PEAK - value) * decay;
    }
    return value;
  }

  /** Box-Muller. OU needs Gaussian increments; uniform noise gives the drift
   *  a boxy, mechanical quality that is visible at these low frequencies. */
  private gauss(): number {
    if (this.spare !== null) {
      const value = this.spare;
      this.spare = null;
      return value;
    }
    let u = 0;
    let v = 0;
    let s = 0;
    do {
      u = this.random() * 2 - 1;
      v = this.random() * 2 - 1;
      s = u * u + v * v;
    } while (s === 0 || s >= 1);
    const factor = Math.sqrt((-2 * Math.log(s)) / s);
    this.spare = v * factor;
    return u * factor;
  }

  update(dt: number, now: number): void {
    const step = Math.min(dt, MAX_STEP_MS) / 1000;

    if (now >= this.nextShiftAt) {
      this.nextShiftAt = now + SHIFT_MIN_MS + this.random() * SHIFT_JITTER_MS;
      // Shifting weight moves where the body settles, not just where it is.
      this.centre = (this.random() * 2 - 1) * 0.45;
    }

    // Ornstein-Uhlenbeck: pulled toward `centre`, kicked by noise. The sigma
    // is derived from the target standing deviation rather than tuned, so
    // changing tau does not silently change how far the body wanders.
    const sigma = SWAY_SD * Math.sqrt(2 / SWAY_TAU_S);
    this.drift +=
      (-(this.drift - this.centre) / SWAY_TAU_S) * step + sigma * Math.sqrt(step) * this.gauss();
    this.drift = Math.max(-1, Math.min(1, this.drift));

    // Frame-rate independent lag, so the smoothing is the same at 30fps and
    // 144fps rather than being a fixed fraction of whatever frame arrived.
    const follow = 1 - Math.exp(-step / SWAY_INERTIA_S);
    this.sway += (this.drift - this.sway) * follow;

    if (this.speech) {
      this.breath = this.speechBreath(now);
    } else {
      this.phase = (this.phase + step / BREATH_PERIOD_S) % 1;
      this.breath = breathCurve(this.phase);
    }
  }
}

function smoothstep(x: number): number {
  const c = Math.max(0, Math.min(1, x));
  return c * c * (3 - 2 * c);
}

/**
 * The resting-cycle phase whose EXHALE side has this breath value, so a
 * hand-back from speech continues downward from where the chest is.
 * Values above 1 (a speech inhale is deeper than rest) map to the top.
 */
export function phaseForExhaleValue(value: number): number {
  const v = Math.max(0, Math.min(1, value));
  // breathCurve is 0.5 - 0.5cos(2π·skewed); on the exhale side skewed ∈ [0.5, 1].
  const skewed = 1 - Math.acos(1 - 2 * v) / (2 * Math.PI);
  return INHALE_FRACTION + ((skewed - 0.5) / 0.5) * (1 - INHALE_FRACTION);
}

/**
 * One breath, 0 to 1 to 0, with the inhale quicker than the exhale.
 *
 * The phase is skewed before going through a cosine rather than the curve
 * being pieced together, so there is no discontinuity in slope at the top —
 * a corner there reads as a gasp.
 */
export function breathCurve(phase: number): number {
  const p = ((phase % 1) + 1) % 1;
  const skewed =
    p < INHALE_FRACTION
      ? (p / INHALE_FRACTION) * 0.5
      : 0.5 + ((p - INHALE_FRACTION) / (1 - INHALE_FRACTION)) * 0.5;
  return 0.5 - 0.5 * Math.cos(skewed * Math.PI * 2);
}
