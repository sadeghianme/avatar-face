/**
 * The query retry rule: `npm test` (node --test).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { shouldRetry } from "./queryClient.ts";

const http = (status: number) => ({ status });

describe("a failed query is retried", () => {
  it("once, after a network error or a server error", () => {
    assert.equal(shouldRetry(0, new TypeError("Failed to fetch")), true);
    assert.equal(shouldRetry(0, http(0)), true);
    assert.equal(shouldRetry(0, http(500)), true);
    assert.equal(shouldRetry(0, http(503)), true);
    assert.equal(shouldRetry(1, http(503)), false);
    assert.equal(shouldRetry(1, new TypeError("Failed to fetch")), false);
  });

  it("never after a refusal, which a second try would only repeat", () => {
    for (const status of [400, 401, 403, 404, 409, 422])
      assert.equal(shouldRetry(0, http(status)), false, String(status));
  });

  it("but after 'later': a timeout or too many requests", () => {
    assert.equal(shouldRetry(0, http(408)), true);
    assert.equal(shouldRetry(0, http(429)), true);
  });
});
