/**
 * How far a brow may move on one face before it presses or stretches the
 * mesh round it too far (docs/emotions.md, "The brows"): for each landmark
 * a brow moves, the most it may lift, lower and be drawn toward the
 * midline (a knit), read once from the rest mesh.
 *
 * A brow's move is a fixed field times an amount (a rise moves each
 * landmark straight up by its weight times the brow-to-lid distance there;
 * a knit moves it toward the midline by its weight), so every triangle's
 * area is linear in the amount, and the amount at which it loses PRESS of
 * itself, or grows by STRETCH of itself, is one division. The
 * forehead between a brow's tail and the temple's skin, which the outline
 * holds, is where a lift folded the mesh; the glabella where a knit
 * crushed it; the lid's fold under a high brow on a low-browed face where
 * a lift stretched its lashes' shadow into a smear and its pale skin into
 * a patch. A landmark takes the least amount of the triangles it is a
 * corner of, and the caps are then smoothed along the brow (CAP_SLOPE), so
 * its shape along it stays smooth and its hair moves together.
 */
import type { Point } from "./geometry";

/** The share of a triangle's area a brow's rise may press out of it, and
 *  a knit (the two can act on one triangle at once: together they leave
 *  it at least a quarter of itself, and the fold check's floor is a
 *  fifth); how much a rise may stretch it by; and how much the caps along
 *  a brow change, at most, from its inner end to its outer (IODs). */
const PRESS = { rise: 0.55, knit: 0.2, most: 0.7 } as const;
const STRETCH = 0.6;
const CAP_SLOPE = 0.05;

/** One brow's moved landmarks: their indices, where along the brow (0
 *  inner .. 1 outer), their weights, the brow-to-lid distance there (IODs),
 *  and which brow (0 the picture's left). */
export interface StripLandmarks {
  readonly index: readonly number[];
  readonly share: readonly number[];
  readonly weight: readonly number[];
  readonly unit: readonly number[];
  readonly side: 0 | 1;
}

/** Each landmark's caps, IODs before its weight: the most it lifts, lowers
 *  and is drawn in. */
export interface BrowCaps {
  readonly up: readonly number[];
  readonly down: readonly number[];
  readonly inward: readonly number[];
}

/**
 * The caps of both brows' `strips` on the face whose rest landmarks are
 * `local` (face frame, IODs) and whose mesh is `triangles`. Both brows
 * move together (a landmark between them is moved by both), so a
 * triangle's limit is read for their summed move.
 */
export function browCaps(
  local: readonly Point[],
  triangles: readonly (readonly [number, number, number])[],
  strips: readonly StripLandmarks[],
  slack = 1
): BrowCaps[] {
  // A rise of one unit moves a landmark up (y falls) by weight × unit; a
  // knit of one IOD moves it toward the midline by its weight.
  const rise = new Map<number, number>(),
    knit = new Map<number, number>();
  for (const s of strips)
    s.index.forEach((i, k) => {
      rise.set(i, (rise.get(i) ?? 0) + s.weight[k] * s.unit[k]);
      knit.set(i, (knit.get(i) ?? 0) + (s.side ? -1 : 1) * s.weight[k]);
    });
  const room = { press: Math.min(PRESS.most, PRESS.rise * slack), stretch: STRETCH * slack };
  const [up, down] = limits(local, triangles, (i) => ({ x: 0, y: -(rise.get(i) ?? 0) }), rise, room);
  const [inward] = limits(local, triangles, (i) => ({ x: knit.get(i) ?? 0, y: 0 }), knit, {
    press: PRESS.knit,
    stretch: STRETCH,
  });
  return strips.map((s) => {
    // Per landmark, in IODs before its weight (a rise's in units × unit).
    const spread = (caps: ReadonlyMap<number, number>, scale: (k: number) => number) => {
      const own = s.index.map((i, k) => (caps.get(i) ?? Infinity) * scale(k));
      return own.map((_, k) => {
        let m = Infinity;
        for (let j = 0; j < own.length; j++) m = Math.min(m, own[j] + CAP_SLOPE * Math.abs(s.share[j] - s.share[k]));
        return m;
      });
    };
    return {
      up: spread(up, (k) => s.unit[k]),
      down: spread(down, (k) => s.unit[k]),
      inward: spread(inward, () => 1),
    };
  });
}

/**
 * For a move `field` (each landmark's displacement per unit of the move;
 * `moved` the landmarks it moves), the most each moved landmark's
 * triangles allow the move, forward and back: pressing at most
 * `room.press` of a triangle's area out of it, stretching it by at most
 * `room.stretch` of it.
 */
function limits(
  local: readonly Point[],
  triangles: readonly (readonly [number, number, number])[],
  field: (i: number) => Point,
  moved: ReadonlyMap<number, number>,
  room: { readonly press: number; readonly stretch: number }
): [Map<number, number>, Map<number, number>] {
  const forth = new Map<number, number>(),
    back = new Map<number, number>();
  for (const [a, b, c] of triangles) {
    if (!moved.has(a) && !moved.has(b) && !moved.has(c)) continue;
    const [A, B, C] = [local[a], local[b], local[c]];
    const [dA, dB, dC] = [field(a), field(b), field(c)];
    const area = (B.x - A.x) * (C.y - A.y) - (C.x - A.x) * (B.y - A.y);
    // d(area)/d(amount).
    const slope =
      (dB.x - dA.x) * (C.y - A.y) +
      (B.x - A.x) * (dC.y - dA.y) -
      (dC.x - dA.x) * (B.y - A.y) -
      (C.x - A.x) * (dB.y - dA.y);
    if (!(Math.abs(slope) > 1e-12) || !(Math.abs(area) > 1e-9)) continue;
    // Pressed (the area falls) one way, stretched the other.
    const press = (room.press * Math.abs(area)) / Math.abs(slope);
    const pull = (room.stretch * Math.abs(area)) / Math.abs(slope);
    const [ahead, behind] = area * slope < 0 ? [press, pull] : [pull, press];
    for (const i of [a, b, c]) {
      if (!moved.has(i)) continue;
      forth.set(i, Math.min(forth.get(i) ?? Infinity, ahead));
      back.set(i, Math.min(back.get(i) ?? Infinity, behind));
    }
  }
  return [forth, back];
}
