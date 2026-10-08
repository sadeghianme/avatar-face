import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AvatarEngine, type EngineOptions } from "../engine";
import { HUMAN_PROFILE, KNOWN_PROFILES, kindProfile } from "../engine/kind-profile";
import { engineSeam } from "../engine/seam";
import type { Rig } from "../types";
import { NoopPath, fakeCanvas } from "./browser-fakes";

/**
 * Which head motion an avatar gets (kind-profile.ts headMotion): the turn
 * in depth for a person's photograph, whatever its picture (no render
 * profile, or one this build does not know); the rigid layer for every
 * character and animal line. The page's option and setHeadMotion win.
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
