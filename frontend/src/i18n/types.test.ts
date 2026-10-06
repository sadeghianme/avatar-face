/**
 * The typed keys, checked where they matter: by tsc (`npm run typecheck`
 * reads this file; each @ts-expect-error fails the check if the line it
 * marks stops being an error). Node runs it too, as a plain test.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Locale, MessageKey } from "@/i18n/types";

describe("translation keys", () => {
  it("are en's: a flat key, a nested one by its path, a plural by its base", () => {
    const keys: MessageKey[] = ["save", "prep.detect", "roles.owner", "avatarCount", "avatarCount_one"];
    // @ts-expect-error a key en does not define
    const misspelled: MessageKey = "svae";
    // @ts-expect-error a nested key by its group alone
    const group: MessageKey = "roles";
    assert.equal(keys.length + [misspelled, group].length, 7);
  });

  it("another language must have en's keys, no more and no fewer", () => {
    type En = { save: string; prep: { detect: string } };
    const full = { save: "Enregistrer", prep: { detect: "Détection" } } satisfies Locale<En>;
    // @ts-expect-error a key missing
    const missing = { save: "Enregistrer", prep: {} } satisfies Locale<En>;
    // @ts-expect-error a key en does not have
    const extra = { save: "Enregistrer", prep: { detect: "Détection" }, cancel: "Annuler" } satisfies Locale<En>;
    assert.ok(full && missing && extra);
  });
});
