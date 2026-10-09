import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { CloneJob } from "./api.ts";
import { clonedVoiceName, renderedLines, renderLineRequest } from "./clonedLines.ts";

const job = (over: Partial<CloneJob>): CloneJob => ({
  id: "j",
  name: "Mehdi voice",
  locale: "en-US",
  lines: [],
  status: "done",
  error: null,
  done_lines: 0,
  ...over,
});

describe("a cloned voice's lines", () => {
  it("are named by the voice id's name, whatever it holds", () => {
    assert.equal(clonedVoiceName("org1:Mehdi voice"), "Mehdi voice");
    assert.equal(clonedVoiceName("org1:a:b"), "a:b");
    assert.equal(clonedVoiceName("plain"), "plain");
  });

  it("are a finished job's every line and a running job's done ones, newest first, each once", () => {
    const jobs = [
      job({ id: "3", status: "processing", lines: ["Third", "Fourth"], done_lines: 1 }),
      job({ id: "2", status: "failed", lines: ["Hello", "Never made"], done_lines: 1, error: "boom" }),
      job({ id: "1", lines: ["Hello", "Welcome!"], done_lines: 2 }),
      job({ id: "0", status: "pending", lines: ["Queued"], done_lines: 0 }),
    ];
    assert.deepEqual(renderedLines(jobs, "Mehdi voice", "en-US"), ["Third", "Hello", "Welcome!"]);
  });

  it("are only this voice's, in this locale", () => {
    const jobs = [
      job({ name: "Other", lines: ["Not mine"] }),
      job({ locale: "fr-FR", lines: ["Bonjour"] }),
      job({ lines: ["Mine"] }),
    ];
    assert.deepEqual(renderedLines(jobs, "Mehdi voice", "en-US"), ["Mine"]);
    assert.deepEqual(renderedLines([], "Mehdi voice", "en-US"), []);
  });
});

describe("a line sent to be rendered", () => {
  it("is the voice's name and the line, trimmed", () => {
    assert.deepEqual(renderLineRequest({ voice: "Mehdi voice", line: "  How can I help?  " }), {
      voice: "Mehdi voice",
      line: "How can I help?",
    });
  });

  it("is nothing for any other state", () => {
    for (const state of [null, undefined, "x", { voice: "v" }, { voice: 1, line: "a" }, { voice: "v", line: "  " }]) {
      assert.equal(renderLineRequest(state), null);
    }
  });
});
