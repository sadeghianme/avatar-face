/**
 * The AI adjust, its points and the uploader's statement: `npm test` (node
 * --test). Node runs this file as TypeScript by stripping its types, so it
 * imports by file name and uses no syntax that needs compiling.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { adjustedStep, ai, creation, step } from "./fixtures.ts";
import {
  adjustModes,
  aiEditOf,
  aiPointsOffer,
  aiResultInUse,
  inUse,
  keepChoice,
  preselectedMode,
  recommendationOf,
  roundResults,
  roundSource,
  statementNeeded,
} from "./index.ts";

describe("AI adjust", () => {
  const round = (extra = {}) => ({
    mode: "touchup",
    style: null,
    source: "cutout",
    limit_reached: false,
    candidates: [
      { step: "adjusted:0", ok: true, reason: null, generated_eyes: true },
      { step: null, ok: false, reason: { code: "safety_refused", detail: "" }, generated_eyes: false },
    ],
    ...extra,
  });
  const steps = [
    step("original"),
    step("cutout", { from: "original", cutout: true }),
    adjustedStep(0, { from: "cutout", cutout: true }),
    adjustedStep(1, { from: "cutout" }),
    step("cutout:1", { from: "adjusted:1", cutout: true }),
  ];
  const recommendation = (extra = {}) => ({ image: "cutout", mode: "touchup", reasons: ["eyes_closed"], ...extra });
  const analysed = (extra = {}) =>
    creation({
      current: "cutout",
      steps,
      analysis: { checks: [], recommendation: recommendation() },
      ai: ai({ suggested: ["touchup"] }),
      ...extra,
    });

  it("shows a recommendation only for the image it was made on", () => {
    assert.deepEqual(recommendationOf(analysed()), recommendation());
    assert.equal(recommendationOf(analysed({ current: "adjusted:0" })), null);
    assert.equal(recommendationOf(creation()), null);
  });
  it("pre-selects the recommended fix, and nothing when nothing needs fixing", () => {
    assert.equal(preselectedMode(analysed()), "touchup");
    assert.equal(preselectedMode(analysed({ ai: ai({ suggested: [] }) })), null);
    // Not offered on this line, or AI switched off: nothing to pre-select.
    assert.equal(preselectedMode(analysed({ ai: ai({ suggested: ["touchup"], modes: ["regenerate"] }) })), null);
    assert.equal(preselectedMode(analysed({ ai: ai({ suggested: ["touchup"], enabled: false }) })), null);
  });
  it("offers the line's modes in a fixed order, none with AI off", () => {
    assert.deepEqual(adjustModes(creation({ ai: ai({ modes: ["regenerate", "touchup"] }) })), [
      "touchup",
      "regenerate",
    ]);
    assert.deepEqual(adjustModes(creation({ ai: ai({ enabled: false }) })), []);
  });
  it("lays out the last round, pictures and refusals alike", () => {
    const c = analysed({ ai: ai({ last_round: round() }) });
    assert.equal(roundSource(c)?.id, "cutout");
    const results = roundResults(c);
    assert.equal(results.length, 2);
    assert.equal(results[0].step?.id, "adjusted:0");
    assert.equal(results[1].step, null);
    // The round's "before" can be gone (a new framing drops it).
    assert.equal(roundSource(creation({ ai: ai({ last_round: round() }) })), null);
  });
  it("knows which version is on screen, through its cut-out", () => {
    const c = analysed({ current: "cutout:1" });
    assert.equal(aiResultInUse(c)?.id, "adjusted:1");
    assert.ok(inUse(c, "adjusted:1"));
    assert.ok(!inUse(c, "adjusted:0"));
    assert.equal(aiResultInUse(analysed()), null);
    assert.equal(aiResultInUse(analysed({ current: "adjusted:0" }))?.id, "adjusted:0");
  });
  it("keeps my photo by choosing what the round was made from, or nothing when it is on screen", () => {
    const withRound = (extra) => analysed({ ai: ai({ last_round: round() }), ...extra });
    assert.equal(keepChoice(withRound({ current: "cutout" })), null);
    assert.equal(keepChoice(withRound({ current: "adjusted:0" })), "cutout");
    assert.equal(keepChoice(withRound({ current: "cutout:1" })), "cutout");
    // An opaque "before" comes back as its cut-out when the background is off.
    const opaque = (extra) =>
      analysed({ ai: ai({ last_round: round({ source: "original" }) }), current: "cutout:1", ...extra });
    assert.equal(keepChoice(opaque({ background: "remove" })), "cutout");
    assert.equal(keepChoice(opaque({ background: "keep" })), "original");
    assert.equal(keepChoice(opaque({ current: "cutout" })), null);
    assert.equal(keepChoice(analysed()), null);
  });
  it("discloses an AI edit through cut-outs, and a generated original", () => {
    const c = analysed({ current: "cutout:1" });
    assert.deepEqual(aiEditOf(c), { mode: "touchup", model: "gemini-3.1-flash-image", generated_eyes: false });
    assert.equal(aiEditOf(analysed()), null);
    const generated = creation({
      steps: [
        step("original", { generated: { model: "m", style: "anime", provider: "gemini" } }),
        step("framed", { from: "original" }),
      ],
      current: "framed",
    });
    assert.deepEqual(aiEditOf(generated), { mode: "generate", model: "m", generated_eyes: false });
  });
});

describe("AI points", () => {
  const offer = (line, anchorsExtra = {}, aiExtra = {}) =>
    aiPointsOffer(creation({ face_type: line, ai: ai(aiExtra) }), {
      detected: false,
      source: "template",
      ...anchorsExtra,
    });
  it("is offered where the detector cannot see: animals, and animations it missed", () => {
    assert.equal(offer("animal"), "offer");
    assert.equal(offer("cartoon"), "offer");
    assert.equal(offer("cartoon", { detected: true, source: "mediapipe" }), null);
    assert.equal(offer("human"), null);
  });
  it("is not offered twice, nor with AI off; says so once the look is spent", () => {
    assert.equal(offer("animal", { source: "ai" }), null);
    assert.equal(offer("animal", {}, { enabled: false }), null);
    assert.equal(offer("animal", {}, { ai_detections_left: 0 }), "spent");
  });
});

describe("the uploader's statement", () => {
  it("is the one the server names, whatever line the creation is on now", () => {
    assert.equal(statementNeeded(creation({ face_type: "cartoon", statement: "depiction" })), "depiction");
    assert.equal(statementNeeded(creation({ statement: "generated_face" })), "generated_face");
    assert.equal(statementNeeded(creation({ face_type: "human", statement: null })), null);
  });
  it("falls back to asking every person, and only a person, from a server that does not say", () => {
    assert.equal(statementNeeded(creation({ face_type: "human" })), "depiction");
    assert.equal(statementNeeded(creation({ face_type: null })), "depiction");
    assert.equal(statementNeeded(creation({ face_type: "animal" })), null);
  });
});
