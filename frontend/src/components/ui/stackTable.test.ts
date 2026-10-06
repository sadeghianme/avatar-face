/** Stacked rows on a phone, the desktop table from sm: `npm test` (node --test). */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { STACK } from "./stackTable.ts";

describe("STACK", () => {
  it("gives every cell back the desktop table's padding from sm up", () => {
    for (const cell of [STACK.lead, STACK.cell, STACK.end]) {
      assert.match(cell, /\bsm:px-5\b/);
      assert.match(cell, /\bsm:py-3\b/);
    }
  });

  it("is a table again from sm up", () => {
    assert.match(STACK.table, /\bsm:table\b/);
    assert.match(STACK.body, /\bsm:table-row-group\b/);
    assert.match(STACK.row, /\bsm:table-row\b/);
  });
});
