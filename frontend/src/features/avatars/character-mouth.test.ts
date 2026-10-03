/**
 * The character mouth's settings and which look an avatar has, without a
 * browser: `npm test` (node --test).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { characterSettings, characterUpdate, mouthLook, styleChange } from "./character-mouth.ts";
import { draftMouthConfig, previewMotion, savedMouthKey } from "./mouth-config.ts";

describe("which look an avatar has", () => {
  it("is no choice for a person or a 3D model", () => {
    assert.equal(mouthLook({ face_type: "human" }), null);
    assert.equal(mouthLook({}), null);
    assert.equal(mouthLook({ face_type: "animal", kind: "model3d" }), null);
  });

  it("is the character mouth when the rig names one, the original otherwise", () => {
    assert.equal(mouthLook({ face_type: "cartoon", render_profile: "toon@1" }), "character");
    assert.equal(mouthLook({ face_type: "animal", render_profile: "animal@2" }), "character");
    assert.equal(mouthLook({ face_type: "animal", render_profile: "animal@1" }), "original");
    assert.equal(mouthLook({ face_type: "cartoon", render_profile: null }), "original");
    assert.equal(mouthLook({ face_type: "cartoon" }), "original");
  });

  it("calls only a different look a change", () => {
    assert.equal(styleChange("original", "character"), true);
    assert.equal(styleChange("character", "classic"), true);
    assert.equal(styleChange("character", "character"), false);
    assert.equal(styleChange("original", "classic"), false);
    assert.equal(styleChange(null, "character"), false);
  });
});

describe("the settings", () => {
  it("default as the engine does, and clamp what was saved", () => {
    assert.deepEqual(characterSettings(null), { style: "character", teeth: "upper", tongue: true, jaw: 1 });
    assert.equal(characterSettings({ jaw: 9 }).jaw, 1.6);
    assert.equal(characterSettings({ jaw: 0 }).jaw, 0.5);
    assert.equal(characterSettings({ jaw: Number.NaN }).jaw, 1);
    assert.deepEqual(characterSettings({ teeth: "none", tongue: false, style: "classic" }), {
      style: "classic", teeth: "none", tongue: false, jaw: 1,
    });
  });

  it("are sent with the style being chosen, the jaw to two places", () => {
    const sent = characterUpdate(characterSettings({ jaw: 1.2345 }), "classic");
    assert.equal(sent.style, "classic");
    assert.equal(sent.jaw, 1.23);
  });
});

describe("the preview of an animation or an animal", () => {
  const source = { face_type: "animal" as const, mouth: { renderer: "classic" as const, profile: {}, character: { teeth: "none" as const } } };

  it("is the classic renderer with the owner's settings, saved or being edited", () => {
    assert.deepEqual(draftMouthConfig(source), { renderer: "classic", character: { teeth: "none" } });
    assert.deepEqual(draftMouthConfig(source, "classic", {}, { jaw: 1.4 }), { renderer: "classic", character: { jaw: 1.4 } });
  });

  it("is nothing before the owner has set anything, and never the photographic mouth", () => {
    assert.equal(draftMouthConfig({ face_type: "cartoon", mouth: null }), null);
    assert.equal(draftMouthConfig({ face_type: "cartoon", mouth: { renderer: "continuous", profile: {} } }), null);
  });

  it("leaves a person's preview as it was", () => {
    const person = { face_type: "human" as const, mouth: { renderer: "continuous" as const, profile: { jawRange: 0.7 }, motion_url: "m" } };
    assert.equal(draftMouthConfig(person)?.renderer, "continuous");
    assert.equal(draftMouthConfig({ face_type: "human", mouth: null }), null);
  });

  it("plays no standard-shapes comparison on a mouth that has no shapes", () => {
    const config = draftMouthConfig(source);
    assert.equal(previewMotion(config, "standard"), config);
  });

  it("drops an unsaved preview when the look changes under it", () => {
    const a = savedMouthKey({ ...source, render_profile: "animal@1" });
    const b = savedMouthKey({ ...source, render_profile: "animal@2" });
    assert.notEqual(a, b);
  });
});
