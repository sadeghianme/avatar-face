/**
 * The UI kit's logic, without a browser (`npm test`): which classes a
 * button gets, what a busy one does, how a field wires its ids, what a
 * switch press flips, where the arrows go in a radio group.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buttonClass, iconButtonClass, pressState } from "./button-styles.ts";
import { fieldIds, joinDescribedBy } from "./field-ids.ts";
import { rovingMove, rovingTarget } from "./roving.ts";
import { switchClasses } from "./switch-styles.ts";

describe("Button classes", () => {
  it("is a primary 36px button by default", () => {
    assert.equal(buttonClass(), "btn-primary");
  });

  it("adds the size and the full width", () => {
    assert.equal(buttonClass({ variant: "secondary", size: "lg" }), "btn-secondary btn-lg");
    assert.equal(buttonClass({ variant: "danger", size: "sm", fullWidth: true }), "btn-danger btn-sm w-full");
  });

  it("gives a link or text button no box to size", () => {
    assert.equal(buttonClass({ variant: "link", size: "lg" }), "btn-link");
    assert.equal(buttonClass({ variant: "text", size: "xs" }), "btn-text");
  });

  it("names every icon button look by its class", () => {
    assert.equal(iconButtonClass(), "icon-btn");
    assert.equal(iconButtonClass("danger"), "icon-btn-danger");
    assert.match(iconButtonClass("secondary"), /^btn-secondary btn-lg/);
  });
});

describe("a busy button", () => {
  it("cannot be pressed and says it is busy", () => {
    assert.deepEqual(pressState({ loading: true }), { disabled: true, "aria-busy": true });
  });

  it("is only disabled when it is disabled", () => {
    assert.deepEqual(pressState({ disabled: true }), { disabled: true, "aria-busy": undefined });
    assert.deepEqual(pressState({}), { disabled: false, "aria-busy": undefined });
  });
});

describe("Field ids", () => {
  it("names the hint and the error after the control", () => {
    const ids = fieldIds("identifier", { hint: true, error: true });
    assert.equal(ids.controlId, "identifier");
    assert.equal(ids.hintId, "identifier-hint");
    assert.equal(ids.errorId, "identifier-error");
  });

  it("describes the control by what is on screen, the hint first", () => {
    assert.equal(fieldIds("f", { hint: true, error: true }).describedBy, "f-hint f-error");
    assert.equal(fieldIds("f", { error: true }).describedBy, "f-error");
    assert.equal(fieldIds("f", { hint: true }).describedBy, "f-hint");
    assert.equal(fieldIds("f").describedBy, undefined);
  });

  it("adds the control's own description after the field's", () => {
    assert.equal(joinDescribedBy("f-hint", "caps-lock"), "f-hint caps-lock");
    assert.equal(joinDescribedBy(undefined, "caps-lock"), "caps-lock");
    assert.equal(joinDescribedBy(undefined, undefined), undefined);
  });
});

describe("Switch", () => {
  it("flips the track's colour and the thumb's side when pressed", () => {
    for (const size of ["sm", "md"] as const) {
      const off = switchClasses(false, size);
      const on = switchClasses(true, size);
      assert.match(on.track, /\bbg-brand-600\b/);
      assert.doesNotMatch(off.track, /\bbg-brand-600\b/);
      assert.notEqual(on.thumb, off.thumb);
    }
  });

  it("keeps the 64×44 tap area around either track", () => {
    assert.match(switchClasses(false, "sm").track, /before:-inset-2\.5/);
    assert.match(switchClasses(false, "md").track, /before:-inset-2(?!\.)/);
  });
});

describe("radio group keyboard", () => {
  const sizes = ["s", "m", "l", "xl"] as const;

  it("reads the arrows by the page's direction", () => {
    assert.deepEqual(rovingMove("ArrowRight", false), { step: 1 });
    assert.deepEqual(rovingMove("ArrowRight", true), { step: -1 });
    assert.deepEqual(rovingMove("ArrowDown", true), { step: 1 });
    assert.deepEqual(rovingMove("End", false), { to: "last" });
    assert.deepEqual(rovingMove(" ", false), { choose: true });
    assert.equal(rovingMove("a", false), null);
  });

  it("wraps at both ends", () => {
    assert.equal(rovingTarget(sizes, "xl", { step: 1 }), "s");
    assert.equal(rovingTarget(sizes, "s", { step: -1 }), "xl");
  });

  it("steps over a disabled option, Home and End included", () => {
    const off = (v: string) => v === "m" || v === "xl";
    assert.equal(rovingTarget(sizes, "s", { step: 1 }, off), "l");
    assert.equal(rovingTarget(sizes, "s", { to: "last" }, off), "l");
    assert.equal(rovingTarget(sizes, "l", { to: "first" }, off), "s");
  });

  it("goes nowhere when every option is disabled", () => {
    assert.equal(
      rovingTarget(sizes, "s", { step: 1 }, () => true),
      undefined
    );
  });
});
