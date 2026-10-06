import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { errorMessage } from "./errorMessage.ts";

describe("errorMessage", () => {
  it("says the server's sentence", () => {
    assert.equal(
      errorMessage({ status: 409, code: "taken", detail: "That name is taken." }, "Error"),
      "That name is taken."
    );
  });

  it("falls back for anything else", () => {
    assert.equal(errorMessage(new TypeError("Failed to fetch"), "Error"), "Error");
    assert.equal(errorMessage({ status: 500, detail: "" }, "Error"), "Error");
    assert.equal(errorMessage(undefined, "Error"), "Error");
  });
});
