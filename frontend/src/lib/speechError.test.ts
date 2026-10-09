import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SPEECH_ERRORS, speechFailure } from "./speechError.ts";

/** A `t` that shows which key it was given. */
const t = (key: string) => `[${key}]`;

describe("speechFailure", () => {
  it("words a code it knows, and keeps the code for the next step", () => {
    const refusal = { code: "cloned_line_missing", detail: "This line has not been rendered…", status: 404 };
    assert.deepEqual(speechFailure(t, refusal), {
      code: "cloned_line_missing",
      text: "[speechErr.cloned_line_missing]",
    });
    for (const code of SPEECH_ERRORS) assert.equal(speechFailure(t, { code }).text, `[speechErr.${code}]`);
  });

  it("says the server's sentence for a refusal it has no words for", () => {
    assert.deepEqual(speechFailure(t, { code: "rate_limited", detail: "Too many requests", status: 429 }), {
      code: "rate_limited",
      text: "Too many requests",
    });
  });

  it("falls back to the generic sentence only when nothing said why", () => {
    assert.deepEqual(speechFailure(t, new TypeError("Failed to fetch")), { code: null, text: "[error]" });
    assert.deepEqual(speechFailure(t, { code: "", detail: "" }), { code: null, text: "[error]" });
    assert.deepEqual(speechFailure(t, { code: 20, detail: 7 }), { code: null, text: "[error]" });
    assert.deepEqual(speechFailure(t, undefined), { code: null, text: "[error]" });
    assert.deepEqual(speechFailure(t, "boom"), { code: null, text: "[error]" });
  });
});
