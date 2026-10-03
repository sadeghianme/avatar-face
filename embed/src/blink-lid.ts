import { mix, rgb, type Pt, type Rgb } from "./character-mouth";

/**
 * The lid blink: a lid painted over the eye.
 *
 * The mesh blink moves the photographed lid down, which on a photograph of a
 * person is a few pixels of narrowing, and on a drawn or rendered eye pinches
 * the iris into a diamond or does not read at all. Characters blink with a
 * lid that comes down over the eye; so this paints one, from the colour of
 * the skin beside the eye, with the lash line riding its edge, clipped to the
 * eye's own opening so it cannot spill. The mesh stays still meanwhile.
 */

export interface EyeShape {
  /** The upper lid's points, corner to corner, image left to right. */
  upper: readonly Pt[];
  /** The lower lid's points, corner to corner. */
  lower: readonly Pt[];
}

/** Where to read a lid's colour: a little above the upper lid and below the
 *  lower lid, in the same points the lids are given in. */
export function lidSamplePoints(upper: readonly Pt[], lower: readonly Pt[]): Pt[] {
  const top = Math.min(...upper.map((p) => p.y));
  const bottom = Math.max(...lower.map((p) => p.y));
  const h = Math.max(bottom - top, 2);
  const out: Pt[] = [];
  for (const p of upper.slice(1, -1)) out.push({ x: p.x, y: p.y - h * 0.55 });
  for (const p of lower.slice(1, -1)) out.push({ x: p.x, y: p.y + h * 0.7 });
  return out;
}

/** The colour of the samples that exist at the given brightness percentile:
 *  the lid is skin in light, and the samples round an eye include its shadow
 *  and lashes, so the lighter end is the better guess. */
export function medianColour(samples: readonly (Rgb | null)[], percentile = 0.5): Rgb | null {
  const got = samples
    .filter((s): s is Rgb => !!s)
    .sort((a, b) => a[0] + a[1] + a[2] - (b[0] + b[1] + b[2]));
  if (!got.length) return null;
  return got[Math.min(got.length - 1, Math.floor(got.length * percentile))];
}

/** How far down the lid is, 0 (open) to 1 (shut), for an eased blink. */
export const lidAmount = (eased: number) => Math.max(0, Math.min(1, eased * 1.08));

function through(ctx: CanvasRenderingContext2D, pts: readonly Pt[], move: boolean) {
  if (move) ctx.moveTo(pts[0].x, pts[0].y);
  else ctx.lineTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length - 1; i++) {
    ctx.quadraticCurveTo(pts[i].x, pts[i].y, (pts[i].x + pts[i + 1].x) / 2, (pts[i].y + pts[i + 1].y) / 2);
  }
  ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
}

/** The lid's leading edge: from the upper lid towards the lower one at the
 *  same x, bowed down in the middle as a closing lid is. */
export function lidEdge(eye: EyeShape, amount: number): Pt[] {
  const { upper, lower } = eye;
  const width = Math.hypot(upper[upper.length - 1].x - upper[0].x, upper[upper.length - 1].y - upper[0].y);
  const lowerAt = (x: number): number => {
    for (let i = 0; i < lower.length - 1; i++) {
      if (x <= lower[i + 1].x || i === lower.length - 2) {
        const span = Math.max(lower[i + 1].x - lower[i].x, 1e-6);
        const k = Math.max(0, Math.min(1, (x - lower[i].x) / span));
        return lower[i].y + (lower[i + 1].y - lower[i].y) * k;
      }
    }
    return lower[0].y;
  };
  const raw = upper.map((p, i) => {
    const t = amount * (0.85 + 0.15 * Math.sin((Math.PI * i) / (upper.length - 1)));
    // Shut, the lid lands a little below the lower lid's marks: a marked
    // eye is never quite the whole of the drawn one.
    const target = lowerAt(p.x) + width * 0.03 * amount;
    return { x: p.x, y: p.y + (target - p.y) * Math.min(1, t) };
  });
  // The lids' landmarks are noisy; a closing lid is a smooth curve.
  return raw.map((p, i) => {
    const a = raw[Math.max(0, i - 1)], b = raw[Math.min(raw.length - 1, i + 1)];
    return { x: p.x, y: (a.y + 2 * p.y + b.y) / 4 };
  });
}

/**
 * Paint the lid. `amount` is how far it has come down; `skin` the colour it
 * is made of; `line` the lash colour, and `flat` whether the picture is cel
 * art (a crisp lid and a drawn lash) or shaded (a soft fold).
 */
export function paintLid(
  ctx: CanvasRenderingContext2D,
  eye: EyeShape,
  amount: number,
  skin: Rgb,
  line: Rgb,
  flat: boolean
): void {
  if (amount < 0.04) return;
  const { upper, lower } = eye;
  const w = Math.hypot(upper[upper.length - 1].x - upper[0].x, upper[upper.length - 1].y - upper[0].y);
  if (w < 3) return;
  const edge = lidEdge(eye, amount);

  // In shade the lid's rim is not a cut edge: a soft halo of its own colour
  // spills a little past the eye, so it settles into the fur or skin round it.
  if (!flat) {
    ctx.save();
    ctx.beginPath();
    through(ctx, upper.map((p) => ({ x: p.x, y: p.y - w * 0.08 })), true);
    through(ctx, lower.slice().reverse().map((p) => ({ x: p.x, y: p.y + w * 0.1 })), false);
    ctx.closePath();
    ctx.lineJoin = "round";
    ctx.strokeStyle = rgb(skin, 0.28 * amount);
    ctx.lineWidth = w * 0.16;
    ctx.stroke();
    ctx.strokeStyle = rgb(skin, 0.4 * amount);
    ctx.lineWidth = w * 0.07;
    ctx.stroke();
    ctx.restore();
  }

  ctx.save();
  // The eye's opening, slightly grown so no sliver of eyeball survives.
  ctx.beginPath();
  through(ctx, upper.map((p) => ({ x: p.x, y: p.y - w * 0.08 })), true);
  through(ctx, lower.slice().reverse().map((p) => ({ x: p.x, y: p.y + w * 0.1 })), false);
  ctx.closePath();
  ctx.clip();
  // Skin from above the eye down to the leading edge.
  ctx.beginPath();
  ctx.moveTo(upper[0].x - w * 0.2, upper[0].y - w * 0.5);
  ctx.lineTo(upper[upper.length - 1].x + w * 0.2, upper[upper.length - 1].y - w * 0.5);
  ctx.lineTo(edge[edge.length - 1].x + w * 0.2, edge[edge.length - 1].y);
  through(ctx, edge.slice().reverse(), false);
  ctx.closePath();
  if (flat) {
    ctx.fillStyle = rgb(skin);
  } else {
    const mid = Math.floor(upper.length / 2);
    const g = ctx.createLinearGradient(0, upper[mid].y, 0, edge[mid].y + 1);
    g.addColorStop(0, rgb(skin));
    g.addColorStop(0.75, rgb(skin));
    g.addColorStop(1, rgb(mix(skin, line, 0.28)));
    ctx.fillStyle = g;
  }
  ctx.fill();
  ctx.restore();

  // The lash line, along the edge, once the lid is mostly down.
  const lash = Math.min(1, (amount - 0.25) / 0.5);
  if (lash > 0.02) {
    ctx.save();
    ctx.globalAlpha = lash * (flat ? 1 : 0.8);
    ctx.beginPath();
    through(ctx, edge, true);
    ctx.strokeStyle = rgb(line);
    ctx.lineWidth = Math.max(1.2, w * (flat ? 0.05 : 0.035));
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke();
    ctx.restore();
  }
}
