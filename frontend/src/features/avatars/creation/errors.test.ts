/**
 * A refusal in words: `npm test` (node --test). Node runs this file as
 * TypeScript by stripping its types, so it imports by file name and uses no
 * syntax that needs compiling.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { errorText } from "./index.ts";

describe("errorText", () => {
  const t = (key, options) => (options ? `${key}(${JSON.stringify(options)})` : key);
  it("uses our words for a known code, the server's otherwise", () => {
    assert.equal(errorText(t, "too_many_drafts", "You have 10"), "createErr_too_many_drafts");
    assert.equal(errorText(t, "something_new", "Server says so"), "Server says so");
    assert.equal(errorText(t, "something_new", ""), "error");
  });
  it("says how long to wait when the server did", () => {
    assert.equal(errorText(t, "job_queue_full", "", 30), 'createErr_job_queue_full createRetryAfter({"count":30})');
  });
});
