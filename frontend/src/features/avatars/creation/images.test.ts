/**
 * A creation's images and the step it opens on: `npm test` (node --test).
 * Node runs this file as TypeScript by stripping its types, so it imports by
 * file name and uses no syntax that needs compiling.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { adjustedStep, ai, anchors, creation, job, step } from "./fixtures.ts";
import {
  anchorsCurrent,
  backgroundSource,
  cutoutIdFor,
  cutoutOf,
  frameOf,
  inferStep,
  isCutoutId,
  isTransparent,
  movedParts,
  resolveStep,
  WIZARD_STEPS,
} from "./index.ts";

describe("marks and frames", () => {
  it("treats a cut-out as its source's pixel frame", () => {
    const cut = creation({
      current: "cutout",
      steps: [step("original"), step("framed", { from: "original" }), step("cutout", { from: "framed" })],
      anchors: anchors({ image: "framed" }),
    });
    assert.equal(anchorsCurrent(cut), true);
    assert.equal(backgroundSource(cut).id, "framed");
  });
  it("strands marks placed on another frame, or on an image that is gone", () => {
    const framed = creation({
      current: "framed",
      steps: [step("original"), step("framed", { from: "original" })],
      anchors: anchors({ image: "original" }),
    });
    assert.equal(anchorsCurrent(framed), false);
    assert.equal(anchorsCurrent(creation({ anchors: anchors({ image: null }) })), false);
    assert.equal(anchorsCurrent(creation({ anchors: null })), false);
  });
  it("lists the parts the owner moved", () => {
    const detected = { head: { left: { x: 1, y: 1 } }, chin: { x: 5, y: 5 } };
    const marks = { head: { left: { x: 2, y: 1 } }, chin: { x: 5, y: 5 } };
    assert.deepEqual(movedParts(marks, detected, ["head", "chin", "mouth_line"]), ["head"]);
    assert.deepEqual(movedParts(detected, detected, ["head", "chin"]), []);
  });
});

describe("which step opens", () => {
  it("stays on step 1 until the photo is in and the line is known", () => {
    assert.equal(inferStep(creation({ steps: [], current: null, job: job({ state: "running" }) })), "frame");
    assert.equal(inferStep(creation({ face_type: null })), "frame");
    assert.equal(resolveStep(creation({ face_type: null }), "points"), "frame");
  });
  it("resumes where work is running or last happened", () => {
    assert.equal(inferStep(creation({ job: job({ step: "background", state: "running" }) })), "background");
    assert.equal(
      inferStep(creation({ job: job({ step: "detect", state: "failed", error: { code: "job_failed", detail: "" } }) })),
      "points"
    );
    assert.equal(inferStep(creation({ anchors: anchors() })), "points");
    assert.equal(
      inferStep(creation({ current: "cutout", steps: [step("original"), step("cutout", { from: "original" })] })),
      "background"
    );
    assert.equal(inferStep(creation()), "frame");
  });
  it("follows the owner's order: upload, background, AI adjust, points, preparing the avatar", () => {
    assert.deepEqual([...WIZARD_STEPS], ["frame", "background", "adjust", "points", "prepare"]);
  });
  it("resumes on step 3 once the background is answered or AI was asked", () => {
    assert.equal(inferStep(creation({ background: "keep" })), "background");
    const round = {
      mode: "touchup",
      style: null,
      source: "original",
      limit_reached: false,
      candidates: [{ step: "adjusted:0", ok: true, reason: null, generated_eyes: false }],
    };
    assert.equal(
      inferStep(creation({ steps: [step("original"), adjustedStep(0)], ai: ai({ last_round: round }) })),
      "adjust"
    );
    // A round that made no picture at all still has its report to read.
    assert.equal(inferStep(creation({ ai: ai({ last_round: { ...round, candidates: [] } }) })), "adjust");
    assert.equal(inferStep(creation({ job: job({ step: "adjust", state: "running" }) })), "adjust");
  });
  it("keeps the owner on step 3 while a version they took is being cut out", () => {
    const taken = creation({
      current: "adjusted:0",
      background: "remove",
      steps: [step("original"), step("cutout", { from: "original", cutout: true }), adjustedStep(0)],
      job: job({ step: "background", state: "running" }),
    });
    assert.equal(inferStep(taken), "adjust");
    // Removing the photo's own background is step 2's job.
    const own = creation({ background: "remove", job: job({ step: "background", state: "running" }) });
    assert.equal(inferStep(own), "background");
  });
  it("honours the step in the URL, except while the avatar is being built", () => {
    assert.equal(resolveStep(creation({ anchors: anchors() }), "background"), "background");
    assert.equal(resolveStep(creation(), "nonsense"), "frame");
    assert.equal(resolveStep(creation(), null), "frame");
    assert.equal(resolveStep(creation({ status: "finishing" }), "frame"), "prepare");
    assert.equal(resolveStep(creation({ status: "finishing" }), "points"), "prepare");
    assert.equal(resolveStep(creation({ status: "finished" }), null), "prepare");
  });
  it("opens step 5 for a creation being built, a reloaded tab included", () => {
    const building = creation({
      status: "finishing",
      anchors: anchors(),
      job: job({ step: "finish", state: "running" }),
    });
    assert.equal(inferStep(building), "prepare");
    assert.equal(resolveStep(building, "prepare"), "prepare");
    assert.equal(inferStep(creation({ status: "finished" })), "prepare");
  });
  it("never opens step 5 on a draft: finishing is the only way there", () => {
    assert.equal(resolveStep(creation({ anchors: anchors() }), "prepare"), "points");
    assert.equal(resolveStep(creation(), "prepare"), "frame");
    assert.equal(resolveStep(creation({ face_type: null }), "prepare"), "frame");
  });
  it("brings a finish that failed back to the points, to be retried from there", () => {
    const failed = creation({
      anchors: anchors(),
      job: job({ step: "finish", state: "failed", error: { code: "job_failed", detail: "" }, retryable: true }),
    });
    assert.equal(inferStep(failed), "points");
    // The URL still says step 5 after a reload: the draft is not there.
    assert.equal(resolveStep(failed, "prepare"), "points");
    assert.equal(resolveStep(failed, "points"), "points");
  });
});

describe("cut-outs", () => {
  const steps = [
    step("original"),
    step("framed", { from: "original" }),
    step("cutout", { from: "framed", cutout: true }),
    adjustedStep(0, { from: "cutout", cutout: true }), // a touch-up of the cut-out
    adjustedStep(1, { from: "cutout", adjust: { ...adjustedStep(1).adjust, mode: "regenerate" } }),
    step("cutout:1", { from: "adjusted:1", cutout: true }),
  ];
  it("names the cut-out of each image", () => {
    assert.equal(cutoutIdFor("framed"), "cutout");
    assert.equal(cutoutIdFor("adjusted:7"), "cutout:7");
    assert.ok(isCutoutId("cutout") && isCutoutId("cutout:3"));
    assert.ok(!isCutoutId("adjusted:3") && !isCutoutId(null));
    assert.equal(cutoutOf(creation({ steps }), "adjusted:1")?.id, "cutout:1");
    assert.equal(cutoutOf(creation({ steps }), "adjusted:0"), null);
    // "cutout" was cut from the framed photo, not from the original.
    assert.equal(cutoutOf(creation({ steps }), "original"), null);
  });
  it("counts a touch-up of a cut-out as transparent", () => {
    assert.ok(isTransparent(steps[3]));
    assert.ok(!isTransparent(steps[4]));
    assert.ok(isTransparent(steps[5]));
    assert.ok(!isTransparent(null));
  });
  it("finds the opaque image behind the current one", () => {
    assert.equal(backgroundSource(creation({ steps, current: "cutout:1" }))?.id, "adjusted:1");
    // Through the touch-up and its cut-out, as "Keep original" goes.
    assert.equal(backgroundSource(creation({ steps, current: "adjusted:0" }))?.id, "framed");
    assert.equal(backgroundSource(creation({ steps, current: "adjusted:1" }))?.id, "adjusted:1");
  });
  it("shares a pixel frame between an image and its cut-out, never with an AI result", () => {
    assert.equal(frameOf(creation({ steps, current: "cutout:1" })), "adjusted:1");
    assert.equal(frameOf(creation({ steps, current: "cutout" })), "framed");
    assert.equal(frameOf(creation({ steps, current: "adjusted:0" })), "adjusted:0");
    const marked = creation({ steps, current: "cutout:1", anchors: anchors({ image: "adjusted:1" }) });
    assert.ok(anchorsCurrent(marked));
    assert.ok(!anchorsCurrent({ ...marked, current: "cutout" }));
  });
});
