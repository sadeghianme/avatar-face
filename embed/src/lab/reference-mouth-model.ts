import type { MouthPose, MouthPoint } from "../mouth-extension";
import { ZERO_WEIGHTS, type BlendWeights } from "../types";

export interface ReferenceProfile {
  teethScale: number;
  teethY: number;
  warmth: number;
  lipProjection: number;
  jawRange: number;
}

export const DEFAULT_REFERENCE_PROFILE: ReferenceProfile = {
  teethScale: 1, teethY: 0, warmth: 0.5, lipProjection: 0.55, jawRange: 0.85,
};
export const PROFILE_LIMITS: Record<keyof ReferenceProfile, readonly [number, number, number]> = {
  teethScale: [0.75, 1.2, 0.01], teethY: [-0.06, 0.06, 0.002], warmth: [0, 1, 0.05],
  lipProjection: [0, 1, 0.05], jawRange: [0.6, 1.1, 0.01],
};

/** Persisted drafts are untrusted and may belong to an older version. */
export function normalizeProfile(value: unknown): ReferenceProfile {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const out = { ...DEFAULT_REFERENCE_PROFILE };
  for (const key of Object.keys(out) as (keyof ReferenceProfile)[]) {
    const n = source[key];
    const [min, max] = PROFILE_LIMITS[key];
    if (typeof n === "number" && Number.isFinite(n)) out[key] = Math.max(min, Math.min(max, n));
  }
  return out;
}

export const REFERENCE_POSES: Record<string, MouthPose> = {
  rest: { viseme: "sil", weights: { ...ZERO_WEIGHTS } },
  closed: { viseme: "PP", weights: { ...ZERO_WEIGHTS, mouthClose: 1 } },
  aa: { viseme: "aa", weights: { ...ZERO_WEIGHTS, jawOpen: 0.72, mouthStretch: 0.12 } },
  ee: { viseme: "ih", weights: { ...ZERO_WEIGHTS, jawOpen: 0.22, mouthStretch: 0.72, mouthSmile: 0.08 } },
  oo: { viseme: "ou", weights: { ...ZERO_WEIGHTS, jawOpen: 0.25, mouthPucker: 0.85, mouthFunnel: 0.55 } },
  oh: { viseme: "oh", weights: { ...ZERO_WEIGHTS, jawOpen: 0.55, mouthPucker: 0.45, mouthFunnel: 0.65 } },
  fv: { viseme: "FF", weights: { ...ZERO_WEIGHTS, jawOpen: 0.1, mouthClose: 0.55, mouthStretch: 0.25, mouthFunnel: 0.1 } },
  th: { viseme: "TH", weights: { ...ZERO_WEIGHTS, jawOpen: 0.25, mouthClose: 0.2, mouthStretch: 0.2, mouthFunnel: 0.15 } },
};

export interface Vec3 { x: number; y: number; z: number }
export interface OralSurface { vertices: Vec3[]; triangles: [number, number, number][]; material: "enamel" | "tongue" }

/** The inner lip funnel is not reconstructed from the source photo. Until
 * it is, approximate its occlusion rather than showing teeth through OO. */
export function enamelExposure(w: BlendWeights): number {
  const rounding = Math.min(1, w.mouthPucker + w.mouthFunnel * 0.6);
  return Math.max(0, 1 - rounding / 0.6);
}

/** Convex, front-facing ellipsoid patches. Dimensions are neutral-mouth units,
 * never the current opening width/height: teeth do not stretch on a vowel. */
function surface(center: Vec3, radius: Vec3, material: OralSurface["material"]): OralSurface {
  const vertices: Vec3[] = [];
  const triangles: [number, number, number][] = [];
  const cols = 8, rows = 6;
  for (let row = 0; row <= rows; row++) {
    const v = -Math.PI / 2 + Math.PI * row / rows;
    for (let col = 0; col <= cols; col++) {
      const u = -Math.PI / 2 + Math.PI * col / cols;
      vertices.push({
        x: center.x + radius.x * Math.sin(u) * (1 - 0.08 * Math.abs(Math.sin(v)) ** 6),
        y: center.y + radius.y * Math.sin(v),
        z: center.z + radius.z * Math.cos(u) * Math.cos(v),
      });
      if (row < rows && col < cols) {
        const a = row * (cols + 1) + col, b = a + cols + 1;
        triangles.push([a, a + 1, b], [a + 1, b + 1, b]);
      }
    }
  }
  return { vertices, triangles, material };
}

export function createDentalArch(lower: boolean, profile: ReferenceProfile): OralSurface[] {
  const result: OralSurface[] = [];
  // Central incisors, lateral incisors, canines, premolars. Upper row is
  // skull-fixed; the entire lower row receives one rigid jaw transform.
  const widths = [0.093, 0.073, 0.062, 0.055];
  for (const sign of [-1, 1]) {
    let edge = 0.002;
    widths.forEach((width, i) => {
      const toothW = width * profile.teethScale * (lower ? 0.86 : 1);
      const x = sign * (edge + toothW / 2);
      const h = (lower ? 0.084 : 0.108) * profile.teethScale * (1 - i * 0.06);
      result.push(surface({ x, y: (lower ? 0.11 : -0.023) + profile.teethY + Math.abs(x) ** 2 * 0.2,
        z: -0.09 - Math.abs(x) ** 2 * 1.8 }, { x: toothW * 0.49, y: h / 2, z: 0.032 }, "enamel"));
      edge += toothW;
    });
  }
  return result;
}

export function rotateJaw(p: Vec3, amount: number): Vec3 {
  // Posterior hinge; rigid rotation preserves each tooth's dimensions.
  const angle = Math.max(0, Math.min(1, amount)) * 0.3;
  const y = p.y + 0.1, z = p.z + 0.65;
  return { x: p.x, y: -0.1 + y * Math.cos(angle) + z * Math.sin(angle),
    z: -0.65 - y * Math.sin(angle) + z * Math.cos(angle) };
}

export function createTongue(lift: number, jaw: number): OralSurface {
  const center = rotateJaw({ x: 0, y: 0.15 - lift * 0.12, z: -0.2 + lift * 0.16 }, jaw);
  return surface(center, { x: 0.18, y: 0.055, z: 0.085 }, "tongue");
}

export function projectOralPoint(p: Vec3, left: MouthPoint, right: MouthPoint): MouthPoint {
  const dx = right.x - left.x, dy = right.y - left.y;
  const perspective = 3 / (3 - p.z);
  return { x: (left.x + right.x) / 2 + (dx * p.x - dy * p.y) * perspective,
    y: (left.y + right.y) / 2 + (dy * p.x + dx * p.y) * perspective };
}
