import type { Pt } from "./jaw-rig";

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
 */
export function padTriangle(d0: Pt, d1: Pt, d2: Pt, pad: number, scale = 0.015): [Pt, Pt, Pt] {
  const cx = (d0.x + d1.x + d2.x) / 3, cy = (d0.y + d1.y + d2.y) / 3;
  const v = [d0, d1, d2];
  const grown = v.map((p) => ({ x: p.x + (p.x - cx) * scale, y: p.y + (p.y - cy) * scale }));
  if (!pad) return grown as [Pt, Pt, Pt];
  // Outward unit normal of each edge k, from v[k] to v[k+1].
  const normals = [0, 1, 2].map((k) => {
    const a = v[k], b = v[(k + 1) % 3];
    let nx = -(b.y - a.y), ny = b.x - a.x;
    const len = Math.hypot(nx, ny) || 1;
    nx /= len; ny /= len;
    if (nx * ((a.x + b.x) / 2 - cx) + ny * ((a.y + b.y) / 2 - cy) < 0) { nx = -nx; ny = -ny; }
    return [nx, ny];
  });
  return [0, 1, 2].map((k) => {
    // The corner between edge k (leaving it) and edge k-1 (arriving).
    const [ax, ay] = normals[k], [bx, by] = normals[(k + 2) % 3];
    const denom = Math.max(1e-3, 1 + ax * bx + ay * by);
    let mx = (ax + bx) / denom, my = (ay + by) / denom;
    const len = Math.hypot(mx, my);
    if (len > MITRE_LIMIT) { mx *= MITRE_LIMIT / len; my *= MITRE_LIMIT / len; }
    return { x: grown[k].x + mx * pad, y: grown[k].y + my * pad };
  }) as [Pt, Pt, Pt];
}

/** A corner grows at most this many pads: a sharp sliver's mitre would
 *  otherwise run on as a spike, for no seam. */
export const MITRE_LIMIT = 3;
