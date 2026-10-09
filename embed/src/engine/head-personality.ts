/**
 * The head's "personality" for the 3D turn (EngineOptions.headMotion "3d",
 * a person's photo's default): a pose in degrees of a real head rather than
 * pixels of a layer, from a small procedural model. Conservative: at most
 * 9 degrees of yaw, 5 of pitch and 3 of roll (POSE_LIMIT_DEG), the
 * envelope's peaks easing into those limits rather than cut off at them.
 *
 *  - Drift: band-limited noise, three incommensurate sines per axis between
 *    0.1 and 0.6 Hz with seeded phases, small, livelier while speaking.
 *  - Posture: a critically damped spring chasing a target re-picked every
 *    few seconds while idle (a glance somewhere, the eyes going first), and
 *    at each phrase start while speaking (a small yaw shift, the chin
 *    lifting); at a phrase end the head settles (comes back toward centre,
 *    the chin dropping a little).
 *  - Accents: the cue track's stressed syllables (local amplitude peaks)
 *    get a quick nod, the strongest of a phrase a brow raise too.
 *  - Gaze: the eyes hold the listener while the head moves (they counter
 *    the head's turn), lead every head turn by ~150 ms when the head turns
 *    to look somewhere, and the head's larger moves carry a blink.
 *
 * Seeded (mulberry32), so a render is reproducible frame for frame.
 */
import type { Cue } from "../types";
import { VOWEL_VISEMES } from "./cues";
import type { HeadPose3D } from "./head-camera";

const DEG = Math.PI / 180;
/** The most of the pose, degrees, before the tuning's scale. */
export const POSE_LIMIT_DEG = { yaw: 9, pitch: 5, roll: 3 };
/** The yaw's drives (the drift, a phrase's shift, a glance) were set for a
 *  7 degree limit; since the hair and the head's outline turn with the face
 *  (head-field.ts) the limit is 9, and they reach as far in proportion. The
 *  roll a turn brings with it is the 7 degree turn's still, and so is the
 *  head's rigid travel (engine.ts headFrame3d): the two degrees more are the
 *  face's and the hair's. */
export const YAW_GAIN = POSE_LIMIT_DEG.yaw / 7;
/** Past this share of its limit an axis eases into it (softLimit). */
const KNEE = 0.7;
/** The eyes go first: a head turn starts this long after the saccade. */
const EYE_LEAD_MS = 150;
/** Silence inside a cue track longer than this separates phrases. */
const PHRASE_GAP_MS = 220;
/** No two accents closer than this. */
const ACCENT_GAP_MS = 380;
/** A vowel louder than this share of the track's loudest, and a local peak,
 *  is stressed. */
const ACCENT_THRESHOLD = 0.55;
/** Eye-widths of gaze per radian of the head's turn the eyes counter. */
const GAZE_PER_RAD = 2.2;

export interface Phrase {
  start: number;
  end: number;
}
export interface Accent {
  t: number;
  strength: number;
  brow: boolean;
}

/** The phrases (voiced runs between silences) and stressed syllables of a
 *  prepared cue track, cue ms. */
export function readSpeech(cues: readonly Cue[]): { phrases: Phrase[]; accents: Accent[] } {
  const phrases: Phrase[] = [];
  let open: Phrase | null = null;
  for (let k = 0; k < cues.length; k++) {
    const c = cues[k];
    const next = cues[k + 1]?.t ?? c.t + 90;
    if (c.viseme === "sil") {
      if (open && next - c.t >= PHRASE_GAP_MS) {
        open.end = c.t;
        phrases.push(open);
        open = null;
      }
    } else if (!open) open = { start: c.t, end: next };
    else open.end = next;
  }
  if (open) phrases.push(open);
  const vowels = cues.filter((c) => VOWEL_VISEMES.has(c.viseme)).map((c) => ({ t: c.t, a: c.a ?? 1 }));
  const loud = Math.max(0, ...vowels.map((v) => v.a));
  const accents: Accent[] = [];
  for (let i = 0; i < vowels.length && loud > 0; i++) {
    const v = vowels[i];
    if (v.a < loud * ACCENT_THRESHOLD) continue;
    if (v.a < (vowels[i - 1]?.a ?? 0) || v.a < (vowels[i + 1]?.a ?? 0)) continue;
    const t = Math.max(0, v.t - 60);
    if (accents.length && t - accents[accents.length - 1].t < ACCENT_GAP_MS) continue;
    accents.push({ t, strength: v.a / loud, brow: false });
  }
  // The strongest accent of each phrase lifts the brows (if strong at all).
  for (const p of phrases) {
    const inside = accents.filter((a) => a.t >= p.start - 100 && a.t <= p.end);
    const top = inside.reduce<Accent | null>((m, a) => (!m || a.strength > m.strength ? a : m), null);
    if (top && top.strength > 0.85) top.brow = true;
  }
  return { phrases, accents };
}

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

type Axis = "yaw" | "pitch" | "roll";
const AXES: Axis[] = ["yaw", "pitch", "roll"];

export class HeadPersonality {
  /** The pose now, radians, before the tuning's scale. */
  readonly pose: HeadPose3D = { yaw: 0, pitch: 0, roll: 0 };
  /** How far the brows are raised, 0..1. */
  brow = 0;
  /** Where the eyes look, eye-widths, in the head (paint-eyes.ts): the
   *  attention's direction less the head's own turn. */
  readonly gaze = { x: 0, y: 0 };
  /** The most recent move onset and its size (radians), for the blink. */
  movedAt = -Infinity;
  moveSize = 0;

  private readonly random: () => number;
  private readonly sines: Record<Axis, { f: number; p: number; a: number }[]>;
  private readonly posture: HeadPose3D = { yaw: 0, pitch: 0, roll: 0 };
  private readonly vel: HeadPose3D = { yaw: 0, pitch: 0, roll: 0 };
  private readonly target: HeadPose3D = { yaw: 0, pitch: 0, roll: 0 };
  /** A head target waiting for the eyes to lead it. */
  private pending: { at: number; pose: HeadPose3D; settle: number } | null = null;
  private settleS = 0.8;
  private nextShiftAt = 0;
  /** Where the attention is, radians of yaw and pitch (0, 0: the listener). */
  private attention = { yaw: 0, pitch: 0 };
  private phrases: Phrase[] = [];
  private accents: Accent[] = [];
  private nextPhrase = 0;
  private nextAccent = 0;
  private phraseEnded = -1;
  private nods: { at: number; strength: number }[] = [];
  private brows: number[] = [];
  private t0 = 0;

  constructor(seed = 1) {
    this.random = mulberry32(seed);
    const r = this.random;
    const make = (amp: number) =>
      [0.11, 0.23, 0.47].map((f, k) => ({
        f: f * (0.85 + 0.3 * r()),
        p: r() * Math.PI * 2,
        a: (amp * [1, 0.6, 0.3][k]) / 1.4,
      }));
    this.sines = { yaw: make(1.0 * YAW_GAIN * DEG), pitch: make(0.7 * DEG), roll: make(0.45 * DEG) };
  }

  start(now: number): void {
    this.t0 = now;
    this.nextShiftAt = now + 1500 + this.random() * 1500;
  }

  /** A cue track begins (or is replaced): its phrases and accents, walked
   *  on the cue clock from `ms`. */
  setSpeech(cues: readonly Cue[], ms = 0): void {
    const s = readSpeech(cues);
    this.phrases = s.phrases;
    this.accents = s.accents;
    this.nextPhrase = s.phrases.findIndex((p) => p.start >= ms - 1);
    if (this.nextPhrase < 0) this.nextPhrase = s.phrases.length;
    this.nextAccent = s.accents.findIndex((a) => a.t >= ms - 1);
    if (this.nextAccent < 0) this.nextAccent = s.accents.length;
    this.phraseEnded = this.nextPhrase - 1;
  }

  endSpeech(now: number): void {
    this.phrases = [];
    this.accents = [];
    // The settle after the last word, and a pause before the next glance.
    this.turnTo({ yaw: this.posture.yaw * 0.4, pitch: 0.7 * DEG, roll: this.posture.roll * 0.4 }, now, 1.1, false);
    this.nextShiftAt = now + 1800 + this.random() * 1500;
  }

  /** Advance to `now` (`dt` ms). `cueTime` is read while speaking. */
  update(dt: number, now: number, speaking: boolean, energy: number, cueTime: () => number): void {
    const r = this.random;
    const step = Math.min(dt, 50) / 1000;
    if (speaking && (this.phrases.length || this.accents.length)) {
      const t = cueTime();
      // Phrase starts: a new posture, the eyes first.
      while (this.nextPhrase < this.phrases.length && this.phrases[this.nextPhrase].start - EYE_LEAD_MS <= t) {
        const k = this.nextPhrase++;
        const side = r() < 0.5 ? -1 : 1;
        const yaw = side * (1.2 + r() * 2.6) * DEG;
        // Mostly the eyes stay on the listener; sometimes they go with it.
        const look = r() < 0.3;
        this.turnTo(
          { yaw: yaw * YAW_GAIN, pitch: -(0.4 + r() * 0.7) * DEG, roll: yaw * 0.25 + (r() - 0.5) * 0.9 * DEG },
          now,
          0.55,
          look
        );
        if (k === 0) this.nextShiftAt = Infinity;
      }
      // Phrase ends: settle, back toward the centre, chin dropping a little.
      for (let k = Math.max(0, this.phraseEnded + 1); k < this.nextPhrase; k++) {
        if (this.phrases[k].end <= t) {
          this.phraseEnded = k;
          this.turnTo(
            { yaw: this.posture.yaw * 0.45, pitch: 0.6 * DEG, roll: this.posture.roll * 0.4 },
            now,
            0.9,
            false
          );
        }
      }
      // Accents: a nod, and the strongest a brow raise.
      while (this.nextAccent < this.accents.length && this.accents[this.nextAccent].t <= t) {
        const a = this.accents[this.nextAccent++];
        if (t - a.t > 300) continue; // stale after a seek
        this.nods.push({ at: now, strength: a.strength });
        if (a.brow) this.brows.push(now);
      }
    } else if (now >= this.nextShiftAt) {
      // Idle: a glance somewhere and back, eyes first.
      this.nextShiftAt = now + 2600 + r() * 3600;
      const draw = () => {
        const v = r() * 2 - 1;
        return Math.sign(v) * v * v;
      };
      const away = r() < 0.55;
      const yaw = away ? draw() * 4.8 * DEG : (this.posture.yaw / YAW_GAIN) * 0.3;
      const pitch = away ? draw() * 2.2 * DEG + 0.5 * DEG : 0;
      this.turnTo({ yaw: yaw * YAW_GAIN, pitch, roll: yaw * 0.3 + draw() * 0.9 * DEG }, now, 0.8, away);
    }
    // The pending head move, once the eyes have led it.
    if (this.pending && now >= this.pending.at) {
      const p = this.pending;
      this.pending = null;
      this.moveSize = Math.abs(p.pose.yaw - this.posture.yaw) + Math.abs(p.pose.pitch - this.posture.pitch);
      this.movedAt = now;
      this.settleS = p.settle;
      Object.assign(this.target, p.pose);
    }
    // The posture spring: critically damped, no overshoot.
    const omega = (2 * Math.PI) / this.settleS;
    for (const ax of AXES) {
      const d = this.posture[ax] - this.target[ax];
      this.vel[ax] += (-2 * omega * this.vel[ax] - omega * omega * d) * step;
      this.posture[ax] += this.vel[ax] * step;
    }
    // Drift: band-limited noise, livelier while speaking.
    const s = (now - this.t0) / 1000;
    const lively = speaking ? 1.15 + 0.5 * energy : 1;
    // Nods: a quick dip and back (fast in, slower out), ~420 ms.
    let nod = 0;
    this.nods = this.nods.filter((n) => now - n.at < 520);
    for (const n of this.nods) {
      const u = (now - n.at) / 520;
      const env = u < 0.3 ? Math.sin((u / 0.3) * (Math.PI / 2)) ** 2 : Math.cos(((u - 0.3) / 0.7) * (Math.PI / 2)) ** 2;
      nod += env * n.strength * (1.0 + 0.8 * energy) * DEG;
    }
    let brow = 0;
    this.brows = this.brows.filter((b) => now - b < 700);
    for (const b of this.brows) brow = Math.max(brow, Math.sin(((now - b) / 700) * Math.PI) ** 2);
    this.brow = brow;
    for (const ax of AXES) {
      let v = 0;
      for (const w of this.sines[ax]) v += w.a * Math.sin(2 * Math.PI * w.f * s + w.p);
      this.pose[ax] = this.posture[ax] + v * lively;
    }
    this.pose.pitch += nod;
    const lim = POSE_LIMIT_DEG;
    this.pose.yaw = softLimit(this.pose.yaw, lim.yaw * DEG);
    this.pose.pitch = softLimit(this.pose.pitch, lim.pitch * DEG);
    this.pose.roll = softLimit(this.pose.roll, lim.roll * DEG);
    // The eyes: on the attention, less the head's own turn (they hold the
    // listener while the head moves), and ahead of it on a glance.
    this.gaze.x = clamp((this.attention.yaw - this.pose.yaw) * GAZE_PER_RAD, 0.6);
    this.gaze.y = clamp((this.attention.pitch - this.pose.pitch) * GAZE_PER_RAD * 0.8, 0.5);
  }

  /** Head to `pose` (settling over `settle` s) EYE_LEAD_MS from now; with
   *  `look`, the eyes jump there now, else they stay on the listener. */
  private turnTo(pose: HeadPose3D, now: number, settle: number, look: boolean): void {
    this.attention = look ? { yaw: pose.yaw, pitch: pose.pitch } : { yaw: 0, pitch: 0 };
    this.pending = { at: now + EYE_LEAD_MS, pose: { ...pose }, settle };
  }
}

function clamp(v: number, m: number): number {
  return Math.max(-m, Math.min(m, v));
}

/**
 * `v` as it is up to KNEE of `limit`, then eased toward the limit (a tanh
 * knee, the slope continuous): never past it, and a peak that would have
 * gone past it rounds off instead of flattening against it.
 */
export function softLimit(v: number, limit: number): number {
  const knee = KNEE * limit;
  const a = Math.abs(v);
  if (a <= knee) return v;
  const room = limit - knee;
  return Math.sign(v) * (knee + room * Math.tanh((a - knee) / room));
}
