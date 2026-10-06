/**
 * The session's tokens in storage: `npm test` (node --test), with a Map
 * standing in for localStorage.
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { getTokens, setTokens } from "./api.ts";

const store = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  },
});

const KEY = "liveface.tokens";

describe("the session's tokens", () => {
  beforeEach(() => store.clear());

  it("are kept and read back, and dropped on sign-out", () => {
    setTokens({ access_token: "a", refresh_token: "r" });
    assert.deepEqual(getTokens(), { access_token: "a", refresh_token: "r" });
    setTokens(null);
    assert.equal(getTokens(), null);
    assert.equal(store.has(KEY), false);
  });

  it("an entry that is not a pair of tokens is no session, and is dropped", () => {
    for (const junk of [
      "{not json",
      "null",
      '"a string"',
      '{"access_token": "a"}',
      '{"access_token": 1, "refresh_token": 2}',
    ]) {
      store.set(KEY, junk);
      assert.equal(getTokens(), null, junk);
      assert.equal(store.has(KEY), false, junk);
    }
  });
});
