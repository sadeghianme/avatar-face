/** The dialog focus-wrap rule: `npm test` (node --test). */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { focusReturn, nextFocusIndex, returnFocus } from "./focus.ts";

describe("nextFocusIndex", () => {
  it("wraps Tab from the last element to the first, and Shift+Tab back", () => {
    assert.equal(nextFocusIndex(2, 3, false), 0);
    assert.equal(nextFocusIndex(0, 3, true), 2);
    assert.equal(nextFocusIndex(0, 3, false), 1);
    assert.equal(nextFocusIndex(2, 3, true), 1);
  });
  it("enters at either end from outside the elements", () => {
    assert.equal(nextFocusIndex(-1, 3, false), 0);
    assert.equal(nextFocusIndex(-1, 3, true), 2);
    assert.equal(nextFocusIndex(7, 3, false), 0);
  });
  it("has nowhere to go with nothing to focus", () => {
    assert.equal(nextFocusIndex(0, 0, false), -1);
  });
});

describe("focusReturn", () => {
  it("returns focus at once to an opener that can take it", () => {
    assert.equal(focusReturn({ isConnected: true, disabled: false }), "now");
  });
  it("waits for an opener disabled by the request that opened the dialog", () => {
    assert.equal(focusReturn({ isConnected: true, disabled: true }), "wait");
  });
  it("gives up on an opener that is gone", () => {
    assert.equal(focusReturn({ isConnected: false, disabled: false }), "none");
    assert.equal(focusReturn(null), "none");
  });
});

describe("returnFocus", () => {
  // Just enough of a DOM: a MutationObserver the test fires by hand.
  const observers: { fire: () => void; off: boolean }[] = [];
  const g = globalThis as unknown as Record<string, unknown>;
  g.window ??= { setTimeout, clearTimeout };
  g.MutationObserver = class {
    off = false;
    callback: () => void;
    constructor(callback: () => void) {
      this.callback = callback;
      observers.push(this);
    }
    fire() {
      if (!this.off) this.callback();
    }
    observe() {}
    disconnect() {
      this.off = true;
    }
  };

  function opener(disabled: boolean) {
    const body = {};
    const doc = { body, activeElement: body as unknown };
    return {
      isConnected: true,
      disabled,
      focused: 0,
      ownerDocument: doc,
      focus() {
        this.focused += 1;
        doc.activeElement = this;
      },
    };
  }

  it("focuses an enabled opener straight away", () => {
    const button = opener(false);
    returnFocus(button as unknown as HTMLElement);
    assert.equal(button.focused, 1);
  });

  it("focuses a disabled opener once its request is done and it is enabled", () => {
    const button = opener(true);
    returnFocus(button as unknown as HTMLElement);
    assert.equal(button.focused, 0, "focus() on a disabled button would drop focus to <body>");
    const watching = observers[observers.length - 1];
    watching.fire();
    assert.equal(button.focused, 0, "still disabled");
    button.disabled = false;
    watching.fire();
    assert.equal(button.focused, 1);
    assert.equal(watching.off, true, "and stops watching");
  });

  it("leaves a keyboard user who moved on where they are", () => {
    const button = opener(true);
    const stop = returnFocus(button as unknown as HTMLElement);
    button.ownerDocument.activeElement = { somewhere: "else" };
    button.disabled = false;
    observers[observers.length - 1].fire();
    assert.equal(button.focused, 0);
    stop();
  });
});
