import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AvatarEngine, type EngineOptions } from "../engine";
import { HUMAN_PROFILE, KNOWN_PROFILES, defaultHeadMotion, kindProfile } from "../engine/kind-profile";
import { engineSeam } from "../engine/seam";
import type { FaceType, Rig } from "../types";
import { NoopPath, fakeCanvas } from "./browser-fakes";

/**
 * Which head motion an avatar gets (kind-profile.ts defaultHeadMotion): by
 * its published face type when the host passes it, the turn in depth for a
 * person and the rigid layer for an animal or a cartoon, whatever the rig
 * names; without one, by the rig: the turn in depth for no render profile
 * (or one this build does not know), the rigid layer for every character
 * and animal line. The page's option and setHeadMotion win over both.
 */
const rig = JSON.parse(readFileSync(new URL("./fixtures/human-rig.json", import.meta.url), "utf8")) as Rig;
const withProfile = (render_profile: string | null | undefined): Rig => ({ ...structuredClone(rig), render_profile });
const engine = (r: Rig, opts: EngineOptions = {}) =>
  new AvatarEngine(
    fakeCanvas(),
    r,
    { naturalWidth: 1024, naturalHeight: 1024, width: 1024, height: 1024 } as HTMLImageElement,
    { warp: "2d", ...opts }
  );

describe("the head motion an avatar gets", () => {
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    vi.stubGlobal("Path2D", NoopPath);
    vi.stubGlobal("document", { createElement: () => fakeCanvas() });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("is the turn in depth for a person's photo, the rigid layer for every character and animal line", () => {
    expect(HUMAN_PROFILE.headMotion).toBe("3d");
    for (const name of [undefined, null, "", "human", "animal@99"])
      expect(kindProfile({ render_profile: name }).headMotion).toBe("3d");
    expect(KNOWN_PROFILES.length).toBeGreaterThan(0);
    for (const name of KNOWN_PROFILES) expect(kindProfile({ render_profile: name }).headMotion, name).toBe("2d");
    expect([...KNOWN_PROFILES].sort()).toEqual(["animal@1", "animal@2", "toon@1"]);
  });

  // The whole table: the face type (absent for a host from before it was
  // passed) by the rig's render profile, and how the head moves.
  type Row = [FaceType | null | undefined, string | null | undefined, "2d" | "3d"];
  const PROFILES = [undefined, null, "", "animal@99", ...KNOWN_PROFILES];
  const TABLE: Row[] = [
    ...PROFILES.map((p): Row => ["human", p, "3d"]),
    ...PROFILES.map((p): Row => ["animal", p, "2d"]),
    ...PROFILES.map((p): Row => ["cartoon", p, "2d"]),
    ...[undefined, null].flatMap((f): Row[] => [
      [f, undefined, "3d"],
      [f, null, "3d"],
      [f, "", "3d"],
      [f, "animal@99", "3d"],
      [f, "toon@1", "2d"],
      [f, "animal@1", "2d"],
      [f, "animal@2", "2d"],
    ]),
  ];

  it.each(TABLE)("for face type %s and render profile %s, is %s", (faceType, profile, mode) => {
    expect(defaultHeadMotion(kindProfile({ render_profile: profile }), faceType)).toBe(mode);
  });

  it("keeps the rigid layer for a face type this build does not know", () => {
    // A line added after this build: only a person is known to turn well.
    expect(defaultHeadMotion(HUMAN_PROFILE, "robot" as FaceType)).toBe("2d");
  });

  it("has a row for every profile this build knows, without a face type", () => {
    const rows = TABLE.filter(([faceType]) => faceType == null).map(([, profile]) => profile);
    for (const name of KNOWN_PROFILES) expect(rows, name).toContain(name);
  });

  it("is the rigid layer for an animal or a cartoon whose rig names no profile", () => {
    // Fitted before profiles existed (in production, a cat and two
    // cartoons), or a cartoon with the classic mouth: the rig reads as a
    // person's photograph, and only the face type says otherwise.
    for (const faceType of ["animal", "cartoon"] as const) {
      const drawn = engine(withProfile(undefined), { faceType });
      expect(drawn.headMotion(), faceType).toBe("2d");
      expect(engineSeam(drawn).motion.mode, faceType).toBe("2d");
      drawn.destroy();
    }
    const person = engine(withProfile(undefined), { faceType: "human" });
    expect(person.headMotion()).toBe("3d");
    person.destroy();
  });

  it("follows the page's option over the face type, both ways", () => {
    const cat = engine(withProfile(undefined), { faceType: "animal", headMotion: "3d" });
    expect(cat.headMotion()).toBe("3d");
    cat.setHeadMotion("2d");
    expect(cat.headMotion()).toBe("2d");
    cat.destroy();
    const person = engine(withProfile(undefined), { faceType: "human", headMotion: "2d" });
    expect(person.headMotion()).toBe("2d");
    person.destroy();
  });

  it("is what the engine runs unless the page says otherwise", () => {
    const photo = engine(withProfile(undefined));
    expect(photo.headMotion()).toBe("3d");
    expect(engineSeam(photo).motion.mode).toBe("3d");
    photo.destroy();
    for (const name of KNOWN_PROFILES) {
      const drawn = engine(withProfile(name));
      expect(drawn.headMotion(), name).toBe("2d");
      drawn.destroy();
    }
  });

  it("follows the page's option and setHeadMotion, both ways", () => {
    const photo = engine(withProfile(undefined), { headMotion: "2d" });
    expect(photo.headMotion()).toBe("2d");
    photo.setHeadMotion("3d");
    expect(photo.headMotion()).toBe("3d");
    photo.destroy();
    const toon = engine(withProfile("toon@1"), { headMotion: "3d" });
    expect(toon.headMotion()).toBe("3d");
    toon.setHeadMotion("2d");
    expect(toon.headMotion()).toBe("2d");
    toon.destroy();
  });
});
