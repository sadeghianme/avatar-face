/**
 * The expressions over time (docs/emotions.md): how much of each is on this
 * frame. Three layers sum into one mix the face state carries (state.ts)
 * and the deformation lays on the face (expression-rig.ts):
 *
 *  - what a page asked (engine.setExpression) or a text's tags set
 *    (an expression track on the speech's clock): one expression at a time,
 *    on an envelope, the one before cross-fading out;
 *  - the idle micro-expressions (IdleExpressions): a faint resting smile and
 *    a brow flash on an accent, under the first in proportion to it.
 *
 * Every envelope is a function of the frame time, so a render on a virtual
 * clock is the same frame for frame. The idle layer draws on its own seeded
 * random source, never on Math.random: turning it on moves no other part's
 * sequence (the blinks', the gaze's).
 */
import type { Point } from "./geometry";
import { EXPRESSIONS, SHAPE_NAMES, type ExpressionName, type ShapeName } from "./expression-table";
import { NONE, type ShapeMix } from "./expression-rig";

/** How an expression comes on and goes (engine.setExpression). */
export interface ExpressionTiming {
  /** From wherever the face is to the intensity, ms (default 300). */
  attackMs?: number;
  /** How long it holds, ms; default: until another is set. */
  holdMs?: number;
  /** Back to nothing, ms (default 500). */
  releaseMs?: number;
}

/** One event of an expression track: from cue time `t` (ms), `name` at
 *  `intensity`, held for `holdMs` (default: until the next). */
export interface ExpressionCue {
  t: number;
  name: ExpressionName;
  intensity: number;
  holdMs?: number;
}

/** Who set the expression that is on. */
export type ExpressionSource = "api" | "text";

/** The expressions now (engine.expression). */
export interface ExpressionState {
  /** The expression last asked for ("neutral" once released). */
  readonly name: ExpressionName;
  /** The intensity it was asked at. */
  readonly intensity: number;
  /** How far it is in now, 0..intensity. */
  readonly level: number;
  /** Who asked: a page, or a text's tag (released when the text ends). */
  readonly source: ExpressionSource | null;
  /** Every shape's weight this frame, idle micro-expressions included. */
  readonly weights: ShapeMix;
}

export const DEFAULT_ATTACK_MS = 300;
export const DEFAULT_RELEASE_MS = 500;
/** A tag's expression comes on a little faster than a page's default. */
export const TEXT_ATTACK_MS = 250;

const smoothstep = (t: number): number => {
  const s = Math.max(0, Math.min(1, t));
  return s * s * (3 - 2 * s);
};

/**
 * One weight on an envelope: eased from where it is to a target over a
 * time, held, then eased back to 0. Starting from where it is, never from
 * 0, so a change mid-flight has no jump.
 */
export class Envelope {
  value = 0;
  private from = 0;
  private to = 0;
  private start = 0;
  private dur = 0;
  private holdUntil = Infinity;
  private releaseMs = DEFAULT_RELEASE_MS;

  /** The target now. */
  get target(): number {
    return this.to;
  }

  /** From the value now to `to` over `ms`, then held for `holdMs`, then
   *  released over `releaseMs`. */
  go(now: number, to: number, ms: number, holdMs = Infinity, releaseMs = DEFAULT_RELEASE_MS): void {
    this.step(now);
    this.from = this.value;
    this.to = to;
    this.start = now;
    this.dur = Math.max(0, ms);
    this.holdUntil = to > 0 ? now + this.dur + Math.max(0, holdMs) : Infinity;
    this.releaseMs = releaseMs;
  }

  /** The value at `now`. */
  step(now: number): number {
    if (this.to > 0 && now >= this.holdUntil) {
      this.from = this.to;
      this.start = this.holdUntil;
      this.to = 0;
      this.dur = this.releaseMs;
      this.holdUntil = Infinity;
    }
    const u = this.dur > 0 ? (now - this.start) / this.dur : 1;
    this.value = this.from + (this.to - this.from) * smoothstep(u);
    return this.value;
  }
}

/** Seeded random numbers (mulberry32), as head-personality.ts draws them. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The resting smile's range, how often it is re-picked, and how it eases. */
const IDLE_SMILE = { min: 0.06, max: 0.14, everyMs: [6000, 12000], easeMs: 2000, speaking: 0.5 } as const;
/** A brow flash: up and down over this long, at this height. */
const FLASH = { upMs: 160, holdMs: 120, downMs: 320, level: 0.8, gapMs: 1500 } as const;

/** The idle micro-expressions: a faint resting smile, and a brow flash on
 *  an accent. Seeded, so a render is reproducible. */
export class IdleExpressions {
  private readonly random: () => number;
  private readonly smile = new Envelope();
  private readonly flash = new Envelope();
  private nextPickAt = -Infinity;
  private lastFlashAt = -Infinity;
  private target = 0;

  constructor(seed = 11) {
    this.random = mulberry32(seed);
  }

  /** A brow flash at `now`, unless one was too recent. */
  accent(now: number): void {
    if (now - this.lastFlashAt < FLASH.gapMs) return;
    this.lastFlashAt = now;
    this.flash.go(now, FLASH.level, FLASH.upMs, FLASH.holdMs, FLASH.downMs);
  }

  /** The idle shapes at `now` into `out` (happy, browFlash). */
  step(now: number, speaking: boolean, out: Record<ShapeName, number>): void {
    if (now >= this.nextPickAt) {
      const [lo, hi] = IDLE_SMILE.everyMs;
      this.nextPickAt = now + lo + this.random() * (hi - lo);
      this.target = IDLE_SMILE.min + this.random() * (IDLE_SMILE.max - IDLE_SMILE.min);
    }
    const goal = this.target * (speaking ? IDLE_SMILE.speaking : 1);
    if (Math.abs(this.smile.target - goal) > 1e-6) this.smile.go(now, goal, IDLE_SMILE.easeMs);
    out.happy = this.smile.step(now);
    out.browFlash = this.flash.step(now);
  }
}

/**
 * The expressions over time: set by a page or a track, the idle layer
 * under them, summed into `weights` each step.
 */
export class ExpressionMixer {
  /** This frame's mix (the face state's): read, never kept. */
  readonly weights: Record<ShapeName, number> = { ...NONE };
  /** The idle micro-expressions, when on (setIdle). */
  private idle: IdleExpressions | null = null;
  private readonly idleMix: Record<ShapeName, number> = { ...NONE };
  private readonly envelopes = Object.fromEntries(SHAPE_NAMES.map((s) => [s, new Envelope()])) as Record<
    ShapeName,
    Envelope
  >;
  private asked: { name: ExpressionName; intensity: number; source: ExpressionSource | null } = {
    name: "neutral",
    intensity: 0,
    source: null,
  };
  /** The expression track of the speech in flight, and how far through it. */
  private track: readonly ExpressionCue[] = [];
  private nextCue = 0;

  /**
   * `name` at `intensity` (0..1) from `now`, on `timing`; the one on before
   * fades out over this one's attack. "neutral" (or 0) releases.
   */
  set(name: ExpressionName, intensity: number, timing: ExpressionTiming, now: number, source: ExpressionSource): void {
    const level = Math.max(0, Math.min(1, Number.isFinite(intensity) ? intensity : 0));
    const attack = timing.attackMs ?? DEFAULT_ATTACK_MS;
    const release = timing.releaseMs ?? DEFAULT_RELEASE_MS;
    const off = name === "neutral" || level === 0;
    for (const shape of SHAPE_NAMES) {
      if (shape === "browFlash") continue;
      if (!off && shape === name) this.envelopes[shape].go(now, level, attack, timing.holdMs ?? Infinity, release);
      else if (this.envelopes[shape].target > 0) this.envelopes[shape].go(now, 0, off ? release : attack);
    }
    this.asked = off ? { name: "neutral", intensity: 0, source: null } : { name, intensity: level, source };
  }

  /** Release what a text's tags set (the text ended, or was stopped; with
   *  `drop`, its track goes too). */
  releaseText(now: number, drop = true): void {
    if (this.asked.source === "text") this.set("neutral", 0, {}, now, "text");
    if (drop) this.track = [];
  }

  /** The idle micro-expressions on or off (seeded afresh when turned on). */
  setIdle(on: boolean): void {
    this.idle = on ? (this.idle ?? new IdleExpressions()) : null;
    if (!on) Object.assign(this.idleMix, NONE);
  }

  get idleOn(): boolean {
    return this.idle !== null;
  }

  /** An accent of the speech at `now`: the idle layer's brow flash. */
  accent(now: number): void {
    this.idle?.accent(now);
  }

  /** The speech's expression track, walked from cue time `ms`. */
  setTrack(track: readonly ExpressionCue[], ms = 0): void {
    this.track = [...track].sort((a, b) => a.t - b.t);
    this.seek(ms);
  }

  /** The same track's cues moved in time (a stream learning how long its
   *  speech is): the walker keeps its place in the list, so a cue already
   *  fired is not fired again and one not yet reached still will be. */
  retime(track: readonly ExpressionCue[]): void {
    if (track.length !== this.track.length) {
      this.track = [...track];
      this.nextCue = Math.min(this.nextCue, this.track.length);
      return;
    }
    this.track = [...track];
  }

  /** The track's walker placed at cue time `ms` (a seek, a re-sync). */
  seek(ms: number): void {
    const i = this.track.findIndex((c) => c.t > ms);
    this.nextCue = i < 0 ? this.track.length : i;
  }

  /** Set what the track says up to cue time `cueTime`, at frame time `now`. */
  walk(cueTime: number, now: number): void {
    while (this.nextCue < this.track.length && this.track[this.nextCue].t <= cueTime) {
      const cue = this.track[this.nextCue++];
      // A tag's "neutral" (and the end of a text) releases what the text
      // set, never what a page set.
      if (cue.name === "neutral") this.releaseText(now, false);
      else this.set(cue.name, cue.intensity, { attackMs: TEXT_ATTACK_MS, holdMs: cue.holdMs }, now, "text");
    }
  }

  /** Every shape's weight at `now` into `weights`. */
  step(now: number, speaking: boolean): Readonly<Record<ShapeName, number>> {
    let explicit = 0;
    for (const shape of SHAPE_NAMES) explicit = Math.max(explicit, this.envelopes[shape].step(now));
    if (this.idle) this.idle.step(now, speaking, this.idleMix);
    const under = 1 - explicit;
    for (const shape of SHAPE_NAMES) {
      this.weights[shape] = Math.min(1, this.envelopes[shape].value + this.idleMix[shape] * under);
    }
    return this.weights;
  }

  /** The jaw opening the expressions on ask for (a floor while silent). */
  jaw(): number {
    let jaw = 0;
    for (const shape of SHAPE_NAMES) jaw += (EXPRESSIONS[shape].jaw ?? 0) * this.weights[shape];
    return jaw;
  }

  /** Where the expressions on send the eyes, eye widths, into `out`. */
  gaze(out: Point): Point {
    out.x = 0;
    out.y = 0;
    for (const shape of SHAPE_NAMES) {
      const g = EXPRESSIONS[shape].gaze;
      if (!g) continue;
      out.x += g[0] * this.weights[shape];
      out.y += g[1] * this.weights[shape];
    }
    return out;
  }

  /** Whether any shape is on this frame. */
  active(): boolean {
    for (const shape of SHAPE_NAMES) if (this.weights[shape] > 0) return true;
    return false;
  }

  /** The state a page reads (engine.expression). */
  state(): ExpressionState {
    const { name, intensity, source } = this.asked;
    return { name, intensity, source, level: this.envelopes[name].value, weights: { ...this.weights } };
  }
}
