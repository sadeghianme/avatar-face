/**
 * The four-step wizard's rules, without a browser: `npm test` (node --test).
 * Node runs this file as TypeScript by stripping its types, so it imports
 * the module by its file name and uses no syntax that needs compiling.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  activeChange,
  aiRequired,
  applyKeys,
  avatarName,
  beforeStep,
  canUseOriginal,
  faceFound,
  checklistRow,
  forgetChoices,
  heldStage,
  intentFor,
  lineFor,
  needsPrepare,
  photoBlocker,
  plainBody,
  clearBody,
  freeClearsLeft,
  planOf,
  preparedStep,
  prepareStage,
  recallChoices,
  rememberChoices,
  retryBody,
  screenFor,
  statementFor,
  statementKey,
  statementToAsk,
  footerPlan,
  selectedVersion,
  versionLabel,
  versionOfStep,
  versionsOf,
} from "./wizard.ts";

function memoryStore() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    key: (i) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
}

const step = (id, extra = {}) => ({ id, url: `https://x/${id}.png?sig`, width: 600, height: 750, from: null, crop: null, roll: null, ...extra });

function creation(overrides = {}) {
  return {
    id: "c1",
    face_type: "human",
    status: "draft",
    revision: 3,
    current: "original",
    steps: [step("original")],
    analysis: null,
    anchors: null,
    job: null,
    avatar_id: null,
    background_removal: { available: true, reason: null },
    background: null,
    ai: { enabled: true, modes: [], suggested: [], adjust_rounds_left: 2, ai_detections_left: 1, last_round: null, prepare_rounds_left: 6, last_prepare: null },
    plan: { model: "human", look: "realistic", source: "upload", description: null },
    created_at: "2026-09-28T00:00:00Z",
    updated_at: "2026-09-28T00:00:00Z",
    ...overrides,
  };
}

const anchors = (image, extra = {}) => ({
  id: "a1",
  source: "mediapipe",
  image,
  image_size: [600, 750],
  detected: true,
  marks: {},
  validation: { ok: true, reasons: [], warnings: [], detected: true, one_click: true },
  ...extra,
});

const prepared = (overrides = {}) =>
  creation({
    current: "cutout:0",
    steps: [step("original"), step("adjusted:0", { from: "original" }), step("cutout:0", { from: "adjusted:0", cutout: true })],
    anchors: anchors("adjusted:0"),
    ...overrides,
  });

describe("model × look → line", () => {
  it("maps onto the three lines", () => {
    assert.equal(lineFor("human", "realistic"), "human");
    assert.equal(lineFor("animal", "realistic"), "animal");
    for (const model of ["human", "animal"]) {
      assert.equal(lineFor(model, "animation"), "cartoon");
      assert.equal(lineFor(model, "cartoon"), "cartoon");
    }
  });

  it("reads an old draft's plan off its line", () => {
    assert.deepEqual(planOf(creation({ plan: null, face_type: "cartoon" })), {
      model: "human", look: "cartoon", source: "upload", description: null,
    });
    assert.equal(planOf(creation({ plan: undefined, face_type: "animal" })).model, "animal");
    const generated = creation({ plan: null, steps: [step("original", { generated: { model: "g", style: "photoreal", provider: "gemini" } })] });
    assert.equal(planOf(generated).source, "generate");
  });
});

describe("step 2", () => {
  const form = {
    model: "human", source: "upload", look: "realistic", description: "", hasFile: true,
    aiAgreed: true, statementAgreed: true, aiEnabled: true,
  };

  it("asks for the AI except where the photo can be used as it is", () => {
    assert.equal(aiRequired("upload", "realistic"), false);
    assert.equal(aiRequired("upload", "cartoon"), true);
    assert.equal(aiRequired("generate", "realistic"), true);
  });

  it("asks a person's statement, and the right one", () => {
    assert.equal(statementFor("human", "upload"), "depiction");
    assert.equal(statementFor("human", "generate"), "generated_face");
    assert.equal(statementFor("animal", "upload"), null);
  });

  it("asks Publish for the statement the server says it needs, not the one the model forecasts", () => {
    // The exact scenario: an animal whose cartoon "face" the detector found.
    // The Photo screen forecasts nothing for an animal...
    assert.equal(statementFor("animal", "generate"), null);
    // ...and the server's word, once there is a creation, is what Publish shows.
    const dog = { face_type: "cartoon", statement: "generated_face" };
    assert.equal(statementToAsk(dog, null), "generated_face");
    assert.equal(statementToAsk({ face_type: "animal", statement: "depiction" }, null), "depiction");
    assert.equal(statementToAsk({ face_type: "animal", statement: null }, null), null);
    // Made with the photo on step 2: not asked twice. Another statement: asked.
    assert.equal(statementToAsk({ face_type: "human", statement: "depiction" }, "depiction"), null);
    assert.equal(statementToAsk({ face_type: "human", statement: "depiction" }, "generated_face"), "depiction");
    // A server that does not say yet asks it of a person only.
    assert.equal(statementToAsk({ face_type: "human" }, null), "depiction");
    assert.equal(statementToAsk({ face_type: "animal" }, null), null);
  });

  it("says what holds the button", () => {
    assert.equal(photoBlocker(form), null);
    assert.equal(photoBlocker({ ...form, hasFile: false }), "wzHoldFile");
    assert.equal(photoBlocker({ ...form, statementAgreed: false }), "wzHoldStatement");
    assert.equal(photoBlocker({ ...form, aiAgreed: false }), null, "a realistic upload goes without AI");
    assert.equal(photoBlocker({ ...form, aiAgreed: false, look: "cartoon" }), "wzHoldAi");
    assert.equal(photoBlocker({ ...form, source: "generate", description: "  " }), "wzHoldDescription");
    assert.equal(photoBlocker({ ...form, model: "animal", statementAgreed: false }), null);
    assert.equal(photoBlocker({ ...form, aiEnabled: false, look: "animation" }), "wzHoldAiOff");
    assert.equal(photoBlocker({ ...form, aiEnabled: false, aiAgreed: false }), null);
  });

  it("starts step 3 with the AI only on the owner's agreement", () => {
    assert.equal(intentFor({ source: "upload", look: "realistic", aiAgreed: true, aiEnabled: true }), "ai");
    assert.equal(intentFor({ source: "upload", look: "realistic", aiAgreed: false, aiEnabled: true }), "original");
    assert.equal(intentFor({ source: "upload", look: "realistic", aiAgreed: true, aiEnabled: false }), "original");
  });
});

describe("step 3", () => {
  it("knows the picture it made, through its cut-out", () => {
    assert.equal(preparedStep(prepared())?.id, "cutout:0");
    assert.equal(preparedStep(creation()), null);
    // Anchors of another picture are not this one's.
    assert.equal(preparedStep(prepared({ anchors: anchors("adjusted:3") })), null);
    // A picture that could not be cut out is its own frame.
    assert.equal(preparedStep(prepared({ current: "adjusted:0" }))?.id, "adjusted:0");
  });

  it("starts by itself only when nothing is made, running or failed", () => {
    assert.equal(needsPrepare(creation()), true);
    assert.equal(needsPrepare(prepared()), false);
    assert.equal(needsPrepare(creation({ job: { id: "j", step: "ingest", state: "running", error: null, started_at: "", progress: null, retryable: false } })), false);
    assert.equal(needsPrepare(creation({ job: { id: "j", step: "prepare", state: "failed", error: { code: "provider_error", detail: "" }, started_at: "", progress: null, retryable: true } })), false);
    assert.equal(needsPrepare(creation({ job: { id: "j", step: "prepare", state: "failed", error: { code: "superseded", detail: "" }, started_at: "", progress: null, retryable: false } })), true);
    assert.equal(needsPrepare(creation({ steps: [] })), false);
    assert.equal(needsPrepare(creation({ status: "finishing" })), false);
  });

  it("says where the work is, and nothing for a label it does not know", () => {
    const job = (step, state, label) => ({ id: "j", step, state, error: null, started_at: "", progress: label === undefined ? null : { fraction: 0.5, label }, retryable: false });
    assert.equal(prepareStage(job("prepare", "queued")), "queued");
    assert.equal(prepareStage(job("prepare", "running", "creating your avatar")), "create");
    assert.equal(prepareStage(job("prepare", "running", "removing the background")), "background");
    assert.equal(prepareStage(job("generate", "running", "finding the face")), "face");
    assert.equal(prepareStage(job("ingest", "running", "reading")), "upload");
    assert.equal(prepareStage(job("prepare", "running", "something new")), null);
    assert.equal(prepareStage(job("finish", "running", "publishing")), null);
  });

  it("offers the original photo for a realistic upload only", () => {
    assert.equal(canUseOriginal({ model: "human", look: "realistic", source: "upload", description: null }), true);
    assert.equal(canUseOriginal({ model: "animal", look: "realistic", source: "upload", description: null }), true);
    assert.equal(canUseOriginal({ model: "human", look: "cartoon", source: "upload", description: null }), false);
    assert.equal(canUseOriginal({ model: "human", look: "realistic", source: "generate", description: "x" }), false);
  });

  it("shows a before only for an upload", () => {
    assert.equal(beforeStep(prepared())?.id, "original");
    assert.equal(beforeStep(prepared({ plan: { model: "human", look: "cartoon", source: "generate", description: "x" } })), null);
  });
});

describe("step 4", () => {
  it("opens only on a made picture, and always while it is built", () => {
    assert.equal(screenFor(prepared(), "publish"), "publish");
    assert.equal(screenFor(prepared(), null), "prepare");
    assert.equal(screenFor(creation(), "publish"), "prepare");
    assert.equal(screenFor(creation({ status: "finishing" }), null), "publish");
    const running = prepared({ job: { id: "j", step: "prepare", state: "running", error: null, started_at: "", progress: null, retryable: false } });
    assert.equal(screenFor(running, "publish"), "prepare");
  });

  it("publishes without points on a detection or the AI's fitting points, never on a guess", () => {
    assert.equal(faceFound(anchors("x")), true);
    assert.equal(faceFound(anchors("x", { detected: false, source: "ai" })), true);
    assert.equal(faceFound(anchors("x", { detected: false, source: "template" })), false);
    assert.equal(faceFound(anchors("x", { validation: { ok: false, reasons: [], warnings: [], detected: true, one_click: false } })), false);
    assert.equal(faceFound(null), false);
  });
});

describe("the stage shown", () => {
  it("never goes back within a run", () => {
    // Reading (the upload), then the picture's job waiting for a slot, then
    // a poll of the older state: the words stay on the furthest stage.
    let shown = null;
    const seen = [];
    for (const next of ["queued", "upload", "queued", "upload", "create", "upload", "queued", "check", "create", "background", "face", "save", null, "background"]) {
      shown = heldStage(shown, next);
      seen.push(shown);
    }
    assert.deepEqual(seen, ["queued", "upload", "upload", "upload", "create", "create", "create", "check", "check", "background", "face", "save", "save", "save"]);
    assert.equal(heldStage(null, null), null);
  });

  it("lights a checklist row for every stage, so the list never blanks", () => {
    const rows = ["upload", "create", "background", "face"];
    assert.equal(checklistRow("upload", rows), 0);
    assert.equal(checklistRow("check", rows), 1);
    assert.equal(checklistRow("save", rows), 3);
    assert.equal(checklistRow("queued", rows), -1);
    assert.equal(checklistRow(null, rows), -1);
    assert.equal(checklistRow("check", ["create", "background", "face"]), 0);
  });
});

describe("retry", () => {
  const upload = { model: "human", look: "cartoon", source: "upload", description: null };
  const generated = { model: "animal", look: "cartoon", source: "generate", description: "a fox" };
  const tried = (mode, instruction = null) => ({ mode, look: "cartoon", instruction, step: "adjusted:1", cut: true });

  it("tries the owner's last change again, on the same base, until it is cleared", () => {
    const last = tried("change", "a red shirt");
    assert.equal(activeChange(last), "a red shirt");
    assert.deepEqual(retryBody(upload, last), { mode: "change", instruction: "a red shirt", again: true });
    assert.deepEqual(retryBody(generated, last), { mode: "change", instruction: "a red shirt", again: true });
  });

  it("redoes the plain try when the last try was not a change", () => {
    assert.deepEqual(retryBody(upload, tried("ai")), { mode: "ai" });
    assert.deepEqual(retryBody(generated, tried("generate")), { mode: "generate" });
    assert.deepEqual(retryBody(upload, null), { mode: "ai" });
    assert.equal(activeChange(tried("change", null)), null);
    assert.equal(activeChange(tried("ai", "x")), null);
  });

  it("clears the change with a plain try", () => {
    assert.deepEqual(plainBody(upload), { mode: "ai" });
    assert.deepEqual(plainBody(generated), { mode: "generate" });
  });

  it("asks for the removal as a removal, so the server gives its try back", () => {
    assert.deepEqual(clearBody(upload), { mode: "ai", clear: true });
    assert.deepEqual(clearBody(generated), { mode: "generate", clear: true });
    assert.equal(freeClearsLeft({ ai: { free_clears_left: 2 } }), 2);
    assert.equal(freeClearsLeft({ ai: {} }), 0);
  });
});

describe("names", () => {
  it("is the server's, decided once with the creation, else the plan's own", () => {
    // What the server made of the file name or the description is used as
    // it is: the same on every screen, after a reload, and at the finish.
    assert.equal(avatarName({ name: "Maria headshot" }, "Human avatar"), "Maria headshot");
    assert.equal(avatarName({ name: "Cheerful baker" }, "Human avatar"), "Cheerful baker");
    // Nothing worth a name (a technical file name), or a server before it
    // said: the plan in words, in the member's language.
    assert.equal(avatarName({ name: null }, "Avatar animal"), "Avatar animal");
    assert.equal(avatarName({ name: "  " }, "Animal avatar"), "Animal avatar");
    assert.equal(avatarName({}, "Animal avatar"), "Animal avatar");
  });
});

describe("the statement's words", () => {
  it("fit the plan: a person's, or an animal's plan on a photo read as a person", () => {
    assert.equal(statementKey("depiction", { model: "human" }), "createDepictionStatement");
    assert.equal(statementKey("depiction", { model: "animal" }), "createDepictionStatement_animal");
    assert.equal(statementKey("generated_face", { model: "human" }), "createGeneratedFaceStatement");
    assert.equal(statementKey("generated_face", { model: "animal" }), "createGeneratedFaceStatement");
  });

  it("are asked of an animal plan only when the server found a person, as worded for it", () => {
    // An uploaded dog photo the detector read as a human face.
    const plan = { model: "animal", look: "realistic", source: "upload", description: null };
    const asked = statementToAsk({ statement: "depiction", face_type: "animal" }, null);
    assert.equal(asked, "depiction");
    assert.equal(statementKey(asked, plan), "createDepictionStatement_animal");
    // A person's plan: the usual words.
    assert.equal(statementKey("depiction", { model: "human" }), "createDepictionStatement");
    // The same dog, no face found: nothing.
    assert.equal(statementToAsk({ statement: null, face_type: "animal" }, null), null);
  });

  it("exist in every language", () => {
    const keys = ["createDepictionStatement", "createDepictionStatement_animal", "createGeneratedFaceStatement"];
    for (const lang of ["en", "fr"]) {
      const text = readFileSync(new URL(`../../i18n/locales/${lang}/avatars.ts`, import.meta.url), "utf8");
      for (const key of keys) assert.match(text, new RegExp(`^\\s{2}${key}:`, "m"), `${lang} ${key}`);
    }
  });
});

describe("the keyboard", () => {
  it("names the keys that apply a change for the platform", () => {
    for (const apple of ["MacIntel", "macOS", "iPhone", "iPad", "iPod"]) assert.equal(applyKeys(apple), "⌘ Enter", apple);
    for (const other of ["Win32", "Windows", "Linux x86_64", "Android", "Chrome OS", "", null, undefined]) {
      assert.equal(applyKeys(other), "Ctrl+Enter", String(other));
    }
  });
});

describe("this tab's memory", () => {
  it("keeps the choices for a creation and as the last ones, and survives junk", () => {
    const store = memoryStore();
    const choices = { model: "animal", source: "generate", look: "cartoon", description: "a fox", intent: "ai", statement: null };
    rememberChoices(store, "c9", choices);
    assert.deepEqual(recallChoices(store, "c9"), choices);
    assert.deepEqual(recallChoices(store, null), choices);
    rememberChoices(store, "c8", { ...choices, statement: "generated_face" });
    assert.equal(recallChoices(store, "c8").statement, "generated_face");
    forgetChoices(store, "c9");
    assert.equal(recallChoices(store, "c9"), null);
    store.setItem("liveface.wizard.last", "{not json");
    assert.equal(recallChoices(store, null), null);
    store.setItem("liveface.wizard.last", JSON.stringify({ model: "robot", look: "cartoon", source: "upload" }));
    assert.equal(recallChoices(store, null), null);
    assert.equal(recallChoices(null, null), null);
  });
});

describe("versions", () => {
  // An upload, its own photo prepared, an AI try, a change, the change removed.
  const made = (id, from, instruction = null) =>
    step(id, { from, adjust: { mode: "regenerate", instruction, rejected: null } });
  const many = creation({
    current: "cutout:1",
    steps: [
      step("original"),
      step("framed", { from: "original" }),
      step("cutout", { from: "framed", cutout: true }),
      made("adjusted:0", "original"),
      step("cutout:0", { from: "adjusted:0", cutout: true }),
      made("adjusted:1", "adjusted:0", "shorter hair"),
      step("cutout:1", { from: "adjusted:1", cutout: true }),
      made("adjusted:10", "original"),
      step("cutout:10", { from: "adjusted:10", cutout: true }),
      made("adjusted:2", "original"),
    ],
    anchors: anchors("adjusted:1"),
  });

  it("lists the upload first, then each AI result in the order made, newest last", () => {
    const list = versionsOf(many);
    assert.deepEqual(list.map((v) => v.id), ["original", "adjusted:0", "adjusted:1", "adjusted:2", "adjusted:10"]);
    assert.deepEqual(list.map((v) => v.number), [1, 2, 3, 4, 5]);
    assert.deepEqual(list.map((v) => v.kind), ["photo", "ai", "change", "ai", "ai"]);
    // Each shows its cut-out when it has one; the photo as it was prepared.
    assert.deepEqual(list.map((v) => v.shown.id), ["cutout", "cutout:0", "cutout:1", "adjusted:2", "cutout:10"]);
    assert.equal(list[2].instruction, "shorter hair");
  });

  it("knows the version in use, through its cut-out and the photo's framing", () => {
    assert.equal(selectedVersion(many), "adjusted:1");
    assert.equal(versionOfStep(many, "cutout"), "original");
    assert.equal(versionOfStep(many, "framed"), "original");
    assert.equal(versionOfStep(many, "cutout:10"), "adjusted:10");
    assert.equal(versionOfStep(many, "nope"), null);
    // Nothing made yet: nothing in use.
    assert.equal(selectedVersion(creation()), null);
  });

  it("lets the upload be used only for a realistic plan, and prepares it first if need be", () => {
    const fresh = creation({ steps: [step("original"), made("adjusted:0", "original")] });
    const [photo] = versionsOf(fresh);
    assert.equal(photo.selectable, true);
    assert.equal(photo.needsPrepare, true);
    assert.equal(photo.shown.id, "original");
    const styled = creation({
      plan: { model: "human", look: "cartoon", source: "upload", description: null },
      steps: [step("original"), made("adjusted:0", "original")],
    });
    assert.equal(versionsOf(styled)[0].selectable, false);
    assert.equal(versionsOf(styled)[0].needsPrepare, false);
  });

  it("has no upload for a character made from words: its first picture is the AI's", () => {
    const words = creation({
      plan: { model: "animal", look: "cartoon", source: "generate", description: "a fox" },
      steps: [
        step("original", { generated: { model: "m", style: "illustrated", provider: "gemini" } }),
        // An adjust round of the old wizard: the AI's picture of a picture.
        made("adjusted:0", "original"),
        // Its Retry: made anew from the description, like the first.
        step("adjusted:1", { from: "original", adjust: { mode: "generate", instruction: null, rejected: null } }),
        made("adjusted:2", "adjusted:1", "a red collar"),
      ],
    });
    const list = versionsOf(words);
    assert.deepEqual(list.map((v) => v.kind), ["generated", "ai", "generated", "change"]);
    assert.ok(list.every((v) => v.selectable && !v.needsPrepare));
  });

  it("leaves out a result that failed its checks", () => {
    const refused = creation({
      steps: [step("original"), step("adjusted:0", { from: "original", adjust: { mode: "regenerate", rejected: { code: "x", detail: "" } } })],
    });
    assert.deepEqual(versionsOf(refused).map((v) => v.id), ["original"]);
  });

  it("names each version for its alt text", () => {
    assert.deepEqual(versionLabel({ number: 3, kind: "change", instruction: "shorter hair" }), {
      key: "wzVersionAlt_change",
      values: { n: 3, change: "shorter hair" },
    });
    assert.equal(versionLabel({ number: 1, kind: "photo", instruction: null }).key, "wzVersionAlt_photo");
  });
});

describe("the footer", () => {
  it("puts Back on the left and the screen's one primary action on the right", () => {
    assert.deepEqual(footerPlan("model"), { back: "avatars", primary: null });
    assert.deepEqual(footerPlan("photo"), { back: "model", primary: "create" });
    assert.deepEqual(footerPlan("prepare"), { back: "photo", primary: null });
    assert.deepEqual(footerPlan("prepare", { prepared: true }), { back: "photo", primary: "continue" });
    assert.deepEqual(footerPlan("publish"), { back: "prepare", primary: "publish" });
    assert.deepEqual(footerPlan("publish", { building: true }), { back: null, primary: null });
  });
});
