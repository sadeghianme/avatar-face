/** The one-column touch query against Tailwind's `lg`: `npm test` (node --test). */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import defaultTheme from "tailwindcss/defaultTheme.js";

import { TOUCH_ONE_COLUMN } from "./useMediaQuery.ts";

describe("TOUCH_ONE_COLUMN", () => {
  it("ends one pixel below lg, where the rail and the avatar page's 60/40 begin", () => {
    const lg = parseInt(defaultTheme.screens.lg, 10);
    assert.equal(TOUCH_ONE_COLUMN, `(pointer: coarse) and (max-width: ${lg - 1}px)`);
  });
});
