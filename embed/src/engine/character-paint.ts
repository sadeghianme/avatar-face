import {
  luma,
  mix,
  rgb,
  tuckAmount,
  type CharacterLook,
  type CharacterTraits,
  type Opening,
  type Pt,
  type Rgb,
} from "./character-mouth";
import { enamelReveal } from "../mouth/lip-occlusion-model";
import type { BlendWeights } from "../types";

/**
 * Painting the character mouth: what is inside the opening.
 *
 * Two looks, chosen by the picture (CharacterLook.flat). Cel art gets flat
 * fills and the picture's own line, because gradients in a flat drawing read
 * as a photograph pasted into it. A render or a photograph gets soft
 * shading, a shadowed upper lip and an edge as soft as the picture's own,
 * because a flat patch in those reads as a sticker. Everything is clipped to
 * the opening, so nothing can reach outside the lips.
 */

/** How high the tongue sits for each sound, 0 (resting) to 1 (against the
 *  teeth). The engine eases it: the sounds are discrete and the tongue is not. */
export const TONGUE_RAISE: Record<string, number> = {
  TH: 1,
  DD: 0.85,
  nn: 0.8,
  SS: 0.55,
  CH: 0.5,
  kk: 0.45,
  RR: 0.4,
  ih: 0.4,
  E: 0.3,
  ou: 0.22,
  oh: 0.12,
  aa: 0.05,
};

export interface CharacterFrameInput {
  opening: Opening;
  clip: Path2D;
  /** The clip's lower edge alone, corner to corner (lowerEdgePath). */
  lowerEdge: Path2D;
  weights: BlendWeights;
  look: CharacterLook;
  traits: CharacterTraits;
  /** 0..1, eased. */
  tongueRaise: number;
  /** The cavity's shade for a rendered or photographed mouth, as the
   *  profile's multiples of the lip colour (top, middle, bottom). */
  cavityShade: readonly [number, number, number];
}

const smooth = (x: number) => {
  const t = Math.max(0, Math.min(1, x));
  return t * t * (3 - 2 * t);
};

/** Enamel, a little warmed by the picture's own skin. */
export const toothColour = (look: CharacterLook): Rgb => mix([252, 249, 242], look.skin, 0.08);

/** A tongue's red, with a trace of this picture's lips in it, and never
 *  darker than the cavity it lies in. */
export function tongueColour(look: CharacterLook): Rgb {
  const base: Rgb = [214, 94, 104];
  const t = mix(base, look.lip, 0.14);
  const floor = luma(mix(look.line, look.lip, 0.2)) + 70;
  const lift = Math.max(0, floor - luma(t));
  return [Math.min(255, t[0] + lift), Math.min(255, t[1] + lift * 0.6), Math.min(255, t[2] + lift * 0.6)];
}

/** A point along a polyline by arc fraction t (0 to 1, corner to corner). */
export function along(line: readonly Pt[], t: number): Pt {
  const f = Math.max(0, Math.min(1, t)) * (line.length - 1);
  const i = Math.min(line.length - 2, Math.floor(f));
  const k = f - i;
  return { x: line[i].x + (line[i + 1].x - line[i].x) * k, y: line[i].y + (line[i + 1].y - line[i].y) * k };
}

/** Taper to nothing at both ends: 1 in the middle, 0 at t = 0 and 1. */
export const bump = (t: number, edge: number) => Math.pow(Math.max(0, 1 - Math.pow(Math.abs(2 * t - 1), edge)), 0.6);

/** How much of the upper teeth show, 0..1: the mouth open, or the lips drawn
 *  back, and never on a rounded mouth. A jaw that has only just parted the
 *  lips shows the dark of the mouth, not a line of enamel (the photographic
 *  mouth's reveal, lip-occlusion-model); lips drawn back show teeth in a
 *  slit, as on "fifty". */
export function teethShown(open: number, w: BlendWeights, traits: CharacterTraits): number {
  if (traits.teeth !== "upper") return 0;
  const rounded = Math.min(1, w.mouthPucker + w.mouthFunnel * 0.6);
  const lift = Math.max(Math.min(open / 0.16, enamelReveal(open, 1)), w.mouthStretch * 1.2);
  return Math.max(0, Math.min(1, lift)) * (1 - Math.min(1, rounded * 1.8));
}

/** The upper teeth's height at the middle, px: most of a narrow opening, a
 *  band of an open one, never more than a tooth. */
export function teethHeight(gap: number, width: number, shown: number): number {
  const narrow = 1 - smooth(gap / (width * 0.2));
  return Math.min(gap * (0.34 + 0.34 * narrow), width * 0.085) * (0.5 + 0.5 * shown);
}

function smoothThrough(ctx: CanvasRenderingContext2D, pts: readonly Pt[], move: boolean) {
  if (move) ctx.moveTo(pts[0].x, pts[0].y);
  else ctx.lineTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length - 1; i++) {
    ctx.quadraticCurveTo(pts[i].x, pts[i].y, (pts[i].x + pts[i + 1].x) / 2, (pts[i].y + pts[i + 1].y) / 2);
  }
  ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
}

function strokeLine(ctx: CanvasRenderingContext2D, line: readonly Pt[], width: number, colour: string) {
  ctx.beginPath();
  smoothThrough(ctx, line, true);
  ctx.strokeStyle = colour;
  ctx.lineWidth = width;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.stroke();
}

/** Begin a path for a band hanging from `line` into the mouth (down from the
 *  upper lip, up from the lower), `height` px at its middle, tapering to the
 *  corners; returns its far edge. */
function bandFrom(ctx: CanvasRenderingContext2D, line: readonly Pt[], height: number, down: boolean): Pt[] {
  const edge: Pt[] = [];
  const far: Pt[] = [];
  const steps = 18;
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const u = along(line, t);
    edge.push({ x: u.x, y: u.y + (down ? -2 : 2) });
    far.push({ x: u.x, y: u.y + (down ? 1 : -1) * height * bump(t, 3) });
  }
  ctx.beginPath();
  smoothThrough(ctx, edge, true);
  for (let s = far.length - 1; s >= 0; s--) ctx.lineTo(far[s].x, far[s].y);
  ctx.closePath();
  return far;
}

/** Fill the current path with enamel: flat on cel art, shaded in a render and
 *  receding into the mouth's corners. */
function fillEnamel(
  ctx: CanvasRenderingContext2D,
  look: CharacterLook,
  flat: boolean,
  top: number,
  height: number,
  left: number,
  right: number
) {
  const enamel = toothColour(look);
  if (flat) {
    ctx.fillStyle = rgb(enamel);
    ctx.fill();
    return;
  }
  const g = ctx.createLinearGradient(0, top, 0, top + height);
  g.addColorStop(0, rgb(mix(enamel, look.line, 0.16)));
  g.addColorStop(0.3, rgb(enamel));
  g.addColorStop(1, rgb(mix(enamel, look.line, 0.08)));
  ctx.fillStyle = g;
  ctx.fill();
  // The teeth recede into the mouth towards its corners.
  const dark = mix(look.line, look.lip, 0.15);
  const fade = ctx.createLinearGradient(left, 0, right, 0);
  fade.addColorStop(0, rgb(dark, 0.9));
  fade.addColorStop(0.2, rgb(dark, 0.45));
  fade.addColorStop(0.38, rgb(dark, 0));
  fade.addColorStop(0.62, rgb(dark, 0));
  fade.addColorStop(0.8, rgb(dark, 0.45));
  fade.addColorStop(1, rgb(dark, 0.9));
  ctx.fillStyle = fade;
  ctx.fill();
}

/** The shaded cavity's colour at `k` times the lip's (the profile's
 *  cavityShade), a little less green and blue than the lip. */
export const cavityShade = (look: CharacterLook, k: number): Rgb => [
  look.lip[0] * k,
  look.lip[1] * k * 0.86,
  look.lip[2] * k * 0.86,
];

/**
 * How far a shaded mouth's tongue rises off the floor of the mouth, 0..1,
 * from its eased raise (TONGUE_RAISE): nothing for a vowel or a resting
 * mouth, where it lies low behind the lower lip, and up for /th/, /d/ /t/
 * and /n/ /l/, whose tip touches the teeth or the ridge behind them.
 */
export function tongueLift(raise: number): number {
  return smooth((raise - 0.4) / 0.45);
}

/** How far a shaded tongue's top stands above the lower lip's middle, px,
 *  in an opening `here` px tall there: an eighth of it at rest, the floor
 *  of the mouth; most of it lifted, up to the upper teeth. `amount` fades
 *  it in as the mouth opens. */
export const shadedTongueTop = (here: number, raise: number, amount: number): number =>
  here * (0.12 + 0.5 * tongueLift(raise)) * amount;

/** A shaded tongue's colour: its red half in the mouth's shade and a little
 *  dulled, so it is darker and duller than the lip it lies behind; it comes
 *  forward into the light as it rises. `cavity` is the mouth's middle shade. */
export function shadedTongueColour(look: CharacterLook, lift: number, cavity: Rgb): Rgb {
  const t = mix(tongueColour(look), cavity, 0.5 - 0.25 * lift);
  const grey = luma(t);
  return mix(t, [grey, grey, grey], 0.2 * (1 - lift));
}

/**
 * Whether a rendered mouth's lips are of the tongue's own red, so that a
 * tongue lying along the lower lip reads as a second lip: a person's or a
 * toon's lips, red to pink whatever their depth, and not the fur or the
 * tan, brown or golden muzzle of an animal, against which a tongue is
 * plainly a tongue. Told by the lip colour's hue, in degrees from red
 * towards yellow: lips measured 6 to 10 (the two rendered people), fur 25
 * to 31 (a photographed dog, a rendered and a drawn animal). A grey lip
 * with hardly any colour counts as a lip; a black one, a muzzle's, does not.
 */
export function lipLikeTongue(lip: Rgb): boolean {
  const [r, g, b] = lip;
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b);
  if (max < 40) return false;
  if (max - min < max * 0.15) return true;
  if (max !== r) return false;
  return (60 * (g - b)) / (max - min) < 18;
}

/**
 * Cel art's tongue, and a muzzle's: a fill whose top follows the lower lip,
 * a third of the opening at rest and most of it raised, a groove down the
 * middle. Flat under the picture's own line on cel art; shaded on a render,
 * with a shine and a wet edge along its top, where the lips are fur and the
 * tongue cannot be taken for one (lipLikeTongue).
 */
function paintTongueAlongLip(
  ctx: CanvasRenderingContext2D,
  o: Opening,
  look: CharacterLook,
  raise: number,
  amount: number,
  flat: boolean
): void {
  const W = o.width;
  const bottom = Math.max(...o.lower.map((p) => p.y));
  const tops: Pt[] = [];
  const base: Pt[] = [];
  const steps = 16;
  for (let s = 0; s <= steps; s++) {
    const u = s / steps;
    const t = 0.1 + 0.8 * u;
    const lo = along(o.lower, t);
    const up = along(o.upper, t);
    const here = Math.max(0, lo.y - up.y);
    const h = here * (0.3 + 0.58 * raise) * amount * Math.pow(Math.sin(Math.PI * u), 0.85);
    tops.push({ x: lo.x, y: lo.y - h });
    base.push({ x: lo.x, y: lo.y + 3 });
  }
  // In shade the tongue sits in the dark of the mouth, so it is dimmer.
  const tc = flat ? tongueColour(look) : mix(tongueColour(look), mix(look.line, look.lip, 0.2), 0.28);
  ctx.beginPath();
  smoothThrough(ctx, tops, true);
  for (let s = base.length - 1; s >= 0; s--) ctx.lineTo(base[s].x, base[s].y);
  ctx.closePath();
  if (flat) {
    ctx.fillStyle = rgb(tc);
  } else {
    const g = ctx.createLinearGradient(0, bottom - o.gap * 0.75, 0, bottom + 2);
    g.addColorStop(0, rgb(mix(tc, [255, 200, 190], 0.16)));
    g.addColorStop(0.5, rgb(tc));
    g.addColorStop(1, rgb(mix(tc, look.line, 0.45)));
    ctx.fillStyle = g;
  }
  ctx.fill();
  // The groove down the middle and the wet shine, sized to the tongue that
  // is there: its own height at the middle and its own width.
  const mid = along(tops, 0.5);
  const floor = along(o.lower, 0.5).y;
  const rise = Math.max(0, floor - mid.y);
  const span = Math.abs(tops[tops.length - 1].x - tops[0].x);
  if (rise > 3) {
    const groove = Math.max(1, W * 0.011);
    ctx.beginPath();
    ctx.moveTo(mid.x, mid.y + rise * 0.04);
    ctx.quadraticCurveTo(mid.x + groove * 0.4, mid.y + rise * 0.3, mid.x, mid.y + rise * 0.62);
    ctx.strokeStyle = rgb(mix(tc, look.line, flat ? 0.45 : 0.55), flat ? 0.85 : 0.5);
    ctx.lineWidth = groove;
    ctx.lineCap = "round";
    ctx.stroke();
    if (!flat) {
      // Light beside the groove, soft and low on the tongue.
      const rx = Math.max(span * 0.14, 2),
        ry = Math.max(rise * 0.2, 1.5);
      const cx = mid.x - rx * 0.5,
        cy = mid.y + rise * 0.28;
      const shine = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
      shine.addColorStop(0, "rgba(255, 226, 220, 0.34)");
      shine.addColorStop(1, "rgba(255, 226, 220, 0)");
      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(1, ry / rx);
      ctx.fillStyle = shine;
      ctx.fillRect(-rx, -rx, rx * 2, rx * 2);
      ctx.restore();
    }
  }
  if (!flat) {
    // A wet edge along the top.
    strokeLine(ctx, tops, Math.max(1, W * 0.008), "rgba(255, 214, 206, 0.28)");
  } else {
    strokeLine(ctx, tops, Math.max(1, W * 0.012), rgb(mix(tc, look.line, 0.4), 0.85));
  }
}

/**
 * A rendered mouth's tongue where the lips are of its red: a mound low in
 * the mouth, behind the lower lip.
 *
 * It was the tongue that lies along the lip (paintTongueAlongLip): a third
 * to a half of the opening tall on every vowel, as red as the lip and
 * lighter at its top, its top a hard edge running parallel to the lip with
 * a light wet line along it, a groove down its middle. Right under the
 * teeth, between lips of the same red, that is a second lower lip
 * (2026-10-09): a lip line, a crease and a shine.
 *
 * This one is an ellipse that the opening clips: wider than it is tall, so
 * its top is a shallow arch that meets the lower lip at an angle and goes
 * behind it, never a band along it; a sliver of the opening at rest (the
 * floor of the mouth), up towards the teeth only as `tongueLift` rises; in
 * the mouth's shade, darker and duller than the lip; its top fading into
 * the dark of the mouth rather than ending in an edge. The groove and the
 * shine come with the lift, on a tongue that has come up into the light.
 */
function paintTongueBehindLip(
  ctx: CanvasRenderingContext2D,
  o: Opening,
  look: CharacterLook,
  raise: number,
  amount: number,
  feather: number,
  cavity: Rgb
): void {
  const W = o.width;
  const lift = tongueLift(raise);
  const low = along(o.lower, 0.5);
  const here = Math.max(0, low.y - along(o.upper, 0.5).y);
  const h = shadedTongueTop(here, raise, amount);
  if (h < 0.75) return;
  // The mouth's own axes: along it, corner to corner, and down the face.
  const a = o.lower[0],
    b = o.lower[o.lower.length - 1];
  const len = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y));
  let ax = (b.x - a.x) / len,
    ay = (b.y - a.y) / len;
  if (ax < 0) {
    ax = -ax;
    ay = -ay;
  }
  const nx = -ay,
    ny = ax;
  const rx = W * (0.36 - 0.08 * lift);
  const ry = Math.max(h * 1.6, rx * 0.42);
  const cx = low.x + nx * (ry - h),
    cy = low.y + ny * (ry - h);
  const tc = shadedTongueColour(look, lift, cavity);
  // The top's fade, px: most of a resting sliver, less of a raised tongue,
  // never under the picture's own softness.
  const soft = Math.min(ry * 0.6, Math.max(feather * 1.5, h * (0.55 - 0.3 * lift)));
  const edge = 1 - soft / ry;
  const lip = Math.min(edge * 0.98, Math.max(0, 1 - h / ry));
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(Math.atan2(ay, ax));
  ctx.scale(1, ry / rx);
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
  g.addColorStop(0, rgb(mix(tc, look.line, 0.3)));
  g.addColorStop(lip, rgb(mix(tc, look.line, 0.12)));
  // The fade is the tongue's own colour going clear: a darker colour in it
  // would draw a line along the top.
  g.addColorStop(edge, rgb(tc));
  g.addColorStop(edge + (1 - edge) * 0.5, rgb(tc, 0.42));
  g.addColorStop(1, rgb(tc, 0));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(0, 0, rx, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  if (lift < 0.05) return;
  // The groove and the shine of a tongue that has come up into the light.
  const top = { x: low.x - nx * h, y: low.y - ny * h };
  const groove = Math.max(1, W * 0.011);
  ctx.beginPath();
  ctx.moveTo(top.x + nx * h * 0.12, top.y + ny * h * 0.12);
  ctx.lineTo(top.x + nx * h * 0.6, top.y + ny * h * 0.6);
  ctx.strokeStyle = rgb(mix(tc, look.line, 0.55), 0.45 * lift);
  ctx.lineWidth = groove;
  ctx.lineCap = "round";
  ctx.stroke();
  const sx = Math.max(rx * 0.3, 2),
    sy = Math.max(h * 0.2, 1.5);
  const shine = ctx.createRadialGradient(0, 0, 0, 0, 0, sx);
  shine.addColorStop(0, `rgba(255, 226, 220, ${0.3 * lift})`);
  shine.addColorStop(1, "rgba(255, 226, 220, 0)");
  ctx.save();
  ctx.translate(top.x + nx * h * 0.3 - ax * sx * 0.5, top.y + ny * h * 0.3 - ay * sx * 0.5);
  ctx.rotate(Math.atan2(ay, ax));
  ctx.scale(1, sy / sx);
  ctx.fillStyle = shine;
  ctx.fillRect(-sx, -sx, sx * 2, sx * 2);
  ctx.restore();
}

export function paintCharacter(ctx: CanvasRenderingContext2D, f: CharacterFrameInput): void {
  const { opening: o, look, traits } = f;
  const W = o.width;
  const flat = look.flat;
  const open = o.gap / W;
  // The edge's feather, in px: as soft as the picture's own edges are
  // (look.soft: its sharpness as a share of the mouth's width), never
  // under the antialiasing of a hard edge.
  const feather = Math.max(1.2, look.soft * W);
  // /f/ /v/: the upper teeth rest on the lower lip, which rises and curls in.
  const tuck = traits.teeth === "upper" ? smooth((tuckAmount(f.weights) - 0.08) / 0.5) : 0;

  const top = Math.min(...o.upper.map((p) => p.y));
  const bottom = Math.max(...o.lower.map((p) => p.y));
  const left = Math.min(...o.upper.map((p) => p.x));
  const right = Math.max(...o.upper.map((p) => p.x));
  const box = (): [number, number, number, number] => [
    left - W * 0.1,
    top - W * 0.1,
    right - left + W * 0.2,
    bottom - top + W * 0.2,
  ];

  ctx.save();
  ctx.clip(f.clip);
  ctx.globalAlpha = o.alpha;

  // The cavity.
  if (flat) {
    ctx.fillStyle = rgb(mix(look.line, look.lip, 0.2));
  } else {
    const g = ctx.createLinearGradient(0, top, 0, bottom);
    const shade = (k: number) => rgb(cavityShade(look, k));
    g.addColorStop(0, shade(f.cavityShade[0]));
    g.addColorStop(0.55, shade(f.cavityShade[1]));
    g.addColorStop(1, shade(f.cavityShade[2]));
    ctx.fillStyle = g;
  }
  ctx.fillRect(...box());
  if (!flat) {
    // Warmth where the mouth runs back to the throat, and darker gum at the
    // corners, so the opening is a space and not a cut-out shape.
    const cx = (left + right) / 2;
    const warm = ctx.createRadialGradient(cx, bottom - o.gap * 0.2, 1, cx, bottom - o.gap * 0.2, Math.max(W * 0.34, 4));
    warm.addColorStop(0, rgb(mix(look.lip, [170, 60, 60], 0.6), 0.2));
    warm.addColorStop(1, rgb(look.lip, 0));
    ctx.fillStyle = warm;
    ctx.fillRect(...box());
    const gum = mix(look.line, look.lip, 0.35);
    const ends = ctx.createLinearGradient(left, 0, right, 0);
    ends.addColorStop(0, rgb(gum, 0.7));
    ends.addColorStop(0.16, rgb(gum, 0.28));
    ends.addColorStop(0.3, rgb(gum, 0));
    ends.addColorStop(0.7, rgb(gum, 0));
    ends.addColorStop(0.84, rgb(gum, 0.28));
    ends.addColorStop(1, rgb(gum, 0.7));
    ctx.fillStyle = ends;
    ctx.fillRect(...box());
  }

  // The tongue, under the teeth: low for a vowel, up against the teeth for
  // /th/ and /d/. Between rendered lips of its own red it lies behind the
  // lower lip, or it is a second one.
  if (traits.tongue && open > 0.06 && tuck < 0.5) {
    const amount = smooth((open - 0.06) / 0.1);
    ctx.globalAlpha = o.alpha * (1 - tuck * 2);
    if (flat || !lipLikeTongue(look.lip)) paintTongueAlongLip(ctx, o, look, f.tongueRaise, amount, flat);
    else paintTongueBehindLip(ctx, o, look, f.tongueRaise, amount, feather, cavityShade(look, f.cavityShade[1]));
    ctx.globalAlpha = o.alpha;
  }

  // The upper teeth: a band hanging from the lip.
  const shown = teethShown(open, f.weights, traits);
  const th = teethHeight(o.gap, W, shown);
  if (shown > 0.04 && th > 1 && tuck < 0.9) {
    ctx.globalAlpha = o.alpha * Math.min(1, shown * 1.8);
    bandFrom(ctx, o.upper, th, true);
    fillEnamel(ctx, look, flat, top, th * 1.1, left, right);
    ctx.globalAlpha = o.alpha;
  }

  // /f/ /v/: the whole opening is the upper teeth, resting on a lower lip that
  // has risen and curled in, its own colour a little lighter where it turns
  // over. Faded in with the sound, so there is no step as the mouth comes to it.
  if (tuck > 0.02) {
    ctx.globalAlpha = o.alpha * tuck;
    ctx.beginPath();
    ctx.rect(...box());
    fillEnamel(ctx, look, flat, top, Math.max(o.gap, 2), left, right);
    const roll = Math.max(1.5, o.gap * 0.5);
    const far = bandFrom(ctx, o.lower, roll, false);
    if (flat) {
      ctx.fillStyle = rgb(look.lip);
      ctx.fill();
      strokeLine(ctx, far, Math.max(1, W * 0.011), rgb(mix(look.line, look.lip, 0.15), 0.9));
    } else {
      const g = ctx.createLinearGradient(0, bottom - roll, 0, bottom + 1);
      g.addColorStop(0, rgb(mix(look.lip, look.line, 0.3), 0));
      g.addColorStop(0.3, rgb(mix(look.lip, look.line, 0.3), 0.75));
      g.addColorStop(0.7, rgb(mix(look.lip, [255, 244, 240], 0.14), 0.95));
      g.addColorStop(1, rgb(look.lip, 1));
      ctx.fillStyle = g;
      ctx.fill();
    }
    ctx.globalAlpha = o.alpha;
  }

  // The inner lip shades a soft mouth; cel art has its line, below.
  if (!flat) {
    strokeLine(ctx, o.upper, Math.max(1.5, o.gap * 0.32), "rgba(20, 6, 6, 0.3)");
    strokeLine(ctx, o.upper, Math.max(1, o.gap * 0.12), "rgba(14, 4, 4, 0.38)");
    // The lower lip's shadow on the floor of the mouth: deepest at the lip,
    // gone a little way in, with no edge of its own. It was one crisp stroke
    // along a smoothed copy of the lip, which cuts the lip's curve, so its
    // inner edge lay a few px inside the opening: a dark line along the
    // lower lip, a second lip edge (2026-10-09).
    if (tuck < 0.6) {
      const reach = Math.max(feather * 2, o.gap * 0.1);
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.strokeStyle = "rgba(30, 10, 10, 0.06)";
      for (let k = 1; k <= 5; k++) {
        ctx.lineWidth = (2 * reach * k) / 5;
        ctx.stroke(f.lowerEdge);
      }
    }
    // The opening's edge is as soft as the picture's own: a ring of the inner
    // lip's tone fading inwards, so the cavity does not end in a cut.
    const inner = mix(look.line, look.lip, 0.45);
    ctx.lineJoin = "round";
    for (const [k, a] of [
      [6, 0.14],
      [3.4, 0.2],
      [1.6, 0.28],
    ] as const) {
      ctx.strokeStyle = rgb(inner, a);
      ctx.lineWidth = feather * k;
      ctx.stroke(f.clip);
    }
  }
  ctx.restore();

  // The rim: the picture's own line where the mouth is drawn; a soft dark
  // halo where it is rendered, spilling a little onto the lip or fur.
  ctx.save();
  ctx.globalAlpha = o.alpha;
  ctx.lineJoin = "round";
  if (flat) {
    ctx.strokeStyle = rgb(look.line);
    ctx.lineWidth = Math.max(1.4, W * 0.026 * (1 - 0.5 * tuck));
    ctx.stroke(f.clip);
  } else {
    const edge = mix(look.line, look.lip, 0.25);
    for (const [k, a] of [
      [5.5, 0.07],
      [2.8, 0.15],
      [1.3 + tuck * 0.7, 0.3 + tuck * 0.25],
    ] as const) {
      ctx.strokeStyle = rgb(edge, a);
      ctx.lineWidth = Math.max(1, feather * k);
      ctx.stroke(f.clip);
    }
  }
  ctx.restore();
}
