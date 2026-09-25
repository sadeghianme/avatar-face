/**
 * The Mouth panel's teeth, and the words for every reason a new avatar can
 * have generic ones: `npm test` (node --test).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { FINISH_WARNINGS, TEETH_NOTE_CODES, teethNoteKey, teethView } from "./teeth.ts";

const mouth = (extra = {}) => ({
  renderer: "continuous",
  profile: {},
  has_oral_photo: false,
  ...extra,
});

describe("teeth", () => {
  it("says nothing for the classic mouth", () => {
    assert.equal(teethView(null), null);
    assert.equal(teethView(mouth({ renderer: "classic", has_oral_photo: true })), null);
  });

  it("tells AI teeth from the owner's photo", () => {
    const ai = mouth({ has_oral_photo: true, teeth: { source: "ai", note: null } });
    assert.deepEqual(teethView(ai), { kind: "ai" });
    const own = mouth({ has_oral_photo: true, teeth: { source: "upload", note: null } });
    assert.deepEqual(teethView(own), { kind: "upload" });
    // A server from before the record: a photo there is the owner's.
    assert.deepEqual(teethView(mouth({ has_oral_photo: true })), { kind: "upload" });
  });

  it("keeps the reason generic teeth are used", () => {
    const note = { code: "no_ai_consent", detail: "You have not agreed" };
    assert.deepEqual(teethView(mouth({ teeth: { source: null, note } })), { kind: "generic", note });
    assert.deepEqual(teethView(mouth()), { kind: "generic", note: null });
    // The record says AI, but the photo is gone (removed): generic.
    const gone = mouth({ has_oral_photo: false, teeth: { source: "ai", note: null } });
    assert.deepEqual(teethView(gone), { kind: "generic", note: null });
  });

  it("translates known reasons and shows others as sent", () => {
    assert.equal(teethNoteKey("safety_refused"), "mouthTeethNote_safety_refused");
    assert.equal(teethNoteKey("something_new"), null);
  });

  const keysOf = (lang) =>
    new Set(
      [...readFileSync(new URL(`../../i18n/locales/${lang}/avatars.ts`, import.meta.url), "utf8")
        .matchAll(/^\s{2}([A-Za-z0-9_]+):\s/gm)].map((m) => m[1])
    );
  for (const lang of ["en", "fr"]) {
    it(`has ${lang} words for every teeth note and finish warning`, () => {
      const keys = keysOf(lang);
      const needed = [
        ...TEETH_NOTE_CODES.map((code) => `mouthTeethNote_${code}`),
        ...FINISH_WARNINGS.map((code) => `finishWarning_${code}`),
        "aiEdited_teeth",
      ];
      assert.deepEqual(needed.filter((key) => !keys.has(key)), []);
    });
  }
});
