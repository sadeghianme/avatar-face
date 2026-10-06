/**
 * The Mouth panel's teeth and kit line: `npm test` (node --test).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { TEETH_LINE_START, teethLine } from "./mouth-teeth-line.ts";

describe("the teeth and kit line", () => {
  it("asking for a kit clears the last error and forgets a kit's change, not an upload's", () => {
    const afterKit = { ...TEETH_LINE_START, changed: "kit" as const, error: "refused" };
    assert.deepEqual(teethLine(afterKit, { type: "kitAsked" }), { starting: true, changed: null, error: null });
    const afterUpload = { ...TEETH_LINE_START, changed: "upload" as const };
    assert.equal(teethLine(afterUpload, { type: "kitAsked" }).changed, "upload");
  });

  it("an answer stops the asking and keeps what it said", () => {
    const asked = teethLine(TEETH_LINE_START, { type: "kitAsked" });
    const refused = teethLine(asked, { type: "failed", error: "No image model" });
    assert.deepEqual(teethLine(refused, { type: "kitAnswered" }), {
      starting: false,
      changed: null,
      error: "No image model",
    });
  });

  it("a change made is kept until published; a new request clears only the error", () => {
    const uploaded = teethLine(TEETH_LINE_START, { type: "changed", changed: "upload" });
    const failing = teethLine(uploaded, { type: "failed", error: "x" });
    assert.deepEqual(teethLine(failing, { type: "clearError" }), { ...TEETH_LINE_START, changed: "upload" });
    assert.equal(teethLine(uploaded, { type: "changed", changed: null }).changed, null);
  });
});
