import { mix, rgb, type Pt, type Rgb } from "./character-mouth";

/**
 * The lid blink: a lid painted over the eye.
 *
 * The mesh blink moves the photographed lid down, which on a photograph of a
 * person is a few pixels of narrowing, and on a drawn or rendered eye pinches
 * the iris into a diamond or does not read at all. Characters blink with a
 * lid that comes down over the eye; so this paints one, with the lash line
 * riding its edge, clipped to the eye's own opening so it cannot spill. The
 * mesh stays still meanwhile.
 *
 * What it is made of: on a shaded picture, a clone of the fur or skin just
 * below the eye (so the lid has the picture's own texture, not a flat
 * patch), tinted towards the skin above so it joins the brow without a seam;
 * on cel art, a flat fill. It follows a smoothed ellipse fitted to the eye's
 * width and height, not the raw points, so loose marks do not make a ragged
 * lid or let it wander off the eye, and the eye squashes a little before the
 * lid arrives.
 */

export interface EyeShape {
  /** The upper lid's points, corner to corner, image left to right. */
  upper: readonly Pt[];
  /** The lower lid's points, corner to corner. */
  lower: readonly Pt[];
}

/** What the lid is made of: the skin above the eye and the skin below it. */
export interface LidTone {
  above: Rgb;
  below: Rgb;
}

/** A rectangle in the canvas the lid is painted in. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Copies the picture's own pixels: `src` (canvas coordinates of the face as
 *  drawn) onto `dst`. Supplied by the engine, which knows the texture. */
export type Blit = (c: CanvasRenderingContext2D, dst: Box, src: Box) => void;

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
  const got = samples.filter((s): s is Rgb => !!s).sort((a, b) => a[0] + a[1] + a[2] - (b[0] + b[1] + b[2]));
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
    const a = raw[Math.max(0, i - 1)],
      b = raw[Math.min(raw.length - 1, i + 1)];
    return { x: p.x, y: (a.y + 2 * p.y + b.y) / 4 };
  });
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const smoothStep = (x: number) => {
  const t = clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
};
const gShape = (u: number) => 1 - Math.pow(Math.abs(u), 2.1);
const taper = (t: number) => 0.3 + 0.7 * Math.pow(Math.sin(Math.PI * t), 0.6);

function median(v: number[]): number {
  const s = v.slice().sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
}

/**
 * The eye as a plausible eye: corner to corner, with each lid a smooth arch
 * whose height is the median height the marks agree on, and every mark held
 * within a third of that arch. Hand-marked points are loose by several
 * pixels, a vision model's looser still; the lid is built on this, not on
 * them.
 */
export function regularEye(eye: EyeShape, n = 11): EyeShape {
  const { upper, lower } = eye;
  const a = { x: (upper[0].x + lower[0].x) / 2, y: (upper[0].y + lower[0].y) / 2 };
  const b = {
    x: (upper[upper.length - 1].x + lower[lower.length - 1].x) / 2,
    y: (upper[upper.length - 1].y + lower[lower.length - 1].y) / 2,
  };
  const w = Math.max(Math.hypot(b.x - a.x, b.y - a.y), 1);
  const tx = (b.x - a.x) / w,
    ty = (b.y - a.y) / w;
  // Down the face for an eye read left to right.
  const nx = -ty,
    ny = tx;
  const flip = ny < 0 ? -1 : 1;
  const heights = (lid: readonly Pt[], sign: number) =>
    lid
      .map((p) => {
        const dx = p.x - a.x,
          dy = p.y - a.y;
        return {
          u: clamp(2 * ((dx * tx + dy * ty) / w) - 1, -1, 1),
          h: Math.max(0, (dx * nx + dy * ny) * flip * sign),
        };
      })
      .sort((p, q) => p.u - q.u);
  const hu = heights(upper, -1),
    hl = heights(lower, 1);
  const amp = (hs: { u: number; h: number }[], lo: number, hi: number) =>
    clamp(median(hs.filter((p) => gShape(p.u) > 0.25).map((p) => p.h / gShape(p.u))), lo * w, hi * w);
  const aU = amp(hu, 0.1, 0.55);
  const aL = amp(hl, 0.04, 0.4);
  const at = (hs: { u: number; h: number }[], u: number) => {
    for (let i = 0; i < hs.length - 1; i++) {
      if (u <= hs[i + 1].u)
        return lerp(hs[i].h, hs[i + 1].h, clamp((u - hs[i].u) / Math.max(hs[i + 1].u - hs[i].u, 1e-6), 0, 1));
    }
    return hs[hs.length - 1].h;
  };
  const build = (hs: { u: number; h: number }[], A: number, sign: number): Pt[] => {
    const out: Pt[] = [];
    for (let k = 0; k < n; k++) {
      const u = -1 + (2 * k) / (n - 1);
      const arch = A * gShape(u);
      const h = k === 0 || k === n - 1 ? 0 : lerp(arch, clamp(at(hs, u), arch * 0.67, arch * 1.33), 0.35);
      const along = ((u + 1) / 2) * w;
      out.push({ x: a.x + tx * along + nx * flip * h * sign, y: a.y + ty * along + ny * flip * h * sign });
    }
    return out;
  };
  return { upper: build(hu, aU, -1), lower: build(hl, aL, 1) };
}

/**
 * How far the eye really reaches, read off the picture: from the middle of the
 * eye outwards along `rays` directions until the colour has been the skin's for
 * a few pixels. The eye's marks are loose, and an AI-made eye is often larger
 * than they say (the white runs to the corners, a drawn outline is thick), so
 * a lid cut to the marks leaves slivers; a lid cut to this does not. Every
 * ray is held between the marked ellipse's own radius and half as much again,
 * so a shadow, a brow or a crease that touches the eye cannot swell it.
 * `pixel` and the result are in the same (texture) pixels as `eye`.
 */
export function eyeExtent(pixel: (x: number, y: number) => Rgb | null, eye: EyeShape, tolerance = 50, rays = 16): Pt[] {
  const all = [...eye.upper, ...eye.lower];
  const minY = Math.min(...all.map((p) => p.y)),
    maxY = Math.max(...all.map((p) => p.y));
  const minX = Math.min(...all.map((p) => p.x)),
    maxX = Math.max(...all.map((p) => p.x));
  const w = Math.max(maxX - minX, 1);
  const cx = (minX + maxX) / 2,
    cy = (minY + maxY) / 2;
  const rx = w / 2,
    ry = Math.max((maxY - minY) / 2, 0.16 * w);
  const reach: number[] = [];
  const lo: number[] = [],
    hi: number[] = [];
  for (let k = 0; k < rays; k++) {
    const a = (2 * Math.PI * k) / rays;
    const dx = Math.cos(a),
      dy = Math.sin(a);
    const re = 1 / Math.sqrt((dx / rx) ** 2 + (dy / ry) ** 2);
    // The surround in this direction, read just beyond where the eye ought to
    // end: skin here, a patch of shadow or fur there. The eye reaches as far as
    // the colour differs from it.
    const ring: Rgb[] = [];
    for (const f of [1.25, 1.32, 1.4, 1.47]) {
      const c = pixel(cx + dx * re * f, cy + dy * re * f);
      if (c) ring.push(c);
    }
    const surround = medianColour(ring, 0.5);
    let last = 0,
      calm = 0;
    if (surround) {
      for (let r = 0; r <= re * 1.5; r += 1) {
        const c = pixel(cx + dx * r, cy + dy * r);
        if (!c) break;
        const d = Math.hypot(c[0] - surround[0], c[1] - surround[1], c[2] - surround[2]);
        if (d > tolerance) {
          last = r;
          calm = 0;
        } else if (++calm >= 4 && r > re * 0.6) break;
      }
    }
    lo.push(re * 0.95);
    hi.push(re * 1.45);
    reach.push(clamp(last + 1.5, lo[k], hi[k]));
  }
  for (let pass = 0; pass < 2; pass++) {
    const c = reach.slice();
    for (let k = 0; k < rays; k++)
      reach[k] = clamp((c[(k + rays - 1) % rays] + 2 * c[k] + c[(k + 1) % rays]) / 4, lo[k], hi[k]);
  }
  return reach.map((r, k) => {
    const a = (2 * Math.PI * k) / rays;
    return { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r };
  });
}

let scratchPair: { body: HTMLCanvasElement; mask: HTMLCanvasElement } | null | undefined;

/** Two small canvases for painting a lid apart, made once; none where there is
 *  no document to make them in. */
function scratchCanvases(): { body: HTMLCanvasElement; mask: HTMLCanvasElement } | null {
  if (scratchPair !== undefined) return scratchPair;
  try {
    const body = document.createElement("canvas");
    const mask = document.createElement("canvas");
    scratchPair = body.getContext("2d") && mask.getContext("2d") ? { body, mask } : null;
  } catch {
    scratchPair = null;
  }
  return scratchPair;
}

/** A smooth closed path through `pts`. */
function closed(ctx: CanvasRenderingContext2D, pts: readonly Pt[]) {
  const n = pts.length;
  ctx.moveTo((pts[0].x + pts[n - 1].x) / 2, (pts[0].y + pts[n - 1].y) / 2);
  for (let i = 0; i < n; i++) {
    const a = pts[i],
      b = pts[(i + 1) % n];
    ctx.quadraticCurveTo(a.x, a.y, (a.x + b.x) / 2, (a.y + b.y) / 2);
  }
  ctx.closePath();
}

/**
 * Paint the lid. `amount` is how far it has come down, `tone` the skin it is
 * made of, `line` the lash colour, `flat` whether the picture is cel art (a
 * crisp lid of one colour and a drawn lash) or shaded (a clone of the skin
 * beside the eye, a soft crease, a tapered lash).
 */
export function paintLid(
  ctx: CanvasRenderingContext2D,
  rawEye: EyeShape,
  amount: number,
  tone: LidTone,
  line: Rgb,
  flat: boolean,
  blit?: Blit | null,
  outline?: readonly Pt[] | null
): void {
  if (amount < 0.04) return;
  const w0 = Math.hypot(
    rawEye.upper[rawEye.upper.length - 1].x - rawEye.upper[0].x,
    rawEye.upper[rawEye.upper.length - 1].y - rawEye.upper[0].y
  );
  if (w0 < 3) return;
  const eye = regularEye(rawEye);
  const { upper, lower } = eye;
  const w = Math.hypot(upper[upper.length - 1].x - upper[0].x, upper[upper.length - 1].y - upper[0].y);
  const shape = outline && outline.length >= 8 ? outline : null;
  const raw = lidEdge(eye, amount);
  // A shut eye is a gentle curve, not the lower lid's whole arch: the lash line
  // settles part of the way back to the chord between the corners.
  const settle = smoothStep((amount - 0.5) / 0.5) * 0.32;
  const c0 = raw[0],
    c1 = raw[raw.length - 1];
  const edge = raw.map((p) => ({
    x: p.x,
    y: lerp(p.y, c0.y + ((c1.y - c0.y) * (p.x - c0.x)) / Math.max(c1.x - c0.x, 1e-6), settle),
  }));
  // What the lid fills reaches the whole opening as it lands, so no sliver of
  // eye is left below a lash line that stopped short of the lower lid.
  const reach = smoothStep((amount - 0.8) / 0.2);
  const top = shape ? Math.min(...shape.map((p) => p.y)) : Math.min(...upper.map((p) => p.y)) - w * 0.1;
  const bottom = shape ? Math.max(...shape.map((p) => p.y)) : Math.max(...lower.map((p) => p.y)) + w * 0.1;
  const left = shape ? Math.min(...shape.map((p) => p.x)) : Math.min(upper[0].x, lower[0].x) - w * 0.1;
  const right = shape
    ? Math.max(...shape.map((p) => p.x))
    : Math.max(upper[upper.length - 1].x, lower[lower.length - 1].x) + w * 0.1;
  const fillEdge = edge.map((p, i) => ({
    x: p.x,
    y: lerp(p.y, shape ? bottom : lower[Math.min(i, lower.length - 1)].y + w * 0.12, reach),
  }));
  const above = tone.above;
  const mid = mix(tone.above, tone.below, 0.4);
  const span = { x: left - w * 0.3, y: top - w * 0.3, w: right - left + w * 0.6, h: bottom - top + w * 0.6 };

  const shapePath = (c: CanvasRenderingContext2D) => {
    c.beginPath();
    if (shape) {
      closed(c, shape);
    } else {
      // The eye's opening, slightly grown so no sliver of eyeball survives.
      through(
        c,
        upper.map((p) => ({ x: p.x, y: p.y - w * 0.1 })),
        true
      );
      through(
        c,
        lower
          .slice()
          .reverse()
          .map((p) => ({ x: p.x, y: p.y + w * 0.1 })),
        false
      );
      c.closePath();
    }
  };

  // What goes on the eye: the squashed eye, then the lid down to its edge.
  const body = (c: CanvasRenderingContext2D) => {
    // The eye squashes a little before the lid arrives, anchored at the lower
    // lid, so what it uncovers at the top is hidden by the lid itself.
    if (!flat && blit && amount < 0.85) {
      const s = 1 - 0.11 * smoothStep(amount / 0.45) * (1 - smoothStep((amount - 0.5) / 0.35));
      const box = { x: left, y: top, w: right - left, h: bottom - top };
      c.save();
      shapePath(c);
      c.clip();
      blit(c, { x: box.x, y: bottom - box.h * s, w: box.w, h: box.h * s }, box);
      c.restore();
    }
    // The lid: skin from above the eye down to the leading edge.
    c.save();
    c.beginPath();
    c.moveTo(upper[0].x - w * 0.2, top - w * 0.2);
    c.lineTo(upper[upper.length - 1].x + w * 0.2, top - w * 0.2);
    c.lineTo(fillEdge[fillEdge.length - 1].x + w * 0.2, fillEdge[fillEdge.length - 1].y);
    through(c, fillEdge.slice().reverse(), false);
    c.lineTo(fillEdge[0].x - w * 0.2, fillEdge[0].y);
    c.closePath();
    c.clip();
    c.fillStyle = rgb(flat ? above : mid);
    c.fillRect(span.x, span.y, span.w, span.h);
    if (!flat) {
      if (blit) {
        // Clone the skin just below the eye: its own texture over the lid.
        const shift = bottom - top + w * 0.05;
        const box = { x: left - w * 0.1, y: top, w: right - left + w * 0.2, h: bottom - top };
        blit(c, box, { ...box, y: box.y + shift });
      }
      // Join the skin above: tinted towards it at the top, so the lid has no
      // seam where it meets the brow; shaded towards the lashes at its edge.
      const g = c.createLinearGradient(0, top, 0, bottom);
      g.addColorStop(0, rgb(above, 0.4));
      g.addColorStop(0.55, rgb(above, 0.08));
      g.addColorStop(1, rgb(mix(above, line, 0.3), 0.3));
      c.fillStyle = g;
      c.fillRect(span.x, span.y, span.w, span.h);
    }
    c.restore();
  };

  const scratch = flat ? null : scratchCanvases();
  if (scratch) {
    // A shaded face has no hard edge round the eye: the lid is painted apart
    // and let in through a soft mask of the eye's reach, so where it ends it
    // fades into the fur or skin round it (the lid's own edge stays crisp).
    const f = Math.max(1.5, w * 0.06);
    const pad = Math.ceil(f * 3) + 2;
    const bx = Math.floor(left - pad),
      by = Math.floor(top - pad);
    const bw = Math.ceil(right - left + pad * 2) + 1,
      bh = Math.ceil(bottom - top + pad * 2) + 1;
    const big = bw + 4000;
    scratch.mask.width = bw;
    scratch.mask.height = bh;
    scratch.body.width = bw;
    scratch.body.height = bh;
    const mc = scratch.mask.getContext("2d")!;
    mc.shadowColor = "#000";
    mc.shadowBlur = f * 2;
    mc.shadowOffsetX = big;
    mc.fillStyle = "#000";
    mc.translate(-bx - big, -by);
    if (shape) {
      // The fade starts outside the eye's reach, not on it: otherwise the rim
      // of the eye's own white shows through the soft edge as a ring.
      const mx = (left + right) / 2,
        my = (top + bottom) / 2;
      mc.beginPath();
      closed(
        mc,
        shape.map((p) => {
          const d = Math.hypot(p.x - mx, p.y - my) || 1;
          return { x: p.x + ((p.x - mx) / d) * f * 1.2, y: p.y + ((p.y - my) / d) * f * 1.2 };
        })
      );
    } else {
      shapePath(mc);
    }
    mc.fill();
    const bc = scratch.body.getContext("2d")!;
    bc.translate(-bx, -by);
    body(bc);
    bc.setTransform(1, 0, 0, 1, 0, 0);
    bc.globalCompositeOperation = "destination-in";
    bc.drawImage(scratch.mask, 0, 0);
    ctx.drawImage(scratch.body, bx, by);
  } else {
    ctx.save();
    shapePath(ctx);
    ctx.clip();
    body(ctx);
    ctx.restore();
  }

  // The crease under the brow: a soft shadow along the top of the lid.
  if (!flat) {
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const crease = upper.map((p) => ({ x: p.x, y: p.y - w * 0.035 }));
    for (const [k, a] of [
      [0.06, 0.025],
      [0.03, 0.045],
      [0.014, 0.07],
    ] as const) {
      ctx.beginPath();
      through(ctx, crease, true);
      ctx.strokeStyle = rgb(mix(above, line, 0.5), a * amount);
      ctx.lineWidth = w * k;
      ctx.stroke();
    }
    ctx.restore();
  }

  // The lash line, along the edge once the lid is mostly down: a band that
  // thins to nothing at the corners.
  const lash = Math.min(1, (amount - 0.2) / 0.5);
  if (lash > 0.02) {
    const thick = Math.max(1.3, w * (flat ? 0.05 : 0.036));
    const n = edge.length;
    const topEdge = edge.map((p, i) => ({ x: p.x, y: p.y - (thick * taper(i / (n - 1))) / 2 }));
    const botEdge = edge.map((p, i) => ({ x: p.x, y: p.y + (thick * taper(i / (n - 1))) / 2 }));
    ctx.save();
    ctx.globalAlpha = lash * (flat ? 1 : 0.85);
    ctx.beginPath();
    through(ctx, topEdge, true);
    ctx.lineTo(botEdge[n - 1].x, botEdge[n - 1].y);
    through(ctx, botEdge.slice().reverse(), false);
    ctx.closePath();
    ctx.fillStyle = rgb(line);
    ctx.fill();
    ctx.restore();
  }
}
