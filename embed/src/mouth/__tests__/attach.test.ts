import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fakeCanvas, stubNetwork, type Pixel, type Resource } from "../../__tests__/browser-fakes";
import type { ContinuousMouth } from "../continuous-mouth";
import { DentalPhotoError } from "../dental-oral-surface";
import { attachAvatarMouth, loadAvatarMouth } from "../index";
import { normalizeProfile } from "../reference-mouth-model";

/**
 * attachAvatarMouth is the one entry point shared by the dashboard, the share
 * page and the widget, so its contract is what keeps "what the owner fitted"
 * equal to "what visitors get". These run the real loader (the motion, the
 * teeth photo, the teeth surface built from it) over a network that records
 * every download, so what is fetched, and how often, is part of the contract.
 */

const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const bundled = read("../../../assets/mouth-motion.json");
/** Version 2, as the backend's performance kit writes it. */
const avatarMotion = read("./fixtures/avatar-motion.json");

const MOTION = "https://api.example/mouth-motion.json";
const KIT = "https://storage.example/kits/k1/motion.json?X-Amz-Signature=1";
const TEETH = {
  image_url: "https://storage.example/oral.webp?X-Amz-Signature=2",
  rig_url: "https://storage.example/oral.rig.json?X-Amz-Signature=3",
};

/** Enamel, as the teeth test sees it; and lips, where it finds no teeth. */
const ENAMEL: Pixel = [236, 228, 214, 255];
const LIPS: Pixel = [150, 90, 84, 255];

/** A teeth photo's rig: the Reference saying AA, lips apart over the teeth. */
const teethRig = {
  image_size: [1000, 1000],
  points: bundled.poses[1].points.map(([x, y]: number[]) => [x * 1000, y * 1000]),
  inner_lip_ring: bundled.inner_ring,
  outer_lip_ring: bundled.outer_ring,
};

const network = (answers: Record<string, Resource> = {}) => stubNetwork({
  [MOTION]: { json: bundled },
  [KIT]: { json: avatarMotion },
  [TEETH.image_url]: { image: ENAMEL },
  [TEETH.rig_url]: { json: teethRig },
  ...answers,
});

const host = () => ({ setMouthExtension: vi.fn(), tuning: { mouthOpen: 1.4 } });
/** The motion a loaded mouth plays, by its manifest's character. */
const playing = (mouth: ContinuousMouth) =>
  (mouth as unknown as { template: { character: string } }).template.character;
const hasTeethPhoto = (mouth: ContinuousMouth) => Boolean((mouth as unknown as { oral?: object }).oral);

beforeEach(() => {
  vi.stubGlobal("document", { createElement: () => fakeCanvas() });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("attachAvatarMouth", () => {
  it("fits the mouth and the engine's own opening from the saved profile", async () => {
    network();
    const engine = host();
    await attachAvatarMouth(engine, { renderer: "continuous", profile: { jawRange: 0.7 } }, MOTION);
    expect(engine.setMouthExtension).toHaveBeenCalledTimes(1);
    expect(engine.tuning.mouthOpen).toBe(0.7);
  });

  it("detaching restores the classic mouth AND the owner's own tuning", async () => {
    network();
    const engine = host();
    const attached = await attachAvatarMouth(engine, { renderer: "continuous" }, MOTION);
    attached.detach();
    expect(engine.setMouthExtension).toHaveBeenLastCalledWith(null);
    expect(engine.tuning.mouthOpen).toBe(1.4);
  });

  it("refits live without reloading anything", async () => {
    const { requested } = network();
    const engine = host();
    const attached = await attachAvatarMouth(engine, { renderer: "continuous", oral: TEETH, motion_url: KIT }, MOTION);
    const downloads = requested.length;
    attached.setProfile({ jawRange: 1.0 });
    expect(engine.tuning.mouthOpen).toBe(1.0);
    expect(requested.length).toBe(downloads);
  });

  it("clamps a published profile it does not trust", async () => {
    network();
    const engine = host();
    await attachAvatarMouth(engine, { renderer: "continuous", profile: { jawRange: 99 } }, MOTION);
    expect(engine.tuning.mouthOpen).toBe(normalizeProfile({ jawRange: 99 }).jawRange);
    expect(engine.tuning.mouthOpen).toBeLessThanOrEqual(1.1);
  });

  it("a failed load leaves the engine exactly as it was", async () => {
    network({ [MOTION]: { offline: true } });
    const engine = host();
    await expect(attachAvatarMouth(engine, { renderer: "continuous" }, MOTION)).rejects.toThrow();
    expect(engine.setMouthExtension).not.toHaveBeenCalled();
    expect(engine.tuning.mouthOpen).toBe(1.4);
  });
});

describe("the motion an avatar plays", () => {
  it("without a manifest of its own, is the bundled motion, exactly as before", async () => {
    const { requested } = network();
    const mouth = await loadAvatarMouth({ renderer: "continuous", oral: TEETH, motion_url: null }, MOTION);
    expect(playing(mouth)).toBe("lab-reference-v1");
    expect(requested).toEqual([MOTION, TEETH.image_url, TEETH.rig_url]);
  });

  it("is its own performance manifest when its config names one", async () => {
    const { requested } = network();
    const mouth = await loadAvatarMouth({ renderer: "continuous", motion_url: KIT }, MOTION);
    expect(playing(mouth)).toBe("avatar-v1:contract-fixture");
    expect(requested).toEqual([KIT]);
  });

  it.each<[string, Resource]>([
    ["404s (an expired link)", { status: 404 }],
    ["is refused (a manifest this engine cannot play)", { json: { ...avatarMotion, jaw_range: 2 } }],
    ["is not a manifest at all", { json: { version: 2 } }],
    ["cannot be reached", { offline: true }],
  ])("falls back to the bundled motion when its own %s", async (_, answer) => {
    const { requested } = network({ [KIT]: answer });
    const mouth = await loadAvatarMouth({ renderer: "continuous", motion_url: KIT }, MOTION);
    expect(playing(mouth)).toBe("lab-reference-v1");
    expect(requested).toEqual([KIT, MOTION]);
  });

  it("does not fall back once the caller has cancelled", async () => {
    const { requested } = network();
    const controller = new AbortController();
    controller.abort();
    await expect(loadAvatarMouth({ renderer: "continuous", motion_url: KIT }, MOTION, controller.signal))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(requested).toEqual([KIT]);
  });

  it("does not fall back when cancelled while its own motion downloads", async () => {
    const controller = new AbortController();
    const { requested } = network({ [KIT]: { status: 503 } });
    const fetch = globalThis.fetch;
    // Cancelled mid-request, and the request fails: the loader must not read
    // that failure as "the avatar's own motion did not load" (callers tell a
    // cancelled load by their own signal, not by the error).
    vi.stubGlobal("fetch", async (url: string, init?: { signal?: AbortSignal }) => {
      const response = await fetch(url, init);
      controller.abort();
      return response;
    });
    await expect(loadAvatarMouth({ renderer: "continuous", motion_url: KIT, oral: TEETH }, MOTION, controller.signal))
      .rejects.toThrow();
    expect(requested).toEqual([KIT]);
  });

  it("is not followed by the teeth photo when no motion loads at all", async () => {
    const { requested } = network({ [KIT]: { status: 404 }, [MOTION]: { offline: true } });
    await expect(loadAvatarMouth({ renderer: "continuous", motion_url: KIT, oral: TEETH }, MOTION)).rejects.toThrow();
    expect(requested).toEqual([KIT, MOTION]);
  });
});

describe("the avatar's teeth photo", () => {
  it("is downloaded once, after the motion, and draws the mouth's teeth", async () => {
    const { requested } = network();
    const mouth = await loadAvatarMouth({ renderer: "continuous", motion_url: KIT, oral: TEETH }, MOTION);
    expect(hasTeethPhoto(mouth)).toBe(true);
    expect(requested).toEqual([KIT, TEETH.image_url, TEETH.rig_url]);
  });

  it("is downloaded once when the avatar's own motion falls back", async () => {
    const { requested } = network({ [KIT]: { status: 404 } });
    const mouth = await loadAvatarMouth({ renderer: "continuous", motion_url: KIT, oral: TEETH }, MOTION);
    expect(playing(mouth)).toBe("lab-reference-v1");
    expect(hasTeethPhoto(mouth)).toBe(true);
    expect(requested).toEqual([KIT, MOTION, TEETH.image_url, TEETH.rig_url]);
  });

  // A teeth failure is not the motion's: nothing falls back to the bundled
  // motion, and nothing is downloaded again. The load rejects, and the
  // caller keeps the classic mouth.
  it.each<[string, Record<string, Resource>, string[], (error: unknown) => void]>([
    ["does not show the upper teeth", { [TEETH.image_url]: { image: LIPS } },
      [KIT, TEETH.image_url, TEETH.rig_url], (error) => expect(error).toBeInstanceOf(DentalPhotoError)],
    ["does not decode", { [TEETH.image_url]: { broken: true } },
      [KIT, TEETH.image_url], (error) => expect(error).toMatchObject({ name: "EncodingError" })],
    ["has lost its rig", { [TEETH.rig_url]: { status: 404 } },
      [KIT, TEETH.image_url, TEETH.rig_url], (error) => expect(error).toMatchObject({ message: "Mouth detail could not load" })],
    ["has a rig that is not one", { [TEETH.rig_url]: { json: { points: [] } } },
      [KIT, TEETH.image_url, TEETH.rig_url], (error) => expect(error).toMatchObject({ message: "Invalid mouth photograph rig" })],
  ])("that %s leaves the classic mouth, each file downloaded once", async (_, answers, downloads, expectError) => {
    const { requested } = network(answers);
    const engine = host();
    const error = await attachAvatarMouth(engine, { renderer: "continuous", motion_url: KIT, oral: TEETH }, MOTION)
      .then(() => null, (reason: unknown) => reason);
    expectError(error);
    expect(engine.setMouthExtension).not.toHaveBeenCalled();
    expect(engine.tuning.mouthOpen).toBe(1.4);
    expect(requested).toEqual(downloads);
  });
});
