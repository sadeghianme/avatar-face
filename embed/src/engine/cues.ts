/**
 * The cue track, read: how a viseme track is thinned to articulation rate,
 * where its accents fall, and what shape the mouth makes at any instant.
 *
 * Pure functions of the cues and the rig's viseme table. The engine's clock
 * (speech.ts) decides WHEN to read them; this decides what they say.
 */
import { ZERO_WEIGHTS, type BlendWeights, type Cue, type Rig } from "../types";

export const VOWEL_VISEMES: ReadonlySet<string> = new Set(["aa", "E", "ih", "oh", "ou"]);

/**
 * The head's downward motion starts a little before the syllable is heard:
 * the gesture accompanies the accent rather than reacting to it.
 */
const BEAT_LEAD_MS = 80;
/** No two beats closer than this. People accent phrases, not syllables; a
 *  nod per stressed vowel is a bobblehead. */
const BEAT_MIN_GAP_MS = 900;
/** How prominent a vowel must be, relative to the track's own loudest, to
 *  earn a beat. Relative because a quiet sentence still has accents. */
const BEAT_THRESHOLD = 0.72;

export interface Beat {
  t: number;
  strength: number;
}

/**
 * Where in an utterance the head should mark the beat.
 *
 * Speakers move their heads down on accented syllables — it is one of the
 * most reliable pairings in conversation, and its absence is part of why a
 * talking head reads as a puppet with a moving mouth. The information is
 * already in the cue track: after the server measures the rendered audio,
 * a vowel's amplitude is how loud that syllable actually was, so the
 * accents are the prominent vowels.
 *
 * A beat needs to be a LOCAL peak, not merely loud — in a uniformly
 * emphatic sentence every vowel clears an absolute threshold and the head
 * nods continuously. Comparing each vowel to its neighbours finds the
 * syllable the speaker leaned on.
 */
export function emphasisBeats(cues: Cue[]): Beat[] {
  const vowels: { t: number; a: number }[] = [];
  for (const cue of cues) {
    if (VOWEL_VISEMES.has(cue.viseme)) vowels.push({ t: cue.t, a: cue.a ?? 1 });
  }
  if (vowels.length < 2) return [];
  const loudest = Math.max(...vowels.map((v) => v.a));
  if (loudest <= 0) return [];

  const beats: Beat[] = [];
  for (let i = 0; i < vowels.length; i++) {
    const here = vowels[i];
    if (here.a < loudest * BEAT_THRESHOLD) continue;
    const before = vowels[i - 1]?.a ?? 0;
    const after = vowels[i + 1]?.a ?? 0;
    // A peak, or level with a neighbour at the top of the track (a long
    // accented vowel can span two cues at the same amplitude).
    if (here.a < before || here.a < after) continue;
    const at = Math.max(0, here.t - BEAT_LEAD_MS);
    if (beats.length && at - beats[beats.length - 1].t < BEAT_MIN_GAP_MS) continue;
    beats.push({ t: at, strength: Math.min(1.3, 0.7 + (here.a / loudest) * 0.6) });
  }
  return beats;
}

/** Span assumed for the final cue, which has no successor to measure against. */
const DEFAULT_CUE_SPAN_MS = 90;

/**
 * Shape of each cue's dominance bell: exp(-0.5 * |z|^BELL_EXPONENT).
 *
 * A plain Gaussian (exponent 2) is pointy, so neighbouring cues are still
 * contributing at the moment a segment should be at its own target — measured,
 * that clipped peak jaw opening from 0.70 to 0.59, visibly flattening wide
 * vowels. Exponent 4 gives a FLAT TOP with steep shoulders: a segment reaches
 * its full shape in the middle of its own span, then hands over smoothly.
 * Measured against the previous linear blend on a news sentence, this is
 * better on every axis at once — peak 0.702 -> 0.716, lip closure 0.69 ->
 * 0.84, mean |jaw acceleration| 0.0131 -> 0.0089.
 */
const BELL_EXPONENT = 4;
/** Floor on dominance width: below this the bells stop overlapping and the
 * blend degenerates back into snapping from viseme to viseme. */
const MIN_DOMINANCE_MS = 42;

/**
 * Visemes whose shape is an articulatory CONSTRAINT, not a suggestion.
 *
 * A blend is an average, so it can never reach any single viseme's peak —
 * measured, plain coarticulation let /p/ closure fall to 0.37 of its target,
 * i.e. the mouth simply never shut on "m", "p" or "b". No amount of extra
 * weight fixes that; the shapes have to be re-asserted after blending. The
 * value is how fully the constraint is enforced at its own instant.
 */
const IMPERATIVE: Record<string, number> = {
  PP: 1.0,  // p, b, m — full lip closure; the most legible shape there is
  FF: 0.85, // f, v — lower lip tucked to the upper teeth
  // The tongue consonants, now that they survive to be drawn at all. Same
  // argument, weaker claim: a 45-60ms segment cannot reach its own shape
  // through an average dominated by the neighbouring vowel's much wider
  // bell. Held well below PP/FF because a /d/ is a smaller, less legible
  // gesture than a lip closure and should not fight the vowel for the jaw.
  nn: 0.35, // n, l, ng
  DD: 0.3,  // t, d
};

/** Constraint bells are narrower than the blend's own (which uses 0.62× span
 * with a 42ms floor). Measured on a news-reading sentence, 0.7× here is the
 * knee: closure comes back to 0.885 of target while mean |acceleration| stays
 * at half the old linear blend's. Narrower restores the last 1.5% of closure
 * but starts pushing the jerk back up. */
const IMPERATIVE_WIDTH = 0.7;
const MIN_IMPERATIVE_MS = 30;

/**
 * How far ahead of the voice the blend reads the cue track, in ms, at the
 * default smoothness: the articulation's own delay, given back.
 *
 * The shape of a sound is reached in the middle of its span by the bells
 * above, and then the articulation filter (TAU_OPEN, TAU_CLOSE) and the
 * photographic mouth's pose spring each take their time: measured with the
 * real engine on the production cue track, stepped at 60 fps, the lip
 * gap's peaks came 42 ms after the blend's (cross-correlation), the
 * median vowel's peak 67 ms after its bell's and the latest 133 ms. A
 * voice that leads its mouth by more than about 45 ms is seen as out of
 * sync (the picture lagging the sound is the direction people notice).
 * Reading the track this far ahead puts the peaks back on the bells
 * (9 ms by cross-correlation, the median vowel 42 ms, the latest 83) and
 * starts each shape before its sound, which is what a mouth does. The
 * filter half of the delay scales with `smoothness` (articulationLead);
 * the spring's does not.
 */
const ARTICULATION_LEAD_MS = 50;

/** The blend's lead at a smoothness, ms: half the lead is the filter's
 *  delay, which `tune({smoothness})` scales, and half the spring's. */
export function articulationLead(smoothness: number): number {
  return ARTICULATION_LEAD_MS / 2 + ARTICULATION_LEAD_MS / 2 / Math.max(0.15, smoothness);
}

/**
 * A silence shorter than this between two voiced cues is the space between
 * two sounds, not a closure. Native Kokoro timing puts a 25 to 50 ms "sil"
 * between most syllables (`aa ou sil aa RR sil`); prepareCues folds the
 * ones under its floors, and the ones that survive beside a transient
 * (nn, DD, TH, PP, FF relax the floor to 40 ms) would shut the mouth for a
 * frame or two in the middle of a word. A real speaker closes the lips on
 * /p/ /b/ /m/ and at the ends of phrases, not between syllables, so such a
 * silence pulls toward rest only in proportion to its length; a pause this
 * long or longer, a silence at the start or the end of the track, or one
 * beside another silence, pulls whole.
 */
const SHORT_SILENCE_MS = 110;

const MIN_CUE_MS = 85;

/**
 * Shapes that are transients, not dwells — a closure or a tongue contact that
 * happens and is gone. Folding them at the dwell rate deleted them: measured
 * over a /l/-heavy paragraph, of 37 tongue consonants only 2 survived to be
 * drawn, so "the little girl said" was mimed as one unbroken vowel smear.
 * The planner already exempts these from its own dwell floor for the same
 * reason; this is the client half of the same argument.
 */
const TRANSIENT_VISEMES = new Set(["PP", "FF", "TH", "DD", "nn"]);
const MIN_TRANSIENT_CUE_MS = 40;

/**
 * Downsample a cue track to articulation rate. Per-character tracks (one
 * cue every ~75ms) make the mouth wobble through noise; real speech reads
 * as ~4-6 mouth keyframes per second, dominated by vowels (jaw) with
 * consonants as brief shaping. Cues closer than MIN_CUE_MS are folded into
 * their predecessor, preferring vowels when they collide.
 */
export function prepareCues(cues: Cue[]): Cue[] {
  if (cues.length <= 2) return cues;
  const out: Cue[] = [];
  for (const cue of cues) {
    const last = out[out.length - 1];
    // A transient on EITHER side relaxes the floor: a /d/ followed 50ms later
    // by its vowel has to keep both, or the consonant is swallowed by the
    // vowel that follows it exactly as often as by the one before.
    const floorMs =
      TRANSIENT_VISEMES.has(cue.viseme) || (last && TRANSIENT_VISEMES.has(last.viseme))
        ? MIN_TRANSIENT_CUE_MS
        : MIN_CUE_MS;
    if (last && cue.t - last.t < floorMs) {
      // Collides with the previous keyframe: vowels win (they carry the
      // jaw motion); otherwise keep the existing one. Replace the WHOLE cue
      // rather than just its viseme — the old in-place `last.viseme = ...`
      // left the deleted cue's other fields behind, so a vowel could inherit
      // a consonant's stress amplitude.
      if (VOWEL_VISEMES.has(cue.viseme) && !VOWEL_VISEMES.has(last.viseme)) {
        out[out.length - 1] = { ...cue, t: last.t };
      }
      continue;
    }
    if (last && last.viseme === cue.viseme) continue;
    out.push({ ...cue });
  }
  // Always end closed, at the track's true end time.
  const end = cues[cues.length - 1];
  const lastOut = out[out.length - 1];
  if (!lastOut || lastOut.viseme !== "sil" || lastOut.t < end.t) {
    out.push({ t: Math.max(end.t, (lastOut?.t ?? 0) + 1), viseme: "sil", a: 1 });
  }
  return out;
}

/** How long a cue track runs, for pacing the speech exhale. The last cue is
 *  normally the closing silence, so its time is the utterance length. */
export function utteranceMs(cues: Cue[]): number {
  let last = 0;
  for (const cue of cues) if (cue.t > last) last = cue.t;
  return last;
}

/** The viseme sounding at cue time `t`: the last cue at or before it. */
export function visemeAt(cues: readonly Cue[], t: number): string {
  let viseme = "sil";
  for (const cue of cues) {
    if (cue.t <= t) viseme = cue.viseme;
    else break;
  }
  return viseme;
}

/**
 * Co-articulated viseme weights at cue time `t`: instead of stepping to each
 * cue, blend between the current and next viseme across the cue interval —
 * real mouths are always mid-transition, never parked on a phoneme.
 */
export function blendCueWeights(cues: readonly Cue[], visemes: Rig["visemes"], t: number): BlendWeights {
  let index = -1;
  for (let i = 0; i < cues.length; i++) {
    if (cues[i].t <= t) index = i;
    else break;
  }
  if (index < 0) return { ...ZERO_WEIGHTS };

  // Coarticulation by overlapping dominance (Cohen-Massaro). Blending only
  // the two bracketing cues walked the mouth in straight lines from one
  // viseme vertex to the next, with a velocity corner at every cue — that
  // piecewise-linear zigzag is what read as "random" darting. Here every
  // cue near `t` contributes on a smooth bell, so the shape at any instant
  // is a weighted mixture of what the mouth just did, is doing, and is
  // about to do. That is also how real articulators behave: /k/ in "key"
  // and "coo" are different shapes because the vowel is already pulling.
  const out = { ...ZERO_WEIGHTS };
  const keys = Object.keys(out) as (keyof BlendWeights)[];
  const from = Math.max(0, index - 2);
  const to = Math.min(cues.length, index + 3);
  const spanOf = (i: number): number => {
    const next = cues[i + 1];
    return next ? Math.max(1, next.t - cues[i].t) : DEFAULT_CUE_SPAN_MS;
  };
  // A short silence between two voiced cues is the space between two
  // sounds, not a closure (SHORT_SILENCE_MS): the mouth passes through,
  // pulled toward rest only in proportion to how long the silence is.
  const silShare = (i: number): number => {
    if (cues[i].viseme !== "sil") return 1;
    const before = cues[i - 1], after = cues[i + 1];
    if (!before || !after || before.viseme === "sil" || after.viseme === "sil") return 1;
    return Math.min(1, spanOf(i) / SHORT_SILENCE_MS);
  };

  let totalWeight = 0;
  for (let i = from; i < to; i++) {
    const span = spanOf(i);
    // Bell centred on the cue's own span, widened for longer sounds.
    const sigma = Math.max(MIN_DOMINANCE_MS, span * 0.62);
    const z = Math.abs(t - (cues[i].t + span / 2)) / sigma;
    const weight = Math.exp(-0.5 * Math.pow(z, BELL_EXPONENT)) * silShare(i);
    if (weight < 1e-3) continue;
    const shape = visemes[cues[i].viseme] ?? {};
    // Stress amplitude: an unstressed syllable is a smaller mouth, not a
    // faster one. Scaling the shape (rather than the duration) is what
    // makes "MARket" look like one stressed and one reduced syllable
    // instead of two identical ones.
    const amp = cues[i].a ?? 1;
    for (const key of keys) out[key] += (shape[key] ?? 0) * amp * weight;
    totalWeight += weight;
  }
  if (totalWeight <= 0) {
    return { ...ZERO_WEIGHTS, ...(visemes[cues[index].viseme] ?? {}) };
  }
  for (const key of keys) out[key] /= totalWeight;

  // Constraint pass: pull the blended shape back onto the closure-critical
  // visemes. The gate is itself a smooth bell, so re-asserting the target
  // costs no continuity — it only sharpens where a real mouth is sharp.
  for (let i = from; i < to; i++) {
    const strength = IMPERATIVE[cues[i].viseme];
    if (!strength) continue;
    const span = spanOf(i);
    const sigma = Math.max(MIN_IMPERATIVE_MS, span * IMPERATIVE_WIDTH);
    const z = (t - (cues[i].t + span / 2)) / sigma;
    // Deliberately NOT scaled by the cue's stress amplitude: /p/ /b/ /m/
    // close completely in an unstressed syllable too — "puPPET" shuts the
    // lips twice, equally, whatever the stress does to the vowels.
    const gate = Math.exp(-0.5 * z * z) * strength;
    if (gate < 1e-3) continue;
    const shape = visemes[cues[i].viseme] ?? {};
    for (const key of keys) out[key] += ((shape[key] ?? 0) - out[key]) * gate;
  }
  return out;
}
