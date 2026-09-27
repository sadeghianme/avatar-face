/**
 * The four-step wizard's rules, without a browser: `npm test` (node --test).
 * Node runs this file as TypeScript by stripping its types, so it imports
 * the module by its file name and uses no syntax that needs compiling.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  aiRequired,
  beforeStep,
  canUseOriginal,
  defaultName,
  faceFound,
  forgetChoices,
  intentFor,
  lineFor,
  needsPrepare,
  photoBlocker,
  planOf,
  preparedStep,
  prepareStage,
  recallChoices,
  rememberChoices,
  screenFor,
  statementFor,
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

describe("names", () => {
  it("takes the description's words", () => {
    assert.equal(defaultName({ description: "a cheerful baker.", fallback: "X" }), "Cheerful baker");
    assert.equal(defaultName({ description: "une chouette rousse", fallback: "X" }), "Chouette rousse");
    const long = defaultName({ description: "a very friendly golden retriever wearing a tiny blue bow tie and glasses", fallback: "X" });
    assert.ok(long.length <= 40 && !long.endsWith(" "), long);
    assert.ok(long.startsWith("Very friendly golden retriever"));
  });

  it("takes a file name only when it means something", () => {
    assert.equal(defaultName({ fileName: "maria_headshot.jpg", fallback: "X" }), "Maria headshot");
    assert.equal(defaultName({ fileName: "IMG_20260101_123456.jpg", fallback: "Realistic human" }), "Realistic human");
    assert.equal(defaultName({ fileName: "PXL_2026.png", fallback: "F" }), "F");
    assert.equal(defaultName({ fileName: "12345.png", fallback: "F" }), "F");
    assert.equal(defaultName({ fileName: null, fallback: "F" }), "F");
  });
});

describe("this tab's memory", () => {
  it("keeps the choices for a creation and as the last ones, and survives junk", () => {
    const store = memoryStore();
    const choices = { model: "animal", source: "generate", look: "cartoon", description: "a fox", fileName: null, intent: "ai" };
    rememberChoices(store, "c9", choices);
    assert.deepEqual(recallChoices(store, "c9"), choices);
    assert.deepEqual(recallChoices(store, null), choices);
    forgetChoices(store, "c9");
    assert.equal(recallChoices(store, "c9"), null);
    store.setItem("liveface.wizard.last", "{not json");
    assert.equal(recallChoices(store, null), null);
    store.setItem("liveface.wizard.last", JSON.stringify({ model: "robot", look: "cartoon", source: "upload" }));
    assert.equal(recallChoices(store, null), null);
    assert.equal(recallChoices(null, null), null);
  });
});
