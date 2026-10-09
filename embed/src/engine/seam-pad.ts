import type { Point as Pt } from "./geometry";

/**
 * Grow a warped triangle so that it overlaps its neighbours and no seam
 * shows between them.
 *
 * Where two triangles meet, their anti-aliased edges each cover half a
 * pixel, and what is underneath — the still picture, with the chin's old
 * outline — shows through as a faint wire. A fixed overlap closes the
 * seam. It used to be made by pushing each corner away from the centroid,
 * which works for a plump triangle and fails for a sliver: there the
 * centroid lies almost on the long edges, so the corners slide along them
 * and the edges themselves hardly move. The stretched triangles under a
 * moving chin are slivers, and on flat art their seams showed as a row of
 * dots along the jaw line. This offsets every EDGE outward by `pad` px
 * (a mitre at the corners, cut short on a very sharp one so a sliver does
 * not grow a spike), after the small proportional growth that hides
 * sub-pixel gaps on every triangle.
 *
 * `edges`, when given, pads each edge (d0-d1, d1-d2, d2-d0) by its own
 * amount instead: an edge on the mesh's outer boundary has no neighbour
 * to overlap, and a pad there only paints the triangle a pixel past the
 * picture it should meet (MeshWarp.trianglePads).
 *
 * Into `out` when given (it may hold the corners themselves, in their
 * order), else three new points.
 */
export function padTriangle(
  d0: Pt,
  d1: Pt,
  d2: Pt,
  pad: number,
  scale = 0.015,
  edges?: readonly [number, number, number],
  out?: [Pt, Pt, Pt]
): [Pt, Pt, Pt] {
  const r =
    out ??
    ([
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 0, y: 0 },
    ] as [Pt, Pt, Pt]);
  const cx = (d0.x + d1.x + d2.x) / 3,
    cy = (d0.y + d1.y + d2.y) / 3;
  const n = normals;
  // Outward unit normal of each edge k, from corner k to corner k+1 (in
  // the loop, not a helper: V8 boxes a number handed to a call it does not
  // inline, and the 2D warp pads every triangle of every frame).
  for (let k = 0; (pad || edges) && k < 3; k++) {
    const a = k ? (k > 1 ? d2 : d1) : d0,
      b = k ? (k > 1 ? d0 : d2) : d1;
    let nx = -(b.y - a.y),
      ny = b.x - a.x;
    const len = Math.hypot(nx, ny) || 1;
    nx /= len;
    ny /= len;
    if (nx * ((a.x + b.x) / 2 - cx) + ny * ((a.y + b.y) / 2 - cy) < 0) {
      nx = -nx;
      ny = -ny;
    }
    n[2 * k] = nx;
    n[2 * k + 1] = ny;
  }
  for (let k = 0; k < 3; k++) {
    const d = k ? (k > 1 ? d2 : d1) : d0;
    // The small proportional growth, every triangle.
    const gx = d.x + (d.x - cx) * scale,
      gy = d.y + (d.y - cy) * scale;
    if (!pad && !edges) {
      r[k].x = gx;
      r[k].y = gy;
      continue;
    }
    const j = (k + 2) % 3;
    const ax = n[2 * k],
      ay = n[2 * k + 1],
      bx = n[2 * j],
      by = n[2 * j + 1];
    let mx: number, my: number, most: number;
    if (edges) {
      // The corner where edge k (offset by edges[k]) meets edge k-1: the
      // point that lies that far out from each.
      const pa = edges[k],
        pb = edges[j];
      const det = ax * by - ay * bx;
      if (Math.abs(det) < 1e-3) {
        mx = ((ax + bx) / 2) * Math.max(pa, pb);
        my = ((ay + by) / 2) * Math.max(pa, pb);
      } else {
        mx = (pa * by - ay * pb) / det;
        my = (ax * pb - pa * bx) / det;
      }
      most = MITRE_LIMIT * Math.max(pa, pb);
    } else {
      // The corner between edge k (leaving it) and edge k-1 (arriving).
      const denom = Math.max(1e-3, 1 + ax * bx + ay * by);
      mx = (ax + bx) / denom;
      my = (ay + by) / denom;
      most = MITRE_LIMIT;
    }
    // The mitre cut short at `most`. Math.hypot makes an array for every
    // call in V8, and only a mitre near its limit can be cut: one whose
    // square is under the limit's by more than a hair (1e-6) is shorter by
    // far more than either measure's rounding, so it is left as measuring
    // it leaves it, to the bit (as head-fold.ts `longest` does).
    if (!(mx * mx + my * my <= most * most * (1 - 1e-6))) {
      const len = Math.hypot(mx, my);
      if (len > most) {
        mx *= most / len;
        my *= most / len;
      }
    }
    if (!edges) {
      mx *= pad;
      my *= pad;
    }
    r[k].x = gx + mx;
    r[k].y = gy + my;
  }
  return r;
}

/** The edges' outward normals of the triangle being padded, x y pairs. */
const normals = new Float64Array(6);

/** A corner grows at most this many pads: a sharp sliver's mitre would
 *  otherwise run on as a spike, for no seam. */
export const MITRE_LIMIT = 3;
