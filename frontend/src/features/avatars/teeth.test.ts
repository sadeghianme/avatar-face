/**
 * The Mouth panel's teeth, and the words for every reason a new avatar can
 * have generic ones: `npm test` (node --test).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  aiEditedLabels,
  aiEditedModels,
  FINISH_WARNINGS,
  MOUTH_ERROR_CODES,
  MOUTH_PHOTO_CODES,
  mouthErrorKey,
  TEETH_KINDS,
  TEETH_NOTE_CODES,
  teethNoteKey,
  teethView,
} from "./teeth.ts";

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

  it("words a refused teeth photo by who made it", () => {
    assert.equal(mouthErrorKey("mouth_teeth_unclear", "upload"), "mouthErr_upload_mouth_teeth_unclear");
    assert.equal(mouthErrorKey("mouth_teeth_unclear", "generate"), "mouthErr_generate_mouth_teeth_unclear");
    assert.equal(mouthErrorKey("image_limit_reached", "generate"), "mouthErr_image_limit_reached");
    // Unknown: the server's sentence is shown.
    assert.equal(mouthErrorKey("something_new", "upload"), null);
  });
  it("words every refusal of the mouth kit's request", () => {
    for (const code of [
      "third_party_ai_disabled", "imagegen_unavailable", "image_limit_reached", "source_gone", "not_a_photo",
      "mouth_not_for_face_type", "avatar_not_found", "too_many_jobs", "job_queue_full", "consent_outdated",
    ]) {
      assert.equal(mouthErrorKey(code, "generate"), `mouthErr_${code}`);
    }
    // The synchronous teeth route is gone, and its "already making them".
    assert.equal(mouthErrorKey("teeth_in_progress", "generate"), null);
  });
  it("words the new reasons a person's teeth are standard", () => {
    assert.equal(teethNoteKey("teeth_photo_rejected"), "mouthTeethNote_teeth_photo_rejected");
    assert.equal(teethNoteKey("timeout"), "mouthTeethNote_timeout");
  });

  it("discloses AI teeth beside what the AI did to the picture", () => {
    assert.deepEqual(aiEditedLabels(null), []);
    assert.deepEqual(aiEditedLabels({ mode: "touchup", model: "m" }), ["aiEdited_touchup"]);
    assert.deepEqual(
      aiEditedLabels({ mode: "touchup", model: "m", teeth: { model: "m" } }),
      ["aiEdited_touchup", "aiEdited_teeth"]
    );
    // Teeth alone: said once.
    assert.deepEqual(aiEditedLabels({ mode: "teeth", model: "m", teeth: { model: "m" } }), ["aiEdited_teeth"]);
  });

  it("discloses AI mouth shapes beside the rest, once", () => {
    const shapes = { model: "img-1", generated: 5 };
    assert.deepEqual(
      aiEditedLabels({ mode: "touchup", model: "m", teeth: { model: "m" }, mouth_shapes: shapes }),
      ["aiEdited_touchup", "aiEdited_teeth", "aiEdited_mouth_shapes"]
    );
    assert.deepEqual(
      aiEditedLabels({ mode: "teeth", model: "m", teeth: { model: "m" }, mouth_shapes: shapes }),
      ["aiEdited_teeth", "aiEdited_mouth_shapes"]
    );
    // Shapes alone: the mode says it.
    assert.deepEqual(aiEditedLabels({ mode: "mouth_shapes", model: "img-1", mouth_shapes: shapes }), [
      "aiEdited_mouth_shapes",
    ]);
  });

  it("names each model behind the disclosure once", () => {
    assert.deepEqual(aiEditedModels({ mode: "teeth", model: "img-1", teeth: { model: "img-1" } }), ["img-1"]);
    assert.deepEqual(aiEditedModels({ mode: "regenerate", model: "img-1", teeth: { model: "img-2" } }), ["img-1", "img-2"]);
    assert.deepEqual(aiEditedModels({ mode: "touchup", model: null }), []);
    assert.deepEqual(
      aiEditedModels({
        mode: "regenerate", model: "img-1", teeth: { model: "img-2" }, mouth_shapes: { model: "img-3", generated: 6 },
      }),
      ["img-1", "img-2", "img-3"]
    );
    assert.deepEqual(
      aiEditedModels({ mode: "mouth_shapes", model: "img-2", mouth_shapes: { model: "img-2", generated: 2 } }),
      ["img-2"]
    );
    assert.deepEqual(aiEditedModels({ mode: "mouth_shapes", model: null, mouth_shapes: { model: null, generated: 1 } }), []);
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
        ...TEETH_KINDS.map((kind) => `mouthTeethKind_${kind}`),
        ...MOUTH_ERROR_CODES.map((code) => mouthErrorKey(code, "generate")),
        ...MOUTH_PHOTO_CODES.flatMap((code) => [mouthErrorKey(code, "upload"), mouthErrorKey(code, "generate")]),
        "aiEdited_teeth",
        "aiEdited_mouth_shapes",
      ];
      assert.deepEqual(needed.filter((key) => !keys.has(key)), []);
    });
  }
});
