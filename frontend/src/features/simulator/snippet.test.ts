import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildDocument, needsNewToken } from "./snippet.ts";

const at = 0;
const FRESH = ["Starting…", "Key renewed"];

describe("the Simulator's key", () => {
  it("is renewed when the widget refuses it", () => {
    const log = [
      { at, level: "info", message: "Starting…" },
      { at, level: "error", message: "speak failed: 401 simulator_token_invalid" },
    ] as const;
    assert.equal(needsNewToken(log, FRESH), true);
  });

  it("is not renewed again for a refusal from before the last renewal", () => {
    const log = [
      { at, level: "info", message: "Starting…" },
      { at, level: "error", message: "speak failed: 401" },
      { at, level: "info", message: "Key renewed" },
      { at, level: "ok", message: "finished speaking" },
    ] as const;
    assert.equal(needsNewToken(log, FRESH), false);
  });

  it("ignores other errors", () => {
    const log = [{ at, level: "error", message: "script failed to load" }] as const;
    assert.equal(needsNewToken(log, FRESH), false);
  });
});

describe("the customer's page", () => {
  it("carries the snippet's attributes and reports back to the Simulator", () => {
    const html = buildDocument({ src: "https://x.example/api/liveface.js", avatar: "a1", key: "k1" });
    assert.match(html, /src="https:\/\/x\.example\/api\/liveface\.js"/);
    assert.match(html, /data-avatar="a1"/);
    assert.match(html, /data-key="k1"/);
    assert.doesNotMatch(html, /data-voice/);
    assert.match(html, /parent\.postMessage/);
  });
});
