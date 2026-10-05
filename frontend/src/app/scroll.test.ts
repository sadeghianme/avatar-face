/** The scroll rule (app/scroll.ts) under `node --test`. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { scrollsToTop } from "./scroll.ts";

const at = (pathname, hash = "") => ({ pathname, hash });

describe("scroll to top on navigation", () => {
  it("a new page, opened or replaced, starts at the top", () => {
    assert.equal(scrollsToTop(at("/app"), at("/avatars/a1"), "PUSH"), true);
    // Back to the list, then another avatar: the top again.
    assert.equal(scrollsToTop(at("/app"), at("/avatars/b2"), "PUSH"), true);
    // The wizard lands on the avatar it built (replace).
    assert.equal(scrollsToTop(at("/avatars/new/c3"), at("/avatars/a1"), "REPLACE"), true);
    // The first page of the session has nowhere to come from.
    assert.equal(scrollsToTop(null, at("/avatars/a1"), "PUSH"), true);
  });

  it("the browser's Back and Forward keep the browser's own restoration", () => {
    assert.equal(scrollsToTop(at("/avatars/a1"), at("/app"), "POP"), false);
    assert.equal(scrollsToTop(null, at("/app"), "POP"), false);
  });

  it("an anchor and a query change stay where they are", () => {
    assert.equal(scrollsToTop(at("/avatars/a1"), at("/avatars/a1", "#mouth-panel"), "PUSH"), false);
    // The wizard's steps 1 and 2 are one page (?model=), 3 and 4 another (?step=).
    assert.equal(scrollsToTop(at("/avatars/new"), at("/avatars/new"), "PUSH"), false);
    assert.equal(scrollsToTop(at("/avatars/new/c3"), at("/avatars/new/c3"), "PUSH"), false);
    // Step 2 to step 3 is a new page.
    assert.equal(scrollsToTop(at("/avatars/new"), at("/avatars/new/c3"), "PUSH"), true);
  });
});
