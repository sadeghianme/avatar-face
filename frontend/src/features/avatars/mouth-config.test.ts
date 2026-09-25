/**
 * The previewed mouth config, without a browser: `npm test` (node --test).
 * Node strips the types, so this imports the module by its file name.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  draftMouthConfig,
  mouthConfigToLoad,
  mouthLoadIdentity,
  savedMouthKey,
  urlIdentity,
} from "./mouth-config.ts";

const signed = (path: string, signature: string) => `https://files.example${path}?X-Amz-Signature=${signature}`;
const oral = (signature = "a") => ({
  image_url: signed("/teeth.png", signature),
  rig_url: signed("/teeth.rig.json", signature),
});
const profile = { jawRange: 0.64, teethY: 0.02 };

describe("the config the preview loads", () => {
  it("hands the avatar's own motion on, as the widget does", () => {
    const config = { renderer: "continuous" as const, profile, oral: oral(), motion_url: signed("/motion.json", "a") };
    assert.deepEqual(mouthConfigToLoad(config), config);
  });

  it("plays the bundled motion when the avatar has none", () => {
    const loaded = mouthConfigToLoad({ renderer: "continuous", profile, oral: null });
    assert.equal(loaded.motion_url, null);
    assert.equal(loaded.oral, null);
  });

  it("drops a teeth photo without its rig", () => {
    const loaded = mouthConfigToLoad({
      renderer: "continuous", oral: { image_url: signed("/teeth.png", "a"), rig_url: "" },
    });
    assert.equal(loaded.oral, null);
  });
});

describe("when the attached mouth reloads", () => {
  const config = (motion: string | null, signature = "a", jawRange = 0.64) => ({
    renderer: "continuous" as const,
    profile: { jawRange },
    oral: oral(signature),
    motion_url: motion && signed(motion, signature),
  });

  it("reloads for another motion", () => {
    assert.notEqual(mouthLoadIdentity(config("/kit-1/motion.json")), mouthLoadIdentity(config("/kit-2/motion.json")));
    assert.notEqual(mouthLoadIdentity(config(null)), mouthLoadIdentity(config("/kit-1/motion.json")));
  });

  it("does not reload for a fresh signature or a profile change", () => {
    assert.equal(
      mouthLoadIdentity(config("/kit-1/motion.json", "a", 0.64)),
      mouthLoadIdentity(config("/kit-1/motion.json", "b", 0.9)));
  });

  it("is the classic mouth for anything else", () => {
    assert.equal(mouthLoadIdentity(null), "classic");
    assert.equal(mouthLoadIdentity({ renderer: "classic" }), "classic");
  });

  it("names a URL by its path", () => {
    assert.equal(urlIdentity(signed("/motion.json", "x")), "https://files.example/motion.json");
    assert.equal(urlIdentity(null), null);
  });
});

describe("the owner's draft mouth", () => {
  const avatar = (motion?: string | null, faceType: "human" | "animal" = "human") => ({
    face_type: faceType,
    mouth_photo: oral(),
    mouth: { renderer: "continuous" as const, profile, has_oral_photo: true, motion_url: motion },
  });

  it("carries the avatar's own motion, saved or previewed", () => {
    const motion = signed("/kit/motion.json", "a");
    assert.equal(draftMouthConfig(avatar(motion))?.motion_url, motion);
    const previewed = draftMouthConfig(avatar(motion), "continuous", { jawRange: 1 });
    assert.deepEqual(previewed, { renderer: "continuous", profile: { jawRange: 1 }, oral: oral(), motion_url: motion });
  });

  it("is absent for the classic mouth and for faces that are not human", () => {
    assert.equal(draftMouthConfig(avatar(null), "classic"), null);
    assert.equal(draftMouthConfig(avatar(null, "animal")), null);
    assert.equal(draftMouthConfig(undefined), null);
  });

  it("keeps an unsaved preview across a refetch that only re-signs the motion", () => {
    const first = avatar(signed("/kit/motion.json", "a"));
    const again = avatar(signed("/kit/motion.json", "b"));
    assert.equal(savedMouthKey(first), savedMouthKey(again));
    assert.notEqual(savedMouthKey(first), savedMouthKey(avatar(signed("/kit-2/motion.json", "a"))));
    assert.notEqual(savedMouthKey(first), savedMouthKey({ ...first, mouth: { ...first.mouth, profile: { jawRange: 1 } } }));
  });
});
