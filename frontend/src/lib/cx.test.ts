import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { cx } from "./cx.ts";

describe("cx", () => {
  it("joins the parts that are set, in order", () => {
    assert.equal(cx("card", "p-0"), "card p-0");
    assert.equal(cx("card", false, null, undefined, 0, "", "p-0"), "card p-0");
  });

  it("is empty when nothing is set", () => {
    assert.equal(cx(), "");
    assert.equal(cx(false, undefined), "");
  });
});
