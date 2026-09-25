import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContinuousMouth } from "../continuous-mouth";
import { REFERENCE_POSES, normalizeProfile } from "../reference-mouth-model";
import {
  performanceInfluence, validateMotionManifest, validatePerformanceManifest,
  type AvatarPerformanceManifest,
} from "../photographic-performance-model";
import type { BlendWeights, Rig } from "../../types";

/**
 * Per-avatar performance manifests (version 2, built by the backend's
 * performance kit) next to the bundled Reference motion (version 1).
 *
 * The first block pins what every EXISTING continuous-mouth avatar renders:
 * the bundled mouth-motion.json driven through a fixed sequence of mouth
 * shapes, digested vertex by vertex. The digests were recorded before
 * version 2 existed; if one changes, an avatar already live changed.
 */

const bundled = () => JSON.parse(readFileSync(new URL("../../../assets/mouth-motion.json", import.meta.url), "utf8"));

// performance.now() drives the mouth's spring; a fixed clock makes the
// sequence exact.
let clock = 0;
vi.spyOn(performance, "now").mockImplementation(() => clock);

const SEQUENCE: BlendWeights[] = ["aa", "ee", "closed", "oo", "oh", "fv", "th", "rest"]
  .flatMap(id => Array(12).fill(REFERENCE_POSES[id].weights));

/** Every deformed vertex, rounded to 1/100 px, over the whole sequence. */
function digest(mouth: ContinuousMouth, neutral: { x: number; y: number }[]): string {
  const hash = createHash("sha256");
  clock = 1000;
  for (const weights of SEQUENCE) {
    clock += 1000 / 60;
    const points = neutral.map(p => ({ ...p }));
    mouth.deform(points, neutral, {} as Rig, weights);
    hash.update(points.map(p => `${Math.round(p.x * 100)},${Math.round(p.y * 100)}`).join(";"));
  }
  return hash.digest("hex").slice(0, 16);
}

/** A face that is not the Reference: smaller, tilted, elsewhere. */
function otherFace(): { x: number; y: number }[] {
  const angle = 5 * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle);
  return bundled().poses[0].points.map(([x, y]: [number, number]) => ({
    x: 120 + (x * c - y * s) * 640, y: 40 + (x * s + y * c) * 640,
  }));
}

describe("the bundled Reference motion renders exactly as before", () => {
  it("on the Reference's own face", () => {
    const manifest = validatePerformanceManifest(bundled());
    const neutral = manifest.poses[0].points.map(([x, y]) => ({ x: x * 1000, y: y * 1000 }));
    expect(digest(new ContinuousMouth(manifest), neutral)).toBe("7dd3bf9ecaf6965e");
  });
  it("on another face, with a fitted jaw range", () => {
    const manifest = validatePerformanceManifest(bundled());
    const mouth = new ContinuousMouth(manifest);
    mouth.setProfile(normalizeProfile({ jawRange: 0.7 }));
    expect(digest(mouth, otherFace())).toBe("4ef2419f7b445111");
  });
  it("and through the loader that also takes avatar manifests", () => {
    const manifest = validateMotionManifest(bundled());
    const mouth = new ContinuousMouth(manifest);
    mouth.setProfile(normalizeProfile({ jawRange: 0.7 }));
    expect(digest(mouth, otherFace())).toBe("4ef2419f7b445111");
  });
});

/** Written by the backend's performance kit, and kept equal to what it
 *  writes by backend/tests/test_performance_kit.py: the contract. */
const avatarManifest = (): AvatarPerformanceManifest =>
  JSON.parse(readFileSync(new URL("./fixtures/avatar-motion.json", import.meta.url), "utf8"));

describe("validateMotionManifest", () => {
  it("passes the bundled Reference motion through exactly as before", () => {
    const value = bundled();
    expect(validateMotionManifest(value)).toBe(value);
    expect(() => validateMotionManifest({ ...value, character: "someone-else" })).toThrow("Invalid photographic character manifest");
  });
  it("accepts the backend's per-avatar manifest", () => {
    const manifest = validateMotionManifest(avatarManifest()) as AvatarPerformanceManifest;
    expect(manifest.version).toBe(2);
    expect(manifest.character).toBe("avatar-v1:contract-fixture");
    expect(manifest.poses.map(p => p.provenance)).toEqual(
      ["base", "generated", "generated", "generated", "retargeted", "retargeted", "retargeted"]);
  });
  it("is never accepted by the lab's crossfade player, which needs pose photos", () => {
    expect(() => validatePerformanceManifest(avatarManifest())).toThrow();
  });
  it.each([
    ["an unversioned character", (m: AvatarPerformanceManifest) => { m.character = "lab-reference-v1"; }],
    ["a character with a path in it", (m: AvatarPerformanceManifest) => { m.character = "avatar-v1:../x"; }],
    ["a jaw range outside the profile's", (m: AvatarPerformanceManifest) => { m.jaw_range = 2; }],
    ["a missing jaw range", (m: AvatarPerformanceManifest) => { delete (m as Partial<AvatarPerformanceManifest>).jaw_range; }],
    ["poses out of order", (m: AvatarPerformanceManifest) => { m.poses.reverse(); }],
    ["a retargeted rest pose", (m: AvatarPerformanceManifest) => { m.poses[0].provenance = "retargeted"; m.poses[0].registration_rms = null; }],
    ["a generated pose without registration", (m: AvatarPerformanceManifest) => { m.poses[1].registration_rms = null; }],
    ["a generated pose registered too loosely", (m: AvatarPerformanceManifest) => { m.poses[1].registration_rms = .01; }],
    ["a retargeted pose claiming a registration", (m: AvatarPerformanceManifest) => { m.poses[4].registration_rms = .001; }],
    ["an unknown provenance", (m: AvatarPerformanceManifest) => { (m.poses[2] as { provenance: string }).provenance = "guessed"; }],
    ["a pose photo outside the kit", (m: AvatarPerformanceManifest) => { m.poses[2].image = "../../secret.png"; }],
    ["a pose with missing points", (m: AvatarPerformanceManifest) => { m.poses[3].points.pop(); }],
    ["a far-away point", (m: AvatarPerformanceManifest) => { m.poses[3].points[10] = [9, 9]; }],
    ["a bad triangle", (m: AvatarPerformanceManifest) => { m.triangles[0] = [1, 1, 2]; }],
  ])("refuses %s", (_, spoil) => {
    const manifest = avatarManifest();
    spoil(manifest);
    expect(() => validateMotionManifest(manifest)).toThrow();
  });
});

describe("a per-avatar manifest in the continuous mouth", () => {
  const settle = (mouth: ContinuousMouth, neutral: { x: number; y: number }[], weights: BlendWeights) => {
    clock = 1000;
    let points = neutral;
    for (let i = 0; i < 400; i++) {
      clock += 1000 / 60;
      points = neutral.map(p => ({ ...p }));
      mouth.deform(points, neutral, {} as Rig, weights);
    }
    return points;
  };

  it("plays the person's own AA as photographed, at the fitted jaw range", () => {
    const manifest = validateMotionManifest(avatarManifest()) as AvatarPerformanceManifest;
    const mouth = new ContinuousMouth(manifest);
    mouth.setProfile(normalizeProfile({ jawRange: manifest.jaw_range }));
    // Any similarity of the manifest frame is a valid engine frame.
    const neutral = manifest.poses[0].points.map(([x, y]) => ({ x: x * 800 + 50, y: y * 800 + 20 }));
    const aa = settle(mouth, neutral, REFERENCE_POSES.aa.weights);
    const rest = manifest.poses[0].points, pose = manifest.poses[1].points;
    const cornerWidth = Math.hypot(rest[291][0] - rest[61][0], rest[291][1] - rest[61][1]);
    const pixelsPerUnit = 800 * cornerWidth / manifest.mouth_width;
    for (const i of [13, 14, 17, 0]) {
      const influence = performanceInfluence(rest[i][0], rest[i][1], manifest.center, manifest.mouth_width);
      expect(aa[i].y - neutral[i].y).toBeCloseTo((pose[i][1] - rest[i][1]) * pixelsPerUnit * influence, 1);
    }
    expect(aa[14].y - neutral[14].y).toBeGreaterThan(20);
  });

  it("scales movement from the jaw range its kit measured, not from the Reference's", () => {
    const at = (jawRange: number, measured: number) => {
      const manifest = validateMotionManifest({ ...avatarManifest(), jaw_range: measured }) as AvatarPerformanceManifest;
      const mouth = new ContinuousMouth(manifest);
      mouth.setProfile(normalizeProfile({ jawRange }));
      const neutral = manifest.poses[0].points.map(([x, y]) => ({ x: x * 800, y: y * 800 }));
      return digest(mouth, neutral);
    };
    // At its own fit the geometry is the same whatever that fit is.
    expect(at(.7, .7)).toBe(at(.95, .95));
    expect(at(.7, .7)).not.toBe(at(.85, .7));
  });

  it("loads from a URL like the bundled motion", async () => {
    const fetch = vi.fn(async () => ({ ok: true, json: async () => avatarManifest() }));
    vi.stubGlobal("fetch", fetch);
    try {
      const mouth = await ContinuousMouth.load("https://cdn.example/kit/motion.json");
      expect(mouth).toBeInstanceOf(ContinuousMouth);
      expect(fetch).toHaveBeenCalledWith("https://cdn.example/kit/motion.json", { signal: undefined });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

afterEach(() => { clock = 0; });
