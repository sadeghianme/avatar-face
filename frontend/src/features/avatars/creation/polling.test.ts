/**
 * Polling and stable image URLs: `npm test` (node --test). Node runs this
 * file as TypeScript by stripping its types, so it imports by file name and
 * uses no syntax that needs compiling.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { creation, step } from "./fixtures.ts";
import { stabilizeUrls, URL_REUSE_MS } from "./index.ts";

describe("stabilizeUrls", () => {
  it("keeps one URL per image across polls, so nothing reloads", () => {
    const held = new Map();
    const first = creation();
    assert.equal(stabilizeUrls(first, held, 0), first);
    const repoll = creation({
      steps: [step("original", { url: first.steps[0].url.replace("signature=s", "signature=t") })],
    });
    const stable = stabilizeUrls(repoll, held, 1000);
    assert.equal(stable.steps[0].url, first.steps[0].url);
  });
  it("takes the fresh URL once the held one is getting old", () => {
    const held = new Map();
    stabilizeUrls(creation(), held, 0);
    const fresh = step("original", { url: "/api/storage/orgs/o/creations/c/original-abc.png?expires=2&signature=u" });
    const later = stabilizeUrls(creation({ steps: [fresh] }), held, URL_REUSE_MS + 1);
    assert.equal(later.steps[0].url, fresh.url);
  });
  it("never confuses two images", () => {
    const held = new Map();
    stabilizeUrls(creation(), held, 0);
    const other = step("cutout", { url: "/api/storage/orgs/o/creations/c/cutout-def.png?expires=1&signature=s" });
    const next = stabilizeUrls(creation({ steps: [step("original"), other] }), held, 10);
    assert.equal(next.steps[1].url, other.url);
  });
});
