import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { keyMatches, queryKeys } from "./queryKeys.ts";

describe("query keys", () => {
  it("scopes an organization's data by its id", () => {
    assert.deepEqual(queryKeys.avatars("o1"), ["avatars", "o1"]);
    assert.deepEqual(queryKeys.avatar("o1", "a1"), ["avatar", "o1", "a1"]);
    assert.deepEqual(queryKeys.apiKeys("o1"), ["api-keys", "o1"]);
  });

  it("refreshes every creation of an organization from one prefix (the AI switch does)", () => {
    assert.ok(keyMatches(queryKeys.creations("o1"), queryKeys.creation("o1", "c1")));
    assert.ok(!keyMatches(queryKeys.creations("o2"), queryKeys.creation("o1", "c1")));
  });

  it("keeps the list and one avatar apart", () => {
    assert.ok(!keyMatches(queryKeys.avatars("o1"), queryKeys.avatar("o1", "a1")));
  });

  it("keeps the drafts list apart from a creation", () => {
    assert.ok(!keyMatches(queryKeys.creations("o1"), queryKeys.drafts("o1")));
  });

  it("matches a key by itself and not by a longer one", () => {
    assert.ok(keyMatches(queryKeys.orgs(), queryKeys.orgs()));
    assert.ok(!keyMatches(queryKeys.avatar("o1", "a1"), queryKeys.avatars("o1")));
  });

  it("gives every factory a distinct first part, apart from the creation pair", () => {
    const sample = (f: (...args: string[]) => readonly unknown[]) => f("x", "y")[0];
    const heads = Object.entries(queryKeys)
      .filter(([name]) => name !== "creations")
      .map(([, f]) => sample(f as (...args: string[]) => readonly unknown[]));
    assert.equal(new Set(heads).size, heads.length);
  });
});
