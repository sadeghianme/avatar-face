/**
 * The wizard's decisions, without a browser: `npm test` (node --test).
 * Node runs this file as TypeScript by stripping its types, so it imports
 * the module by its file name and uses no syntax that needs compiling.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  ADJUST_MODES,
  adjustModes,
  aiEditOf,
  aiPointsOffer,
  aiResultInUse,
  anchorsCurrent,
  autoAdjustKey,
  autoAdjustToStart,
  backgroundSource,
  CANDIDATE_REASONS,
  checkFile,
  clampRoll,
  confirmedParts,
  cutoutIdFor,
  cutoutOf,
  draftMarksKey,
  DRAWN_REASONS,
  errorText,
  expectedMouthWarnings,
  FINISH_PHASES,
  FINISH_POLL_MAX_MS,
  FINISH_STAGES,
  finishMouthStandard,
  finishNeedsAiConsent,
  finishNoticeFor,
  finishNoticeKey,
  finishRows,
  finishStage,
  forgetDraftMarks,
  forgetFinishNotice,
  frameOf,
  framingChanged,
  FULL_FRAME,
  inferStep,
  initialFraming,
  inUse,
  isBusy,
  isCutoutId,
  isTransparent,
  jobFailure,
  keepChoice,
  KNOWN_ERRORS,
  loadDraftMarks,
  marksAreGuessed,
  MAX_UPLOAD_BYTES,
  mouthExpected,
  movedParts,
  nameFromFile,
  normalizeCrop,
  PHOTO_CHECKS,
  pickMarks,
  pollDelay,
  preselectedMode,
  PUBLISH_STANDARD_LABEL,
  recommendationOf,
  REGENERATE_REASONS,
  rememberFinishNotice,
  resolveStep,
  roundResults,
  roundSource,
  saveDraftMarks,
  stabilizeUrls,
  stageCount,
  statementNeeded,
  TOUCHUP_REASONS,
  URL_REUSE_MS,
  WIZARD_STEPS,
} from "./creation.ts";
import { LINE_ORDER, LINES } from "./lines.ts";

const step = (id, extra = {}) => ({
  id,
  url: `/api/storage/orgs/o/creations/c/${id}-abc.png?expires=1&signature=s`,
  width: 800,
  height: 1000,
  from: null,
  crop: null,
  roll: null,
  ...extra,
});

const adjustedStep = (n, extra = {}) =>
  step(`adjusted:${n}`, {
    from: "original",
    adjust: {
      mode: "touchup",
      style: null,
      model: "gemini-3.1-flash-image",
      generated_eyes: false,
      rejected: null,
      checks: { detected: true, fit_ok: true, skin_delta_e: 1.2 },
    },
    ...extra,
  });

const job = (extra = {}) => ({
  id: "job1",
  step: "ingest",
  state: "done",
  error: null,
  started_at: "2026-09-25T10:00:00Z",
  progress: null,
  retryable: false,
  ...extra,
});

const anchors = (extra = {}) => ({
  id: "a1",
  image: "original",
  image_size: [800, 1000],
  detected: true,
  marks: {},
  validation: { ok: true, reasons: [], warnings: [], detected: true, one_click: true },
  ...extra,
});

const ai = (extra = {}) => ({
  enabled: true,
  modes: ["touchup", "stylise", "regenerate"],
  suggested: [],
  adjust_rounds_left: 2,
  ai_detections_left: 1,
  last_round: null,
  ...extra,
});

const creation = (extra = {}) => ({
  id: "c1",
  face_type: "human",
  status: "draft",
  revision: 1,
  current: "original",
  steps: [step("original")],
  analysis: null,
  anchors: null,
  job: job(),
  avatar_id: null,
  background_removal: { available: true, reason: null },
  background: null,
  ai: ai(),
  created_at: "2026-09-25T10:00:00Z",
  updated_at: "2026-09-25T10:00:00Z",
  ...extra,
});

describe("checkFile", () => {
  it("accepts the three photo types within the size limit", () => {
    for (const type of ["image/jpeg", "image/png", "image/webp"]) {
      assert.equal(checkFile({ name: "a", type, size: 1000 }), null);
    }
  });
  it("refuses other types, and anything over 15 MB", () => {
    assert.equal(checkFile({ name: "a.gif", type: "image/gif", size: 10 }), "unsupported_image_type");
    assert.equal(checkFile({ name: "a.heic", type: "", size: 10 }), "unsupported_image_type");
    assert.equal(checkFile({ name: "a.jpg", type: "image/jpeg", size: MAX_UPLOAD_BYTES + 1 }), "image_too_large");
    assert.equal(checkFile({ name: "a.jpg", type: "image/jpeg", size: MAX_UPLOAD_BYTES }), null);
  });
  it("sends a 3D model to its own importer, whatever its type says", () => {
    assert.equal(checkFile({ name: "Head.GLB", type: "", size: 10 }), "model_file");
    assert.equal(checkFile({ name: "x", type: "model/gltf-binary", size: 10 }), "model_file");
  });
});

describe("nameFromFile", () => {
  it("drops the last extension only, and stays within the API's 128", () => {
    assert.equal(nameFromFile("holiday-2024.final.jpg"), "holiday-2024.final");
    assert.equal(nameFromFile("Ava"), "Ava");
    assert.equal(nameFromFile(`${"x".repeat(200)}.png`).length, 128);
  });
});

describe("jobs", () => {
  it("is busy while a job is queued or running, or the avatar is being built", () => {
    assert.equal(isBusy(creation({ job: job({ state: "queued" }) })), true);
    assert.equal(isBusy(creation({ job: job({ state: "running" }) })), true);
    assert.equal(isBusy(creation({ job: job({ state: "done" }) })), false);
    assert.equal(isBusy(creation({ job: job({ state: "failed" }) })), false);
    assert.equal(isBusy(creation({ job: job({ state: "interrupted" }) })), false);
    assert.equal(isBusy(creation({ job: null, status: "finishing" })), true);
    assert.equal(isBusy(undefined), false);
  });
  it("shows failures, but not a superseded result, which the owner caused", () => {
    const failed = job({ state: "failed", error: { code: "job_failed", detail: "x" } });
    assert.deepEqual(jobFailure(failed), { code: "job_failed", detail: "x" });
    assert.equal(jobFailure(job({ state: "failed", error: { code: "superseded", detail: "" } })), null);
    assert.equal(jobFailure(job({ state: "interrupted", error: null })).code, "interrupted");
    assert.equal(jobFailure(job({ state: "running" })), null);
    assert.equal(jobFailure(null), null);
  });
  it("polls quickly at first, backs off, and never waits more than 5 s", () => {
    const delays = Array.from({ length: 12 }, (_, i) => pollDelay(i));
    assert.equal(delays[0], 600);
    for (let i = 1; i < delays.length; i++) assert.ok(delays[i] >= delays[i - 1]);
    assert.equal(Math.max(...delays), 5000);
    assert.equal(pollDelay(-3), 600);
  });
  it("watches a finish closely enough for its count to move", () => {
    const delays = Array.from({ length: 40 }, (_, i) => pollDelay(i, true));
    assert.equal(delays[0], 600);
    for (let i = 1; i < delays.length; i++) assert.ok(delays[i] >= delays[i - 1]);
    assert.equal(Math.max(...delays), FINISH_POLL_MAX_MS);
    assert.equal(FINISH_POLL_MAX_MS, 2000);
    // A minute of it is about thirty requests, not one a second.
    let elapsed = 0;
    let polls = 0;
    while (elapsed < 60_000) elapsed += pollDelay(polls++, true);
    assert.ok(polls <= 35, `polls: ${polls}`);
  });
});

describe("marks and frames", () => {
  it("treats a cut-out as its source's pixel frame", () => {
    const cut = creation({
      current: "cutout",
      steps: [step("original"), step("framed", { from: "original" }), step("cutout", { from: "framed" })],
      anchors: anchors({ image: "framed" }),
    });
    assert.equal(anchorsCurrent(cut), true);
    assert.equal(backgroundSource(cut).id, "framed");
  });
  it("strands marks placed on another frame, or on an image that is gone", () => {
    const framed = creation({
      current: "framed",
      steps: [step("original"), step("framed", { from: "original" })],
      anchors: anchors({ image: "original" }),
    });
    assert.equal(anchorsCurrent(framed), false);
    assert.equal(anchorsCurrent(creation({ anchors: anchors({ image: null }) })), false);
    assert.equal(anchorsCurrent(creation({ anchors: null })), false);
  });
  it("lists the parts the owner moved", () => {
    const detected = { head: { left: { x: 1, y: 1 } }, chin: { x: 5, y: 5 } };
    const marks = { head: { left: { x: 2, y: 1 } }, chin: { x: 5, y: 5 } };
    assert.deepEqual(movedParts(marks, detected, ["head", "chin", "mouth_line"]), ["head"]);
    assert.deepEqual(movedParts(detected, detected, ["head", "chin"]), []);
  });
});

describe("guessed marks", () => {
  it("are marks on the face template: an animal's always, any face the detector missed", () => {
    assert.equal(marksAreGuessed({ detected: false }, LINES.animal.oneClick), true);
    assert.equal(marksAreGuessed({ detected: true }, LINES.animal.oneClick), true);
    assert.equal(marksAreGuessed({ detected: false }, LINES.human.oneClick), true);
    assert.equal(marksAreGuessed({ detected: false }, LINES.cartoon.oneClick), true);
    assert.equal(marksAreGuessed({ detected: true }, LINES.human.oneClick), false);
  });
  it("count as placed when moved or ticked, and only those are sent", () => {
    const parts = LINES.animal.marks;
    const confirmed = confirmedParts(parts, ["head"], ["chin"]);
    assert.deepEqual(confirmed, ["head", "chin"]);
    const marks = { head: { left: { x: 1, y: 2 } }, chin: { x: 5, y: 6 }, left_eye: { left: { x: 3, y: 4 } } };
    // Nothing unconfirmed reaches finish, so the server sees it as missing.
    assert.deepEqual(pickMarks(marks, confirmed), { head: marks.head, chin: marks.chin });
    assert.deepEqual(pickMarks(marks, ["mouth_line"]), {});
  });
});

/** A Web Storage stand-in: a Map with the four calls the drafts use. */
function memoryStore(entries = []) {
  const map = new Map(entries);
  return {
    map,
    get length() {
      return map.size;
    },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
  };
}

describe("marks in progress", () => {
  const draft = { marks: { chin: { x: 5, y: 6 } }, ticked: ["head"] };
  it("come back for the anchors they were placed on, and no others", () => {
    const store = memoryStore();
    saveDraftMarks(store, "c1", "a1", draft);
    assert.deepEqual(loadDraftMarks(store, "c1", "a1"), draft);
    assert.equal(loadDraftMarks(store, "c1", "a2"), null);
    assert.equal(loadDraftMarks(store, "c2", "a1"), null);
    saveDraftMarks(store, "c1", "a1", null);
    assert.equal(loadDraftMarks(store, "c1", "a1"), null);
  });
  it("are forgotten for one creation at a time", () => {
    const store = memoryStore([["other", "kept"]]);
    saveDraftMarks(store, "c1", "a1", draft);
    saveDraftMarks(store, "c1", "a2", draft);
    saveDraftMarks(store, "c2", "a1", draft);
    forgetDraftMarks(store, "c1");
    assert.deepEqual([...store.map.keys()].sort(), [draftMarksKey("c2", "a1"), "other"].sort());
  });
  it("never let a broken or foreign entry into the editor", () => {
    const store = memoryStore([
      [draftMarksKey("c", "bad-json"), "{"],
      [draftMarksKey("c", "no-marks"), JSON.stringify({ ticked: [] })],
      [
        draftMarksKey("c", "stray"),
        JSON.stringify({ marks: { chin: { x: 1, y: 1 }, nose: 1 }, ticked: ["head", "nose"] }),
      ],
    ]);
    assert.equal(loadDraftMarks(store, "c", "bad-json"), null);
    assert.equal(loadDraftMarks(store, "c", "no-marks"), null);
    assert.deepEqual(loadDraftMarks(store, "c", "stray"), { marks: { chin: { x: 1, y: 1 } }, ticked: ["head"] });
  });
  it("survive storage that is missing or throws", () => {
    const throwing = {
      length: 1,
      key: () => {
        throw new Error("blocked");
      },
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    assert.equal(loadDraftMarks(throwing, "c", "a"), null);
    assert.doesNotThrow(() => saveDraftMarks(throwing, "c", "a", draft));
    assert.doesNotThrow(() => forgetDraftMarks(throwing, "c"));
    assert.equal(loadDraftMarks(null, "c", "a"), null);
  });
});

describe("which step opens", () => {
  it("stays on step 1 until the photo is in and the line is known", () => {
    assert.equal(inferStep(creation({ steps: [], current: null, job: job({ state: "running" }) })), "frame");
    assert.equal(inferStep(creation({ face_type: null })), "frame");
    assert.equal(resolveStep(creation({ face_type: null }), "points"), "frame");
  });
  it("resumes where work is running or last happened", () => {
    assert.equal(inferStep(creation({ job: job({ step: "background", state: "running" }) })), "background");
    assert.equal(
      inferStep(creation({ job: job({ step: "detect", state: "failed", error: { code: "job_failed", detail: "" } }) })),
      "points"
    );
    assert.equal(inferStep(creation({ anchors: anchors() })), "points");
    assert.equal(
      inferStep(creation({ current: "cutout", steps: [step("original"), step("cutout", { from: "original" })] })),
      "background"
    );
    assert.equal(inferStep(creation()), "frame");
  });
  it("follows the owner's order: upload, background, AI adjust, points, preparing the avatar", () => {
    assert.deepEqual([...WIZARD_STEPS], ["frame", "background", "adjust", "points", "prepare"]);
  });
  it("resumes on step 3 once the background is answered or AI was asked", () => {
    assert.equal(inferStep(creation({ background: "keep" })), "background");
    const round = {
      mode: "touchup",
      style: null,
      source: "original",
      limit_reached: false,
      candidates: [{ step: "adjusted:0", ok: true, reason: null, generated_eyes: false }],
    };
    assert.equal(
      inferStep(creation({ steps: [step("original"), adjustedStep(0)], ai: ai({ last_round: round }) })),
      "adjust"
    );
    // A round that made no picture at all still has its report to read.
    assert.equal(inferStep(creation({ ai: ai({ last_round: { ...round, candidates: [] } }) })), "adjust");
    assert.equal(inferStep(creation({ job: job({ step: "adjust", state: "running" }) })), "adjust");
  });
  it("keeps the owner on step 3 while a version they took is being cut out", () => {
    const taken = creation({
      current: "adjusted:0",
      background: "remove",
      steps: [step("original"), step("cutout", { from: "original", cutout: true }), adjustedStep(0)],
      job: job({ step: "background", state: "running" }),
    });
    assert.equal(inferStep(taken), "adjust");
    // Removing the photo's own background is step 2's job.
    const own = creation({ background: "remove", job: job({ step: "background", state: "running" }) });
    assert.equal(inferStep(own), "background");
  });
  it("honours the step in the URL, except while the avatar is being built", () => {
    assert.equal(resolveStep(creation({ anchors: anchors() }), "background"), "background");
    assert.equal(resolveStep(creation(), "nonsense"), "frame");
    assert.equal(resolveStep(creation(), null), "frame");
    assert.equal(resolveStep(creation({ status: "finishing" }), "frame"), "prepare");
    assert.equal(resolveStep(creation({ status: "finishing" }), "points"), "prepare");
    assert.equal(resolveStep(creation({ status: "finished" }), null), "prepare");
  });
  it("opens step 5 for a creation being built, a reloaded tab included", () => {
    const building = creation({
      status: "finishing",
      anchors: anchors(),
      job: job({ step: "finish", state: "running" }),
    });
    assert.equal(inferStep(building), "prepare");
    assert.equal(resolveStep(building, "prepare"), "prepare");
    assert.equal(inferStep(creation({ status: "finished" })), "prepare");
  });
  it("never opens step 5 on a draft: finishing is the only way there", () => {
    assert.equal(resolveStep(creation({ anchors: anchors() }), "prepare"), "points");
    assert.equal(resolveStep(creation(), "prepare"), "frame");
    assert.equal(resolveStep(creation({ face_type: null }), "prepare"), "frame");
  });
  it("brings a finish that failed back to the points, to be retried from there", () => {
    const failed = creation({
      anchors: anchors(),
      job: job({ step: "finish", state: "failed", error: { code: "job_failed", detail: "" }, retryable: true }),
    });
    assert.equal(inferStep(failed), "points");
    // The URL still says step 5 after a reload: the draft is not there.
    assert.equal(resolveStep(failed, "prepare"), "points");
    assert.equal(resolveStep(failed, "points"), "points");
  });
});

describe("framing", () => {
  const suggested = { crop: { x: 0.1, y: 0.05, w: 0.7, h: 0.6 }, roll: 4.2 };
  const analysed = (extra = {}) =>
    creation({
      analysis: {
        image_size: [800, 1000],
        detector: "mediapipe",
        detected: true,
        face_box: null,
        roll: 4.2,
        suggested_face_type: "human",
        suggested_framing: suggested,
        checks: [],
      },
      ...extra,
    });

  it("opens on the suggestion when nobody has touched the photo", () => {
    assert.deepEqual(initialFraming(analysed()), suggested);
  });
  it("opens on what was applied, once something was", () => {
    const crop = { x: 0.2, y: 0.2, w: 0.5, h: 0.5 };
    const framed = analysed({
      revision: 3,
      current: "framed",
      steps: [step("original"), step("framed", { from: "original", crop, roll: -2 })],
    });
    assert.deepEqual(initialFraming(framed), { crop, roll: -2 });
  });
  it("keeps the whole photo when the owner moved on without framing", () => {
    assert.deepEqual(initialFraming(analysed({ revision: 2 })), { crop: FULL_FRAME, roll: 0 });
    assert.deepEqual(initialFraming(analysed({ anchors: anchors() })), { crop: FULL_FRAME, roll: 0 });
    assert.deepEqual(initialFraming(creation()), { crop: FULL_FRAME, roll: 0 });
  });
  it("sees a real change, not the server's rounding", () => {
    const a = { crop: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 }, roll: 0 };
    assert.equal(framingChanged(a, { crop: { x: 0.10004, y: 0.1, w: 0.5, h: 0.5 }, roll: 0.01 }), false);
    assert.equal(framingChanged(a, { crop: { x: 0.12, y: 0.1, w: 0.5, h: 0.5 }, roll: 0 }), true);
    assert.equal(framingChanged(a, { ...a, roll: 1 }), true);
  });
  it("sends crops the server accepts: 4 decimals, inside the photo", () => {
    const crop = normalizeCrop({ x: 0.33333333, y: 0.1, w: 0.66669999, h: 0.9000001 });
    assert.ok(crop.x + crop.w <= 1);
    assert.ok(crop.y + crop.h <= 1);
    assert.equal(crop.x, 0.3333);
    assert.deepEqual(normalizeCrop({ x: -0.01, y: 0, w: 1.02, h: 1 }), FULL_FRAME);
  });
  it("keeps the roll within the API's ±45°", () => {
    assert.equal(clampRoll(50), 45);
    assert.equal(clampRoll(-60), -45);
    assert.equal(clampRoll(3.14159), 3.1);
    assert.equal(clampRoll(Number.NaN), 0);
  });
});

describe("stabilizeUrls", () => {
  it("keeps one URL per image across polls, so nothing reloads", () => {
    const held = new Map();
    const first = creation();
    assert.equal(stabilizeUrls(first, held, 0), first);
    const repoll = creation({
      steps: [step("original", { url: first.steps[0].url.replace("signature=s", "signature=t") })],
    });
    const stable = stabilizeUrls(repoll, held, 1000);
    assert.equal(stable.steps[0].url, first.steps[0].url);
  });
  it("takes the fresh URL once the held one is getting old", () => {
    const held = new Map();
    stabilizeUrls(creation(), held, 0);
    const fresh = step("original", { url: "/api/storage/orgs/o/creations/c/original-abc.png?expires=2&signature=u" });
    const later = stabilizeUrls(creation({ steps: [fresh] }), held, URL_REUSE_MS + 1);
    assert.equal(later.steps[0].url, fresh.url);
  });
  it("never confuses two images", () => {
    const held = new Map();
    stabilizeUrls(creation(), held, 0);
    const other = step("cutout", { url: "/api/storage/orgs/o/creations/c/cutout-def.png?expires=1&signature=s" });
    const next = stabilizeUrls(creation({ steps: [step("original"), other] }), held, 10);
    assert.equal(next.steps[1].url, other.url);
  });
});

describe("errorText", () => {
  const t = (key, options) => (options ? `${key}(${JSON.stringify(options)})` : key);
  it("uses our words for a known code, the server's otherwise", () => {
    assert.equal(errorText(t, "too_many_drafts", "You have 10"), "createErr_too_many_drafts");
    assert.equal(errorText(t, "something_new", "Server says so"), "Server says so");
    assert.equal(errorText(t, "something_new", ""), "error");
  });
  it("says how long to wait when the server did", () => {
    assert.equal(errorText(t, "job_queue_full", "", 30), 'createErr_job_queue_full createRetryAfter({"count":30})');
  });
});

describe("lines", () => {
  it("offers all three lines, labelling cartoon as its own key", () => {
    assert.deepEqual([...LINE_ORDER], ["human", "animal", "cartoon"]);
    assert.equal(LINES.cartoon.label, "faceType_cartoon");
  });
  it("matches the server's rules: people only for background removal, never one-click animals", () => {
    assert.deepEqual(
      LINE_ORDER.filter((id) => LINES[id].backgroundRemoval),
      ["human"]
    );
    assert.equal(LINES.animal.oneClick, false);
    // services.creations.LINES["animal"].marks
    assert.deepEqual([...LINES.animal.marks], ["head", "left_eye", "right_eye", "mouth_line", "chin"]);
    assert.ok(!LINES.animal.marks.includes("left_pupil"));
    assert.ok(LINES.human.marks.includes("mouth") && !LINES.human.marks.includes("mouth_line"));
  });
});

describe("strings", () => {
  // Read as text: importing a locale would take a path that climbs out of
  // this feature, which the structure check forbids.
  const keysOf = (lang) =>
    new Set(
      [
        ...readFileSync(new URL(`../../i18n/locales/${lang}/avatars.ts`, import.meta.url), "utf8").matchAll(
          /^\s{2}([A-Za-z0-9_]+):\s/gm
        ),
      ].map((m) => m[1])
    );
  for (const lang of ["en", "fr"]) {
    it(`has ${lang} words for every error code, job and step the wizard names`, () => {
      const keys = keysOf(lang);
      const needed = [
        ...[...KNOWN_ERRORS].map((code) => `createErr_${code}`),
        ...["ingest", "generate", "adjust", "background", "detect", "finish"].flatMap((s) => [
          `createJob_${s}`,
          `createJobDone_${s}`,
        ]),
        ...WIZARD_STEPS.flatMap((s) => [`createStep_${s}`, `createHeading_${s}`, `createIntro_${s}`]),
        ...[...PHOTO_CHECKS].map((code) => `photoCheck_${code}`),
        ...ADJUST_MODES.map((mode) => `adjustMode_${mode}`),
        ...["touchup", "stylise"].map((mode) => `adjustModeHint_${mode}`),
        ...LINE_ORDER.map((id) => `adjustModeHint_regenerate_${id}`),
        ...["touchup", "regenerate"].map((mode) => `adjustRecommend_${mode}`),
        ...[...TOUCHUP_REASONS, ...REGENERATE_REASONS].map((code) => `adjustWhy_${code}`),
        ...[...DRAWN_REASONS].map((code) => `adjustWhyDrawn_${code}`),
        ...[...CANDIDATE_REASONS].map((code) => `adjustReason_${code}`),
        ...["touchup", "stylise", "regenerate", "generate", "teeth"].map((mode) => `aiEdited_${mode}`),
        ...LINE_ORDER.flatMap((id) => [LINES[id].summary, LINES[id].guide]),
        ...LINE_ORDER.flatMap((id) => LINES[id].marks.map((part) => `createGuessPart_${part}`)),
        ...["not_for_face_type", "segmentation_unavailable", "face_type_required"].map(
          (r) => `createBgUnavailable_${r}`
        ),
        ...FINISH_STAGES.map((stage) => `createFinishStage_${stage}`),
        ...FINISH_PHASES.map((phase) => `createFinishPhase_${phase}`),
        ...["shapes", "teeth"].map((phase) => `createFinishPhaseHint_${phase}`),
        ...["done", "current", "pending", "skipped"].map((state) => `createFinishPhaseState_${state}`),
        "mouthShapesCount",
        "adjustAutoStarted",
        "adjustAutoReady",
        "adjustAutoStartedEyes",
        "adjustAutoReadyEyes",
        ...["Fix", "Place", "Statement", "Name"].map((what) => `createRetryAfter${what}`),
        ...["createFixFirst", "createPlaceFirst", "createDepictionFirst", "createLooksRightHint", "createSaveHint"],
      ];
      assert.deepEqual(
        needed.filter((key) => !keys.has(key)),
        []
      );
    });
  }
});

describe("the touch-up started without a press", () => {
  const offer = { mode: "touchup", image: "original", reasons: ["teeth_showing"] };
  const offered = (extra = {}) => creation({ ai: ai({ auto_adjust: offer }), ...extra });

  it("starts what the server offers, on the member's own consent", () => {
    assert.deepEqual(autoAdjustToStart(offered(), "consent-1", new Set()), offer);
  });
  it("never asks for consent on the member's behalf, nor guesses while it loads", () => {
    assert.equal(autoAdjustToStart(offered(), null, new Set()), null);
    assert.equal(autoAdjustToStart(offered(), undefined, new Set()), null);
  });
  it("waits for a running job, and starts once per image in a tab", () => {
    assert.equal(
      autoAdjustToStart(offered({ job: job({ step: "background", state: "running" }) }), "c", new Set()),
      null
    );
    const started = new Set([autoAdjustKey(offered(), offer)]);
    assert.equal(autoAdjustToStart(offered(), "c", started), null);
    const other = { ...offer, image: "cutout" };
    assert.deepEqual(autoAdjustToStart(creation({ ai: ai({ auto_adjust: other }) }), "c", started), other);
  });
  it("does nothing without an offer, or once the creation is being built", () => {
    assert.equal(autoAdjustToStart(creation(), "c", new Set()), null);
    assert.equal(autoAdjustToStart(offered({ status: "finishing" }), "c", new Set()), null);
  });
});

describe("cut-outs", () => {
  const steps = [
    step("original"),
    step("framed", { from: "original" }),
    step("cutout", { from: "framed", cutout: true }),
    adjustedStep(0, { from: "cutout", cutout: true }), // a touch-up of the cut-out
    adjustedStep(1, { from: "cutout", adjust: { ...adjustedStep(1).adjust, mode: "regenerate" } }),
    step("cutout:1", { from: "adjusted:1", cutout: true }),
  ];
  it("names the cut-out of each image", () => {
    assert.equal(cutoutIdFor("framed"), "cutout");
    assert.equal(cutoutIdFor("adjusted:7"), "cutout:7");
    assert.ok(isCutoutId("cutout") && isCutoutId("cutout:3"));
    assert.ok(!isCutoutId("adjusted:3") && !isCutoutId(null));
    assert.equal(cutoutOf(creation({ steps }), "adjusted:1")?.id, "cutout:1");
    assert.equal(cutoutOf(creation({ steps }), "adjusted:0"), null);
    // "cutout" was cut from the framed photo, not from the original.
    assert.equal(cutoutOf(creation({ steps }), "original"), null);
  });
  it("counts a touch-up of a cut-out as transparent", () => {
    assert.ok(isTransparent(steps[3]));
    assert.ok(!isTransparent(steps[4]));
    assert.ok(isTransparent(steps[5]));
    assert.ok(!isTransparent(null));
  });
  it("finds the opaque image behind the current one", () => {
    assert.equal(backgroundSource(creation({ steps, current: "cutout:1" }))?.id, "adjusted:1");
    // Through the touch-up and its cut-out, as "Keep original" goes.
    assert.equal(backgroundSource(creation({ steps, current: "adjusted:0" }))?.id, "framed");
    assert.equal(backgroundSource(creation({ steps, current: "adjusted:1" }))?.id, "adjusted:1");
  });
  it("shares a pixel frame between an image and its cut-out, never with an AI result", () => {
    assert.equal(frameOf(creation({ steps, current: "cutout:1" })), "adjusted:1");
    assert.equal(frameOf(creation({ steps, current: "cutout" })), "framed");
    assert.equal(frameOf(creation({ steps, current: "adjusted:0" })), "adjusted:0");
    const marked = creation({ steps, current: "cutout:1", anchors: anchors({ image: "adjusted:1" }) });
    assert.ok(anchorsCurrent(marked));
    assert.ok(!anchorsCurrent({ ...marked, current: "cutout" }));
  });
});

describe("AI adjust", () => {
  const round = (extra = {}) => ({
    mode: "touchup",
    style: null,
    source: "cutout",
    limit_reached: false,
    candidates: [
      { step: "adjusted:0", ok: true, reason: null, generated_eyes: true },
      { step: null, ok: false, reason: { code: "safety_refused", detail: "" }, generated_eyes: false },
    ],
    ...extra,
  });
  const steps = [
    step("original"),
    step("cutout", { from: "original", cutout: true }),
    adjustedStep(0, { from: "cutout", cutout: true }),
    adjustedStep(1, { from: "cutout" }),
    step("cutout:1", { from: "adjusted:1", cutout: true }),
  ];
  const recommendation = (extra = {}) => ({ image: "cutout", mode: "touchup", reasons: ["eyes_closed"], ...extra });
  const analysed = (extra = {}) =>
    creation({
      current: "cutout",
      steps,
      analysis: { checks: [], recommendation: recommendation() },
      ai: ai({ suggested: ["touchup"] }),
      ...extra,
    });

  it("shows a recommendation only for the image it was made on", () => {
    assert.deepEqual(recommendationOf(analysed()), recommendation());
    assert.equal(recommendationOf(analysed({ current: "adjusted:0" })), null);
    assert.equal(recommendationOf(creation()), null);
  });
  it("pre-selects the recommended fix, and nothing when nothing needs fixing", () => {
    assert.equal(preselectedMode(analysed()), "touchup");
    assert.equal(preselectedMode(analysed({ ai: ai({ suggested: [] }) })), null);
    // Not offered on this line, or AI switched off: nothing to pre-select.
    assert.equal(preselectedMode(analysed({ ai: ai({ suggested: ["touchup"], modes: ["regenerate"] }) })), null);
    assert.equal(preselectedMode(analysed({ ai: ai({ suggested: ["touchup"], enabled: false }) })), null);
  });
  it("offers the line's modes in a fixed order, none with AI off", () => {
    assert.deepEqual(adjustModes(creation({ ai: ai({ modes: ["regenerate", "touchup"] }) })), [
      "touchup",
      "regenerate",
    ]);
    assert.deepEqual(adjustModes(creation({ ai: ai({ enabled: false }) })), []);
  });
  it("lays out the last round, pictures and refusals alike", () => {
    const c = analysed({ ai: ai({ last_round: round() }) });
    assert.equal(roundSource(c)?.id, "cutout");
    const results = roundResults(c);
    assert.equal(results.length, 2);
    assert.equal(results[0].step?.id, "adjusted:0");
    assert.equal(results[1].step, null);
    // The round's "before" can be gone (a new framing drops it).
    assert.equal(roundSource(creation({ ai: ai({ last_round: round() }) })), null);
  });
  it("knows which version is on screen, through its cut-out", () => {
    const c = analysed({ current: "cutout:1" });
    assert.equal(aiResultInUse(c)?.id, "adjusted:1");
    assert.ok(inUse(c, "adjusted:1"));
    assert.ok(!inUse(c, "adjusted:0"));
    assert.equal(aiResultInUse(analysed()), null);
    assert.equal(aiResultInUse(analysed({ current: "adjusted:0" }))?.id, "adjusted:0");
  });
  it("keeps my photo by choosing what the round was made from, or nothing when it is on screen", () => {
    const withRound = (extra) => analysed({ ai: ai({ last_round: round() }), ...extra });
    assert.equal(keepChoice(withRound({ current: "cutout" })), null);
    assert.equal(keepChoice(withRound({ current: "adjusted:0" })), "cutout");
    assert.equal(keepChoice(withRound({ current: "cutout:1" })), "cutout");
    // An opaque "before" comes back as its cut-out when the background is off.
    const opaque = (extra) =>
      analysed({ ai: ai({ last_round: round({ source: "original" }) }), current: "cutout:1", ...extra });
    assert.equal(keepChoice(opaque({ background: "remove" })), "cutout");
    assert.equal(keepChoice(opaque({ background: "keep" })), "original");
    assert.equal(keepChoice(opaque({ current: "cutout" })), null);
    assert.equal(keepChoice(analysed()), null);
  });
  it("discloses an AI edit through cut-outs, and a generated original", () => {
    const c = analysed({ current: "cutout:1" });
    assert.deepEqual(aiEditOf(c), { mode: "touchup", model: "gemini-3.1-flash-image", generated_eyes: false });
    assert.equal(aiEditOf(analysed()), null);
    const generated = creation({
      steps: [
        step("original", { generated: { model: "m", style: "anime", provider: "gemini" } }),
        step("framed", { from: "original" }),
      ],
      current: "framed",
    });
    assert.deepEqual(aiEditOf(generated), { mode: "generate", model: "m", generated_eyes: false });
  });
});

describe("AI points", () => {
  const offer = (line, anchorsExtra = {}, aiExtra = {}) =>
    aiPointsOffer(creation({ face_type: line, ai: ai(aiExtra) }), {
      detected: false,
      source: "template",
      ...anchorsExtra,
    });
  it("is offered where the detector cannot see: animals, and animations it missed", () => {
    assert.equal(offer("animal"), "offer");
    assert.equal(offer("cartoon"), "offer");
    assert.equal(offer("cartoon", { detected: true, source: "mediapipe" }), null);
    assert.equal(offer("human"), null);
  });
  it("is not offered twice, nor with AI off; says so once the look is spent", () => {
    assert.equal(offer("animal", { source: "ai" }), null);
    assert.equal(offer("animal", {}, { enabled: false }), null);
    assert.equal(offer("animal", {}, { ai_detections_left: 0 }), "spent");
  });
});

describe("the uploader's statement", () => {
  it("is the one the server names, whatever line the creation is on now", () => {
    assert.equal(statementNeeded(creation({ face_type: "cartoon", statement: "depiction" })), "depiction");
    assert.equal(statementNeeded(creation({ statement: "generated_face" })), "generated_face");
    assert.equal(statementNeeded(creation({ face_type: "human", statement: null })), null);
  });
  it("falls back to asking every person, and only a person, from a server that does not say", () => {
    assert.equal(statementNeeded(creation({ face_type: "human" })), "depiction");
    assert.equal(statementNeeded(creation({ face_type: null })), "depiction");
    assert.equal(statementNeeded(creation({ face_type: "animal" })), null);
  });
});

describe("building the avatar", () => {
  const running = (label, extra = {}) =>
    job({ step: "finish", state: "running", progress: { fraction: 0.65, label }, ...extra });

  it("names the stage a finish is at, a person's mouth among them", () => {
    assert.equal(finishStage(running("copying images")), "copy");
    assert.equal(finishStage(running("building the rig")), "rig");
    assert.equal(finishStage(running("building layers")), "layers");
    assert.equal(finishStage(running("making the mouth shapes")), "shapes");
    assert.equal(finishStage(running("fitting the mouth")), "fit");
    assert.equal(finishStage(running("making the teeth")), "teeth");
    assert.equal(finishStage(running("publishing")), "publish");
    assert.deepEqual([...FINISH_STAGES], ["copy", "rig", "layers", "shapes", "fit", "teeth", "publish"]);
  });
  it("names nothing it does not know, nor for another job or a finish not running", () => {
    assert.equal(finishStage(running("polishing the chrome")), null);
    assert.equal(finishStage(running(null)), null);
    assert.equal(finishStage(job({ step: "finish", state: "running" })), null);
    assert.equal(finishStage(running("making the teeth", { state: "queued" })), null);
    assert.equal(finishStage(running("making the teeth", { state: "done" })), null);
    assert.equal(finishStage(running("making the teeth", { step: "adjust" })), null);
    assert.equal(finishStage(null), null);
  });
});

describe("step 5, counted", () => {
  const counted = (done, total = 6, extra = {}) =>
    job({
      step: "finish",
      state: "running",
      progress: { fraction: 0.7, label: "making the mouth shapes", count: { done, total } },
      ...extra,
    });

  it("reads how many of the six shapes are settled", () => {
    assert.deepEqual(stageCount(counted(0)), { done: 0, total: 6 });
    assert.deepEqual(stageCount(counted(3)), { done: 3, total: 6 });
    assert.deepEqual(stageCount(counted(6)), { done: 6, total: 6 });
  });
  it("shows no count that does not add up, nor one for a job not running", () => {
    assert.equal(stageCount(counted(7)), null);
    assert.equal(stageCount(counted(-1)), null);
    assert.equal(stageCount(counted(2, 0)), null);
    assert.equal(stageCount(counted(1.5)), null);
    assert.equal(stageCount(counted(3, 6, { state: "queued" })), null);
    assert.equal(stageCount(counted(3, 6, { state: "done", progress: null })), null);
    assert.equal(
      stageCount(job({ step: "finish", state: "running", progress: { fraction: 0.4, label: "building layers" } })),
      null
    );
    assert.equal(
      stageCount(job({ step: "finish", state: "running", progress: { fraction: 0.4, label: "x", count: null } })),
      null
    );
    assert.equal(stageCount(null), null);
  });
});

describe("step 5, listed", () => {
  const at = (label, extra = {}) =>
    job({ step: "finish", state: "running", progress: { fraction: 0.5, label }, ...extra });
  const rows = (list) => list.map((row) => `${row.phase}:${row.state}`);
  const seen = (...stages) => new Set(stages);

  it("lists a person's mouth ahead of time when it will be made", () => {
    assert.deepEqual(rows(finishRows(at("copying images"), true)), [
      "build:current",
      "shapes:pending",
      "fit:pending",
      "publish:pending",
    ]);
    assert.deepEqual(rows(finishRows(at("building the rig"), false)), ["build:current", "publish:pending"]);
  });
  it("counts the shapes on their own row, and on no other", () => {
    const list = finishRows(
      at("making the mouth shapes", {
        progress: { fraction: 0.7, label: "making the mouth shapes", count: { done: 3, total: 6 } },
      }),
      true
    );
    assert.deepEqual(rows(list), ["build:done", "shapes:current", "fit:pending", "publish:pending"]);
    assert.deepEqual(list[1].count, { done: 3, total: 6 });
    assert.deepEqual(
      list.filter((row) => row.count).map((row) => row.phase),
      ["shapes"]
    );
  });
  it("ticks the shapes once the mouth is being fitted, and everything before publishing", () => {
    assert.deepEqual(rows(finishRows(at("fitting the mouth"), true)), [
      "build:done",
      "shapes:done",
      "fit:current",
      "publish:pending",
    ]);
    assert.deepEqual(rows(finishRows(at("publishing"), true, seen("layers", "shapes"))), [
      "build:done",
      "shapes:done",
      "fit:done",
      "publish:current",
    ]);
  });
  it("lists the mouth the server makes even when this page did not expect it", () => {
    assert.deepEqual(rows(finishRows(at("making the mouth shapes"), false)), [
      "build:done",
      "shapes:current",
      "fit:pending",
      "publish:pending",
    ]);
  });
  it("puts the teeth alone in place of the shapes and their fitting", () => {
    assert.deepEqual(rows(finishRows(at("making the teeth"), true)), [
      "build:done",
      "teeth:current",
      "publish:pending",
    ]);
    assert.deepEqual(rows(finishRows(at("publishing"), true, seen("teeth"))), [
      "build:done",
      "teeth:done",
      "publish:current",
    ]);
  });
  it("never ticks a mouth nobody saw being made", () => {
    // Nothing of the mouth seen, and none expected: no mouth rows.
    assert.deepEqual(rows(finishRows(at("publishing"), false, seen("copy", "rig", "layers"))), [
      "build:done",
      "publish:current",
    ]);
  });
  it("never ticks a mouth that was not made: the server says so as it publishes", () => {
    // The kit broke after two of its seven calls: straight to publishing,
    // with the standard mouth. Neither the shapes nor their fitting is done.
    assert.equal(finishMouthStandard(at(PUBLISH_STANDARD_LABEL)), true);
    assert.equal(finishMouthStandard(at("publishing")), false);
    assert.deepEqual(rows(finishRows(at(PUBLISH_STANDARD_LABEL), true, seen("layers", "shapes"))), [
      "build:done",
      "shapes:skipped",
      "fit:skipped",
      "publish:current",
    ]);
    // Expected, but no AI was allowed after all (the monthly limit): the
    // rows listed ahead are not left pending, nor ticked.
    assert.deepEqual(rows(finishRows(at(PUBLISH_STANDARD_LABEL), true, seen("layers"))), [
      "build:done",
      "shapes:skipped",
      "fit:skipped",
      "publish:current",
    ]);
    assert.deepEqual(rows(finishRows(at(PUBLISH_STANDARD_LABEL), false, seen("layers"))), [
      "build:done",
      "publish:current",
    ]);
    assert.deepEqual(rows(finishRows(at(PUBLISH_STANDARD_LABEL), true, seen("teeth"))), [
      "build:done",
      "teeth:skipped",
      "publish:current",
    ]);
  });
  it("leaves every row pending while queued, or at a stage it does not know", () => {
    assert.deepEqual(rows(finishRows(job({ step: "finish", state: "queued" }), true)), [
      "build:pending",
      "shapes:pending",
      "fit:pending",
      "publish:pending",
    ]);
    assert.deepEqual(rows(finishRows(at("polishing the chrome"), false)), ["build:pending", "publish:pending"]);
  });
  it("lists nothing for another job, or a finish that has ended", () => {
    assert.deepEqual(finishRows(at("building layers", { step: "detect" }), true), []);
    assert.deepEqual(finishRows(job({ step: "finish", state: "done" }), true), []);
    assert.deepEqual(finishRows(job({ step: "finish", state: "failed" }), true), []);
    assert.deepEqual(finishRows(null, true), []);
  });
  it("names every row it can list", () => {
    assert.deepEqual([...FINISH_PHASES], ["build", "shapes", "fit", "teeth", "publish"]);
  });
});

describe("the AI statement, asked at the finish", () => {
  it("for a person when AI is on and the member has not agreed to these words", () => {
    assert.equal(finishNeedsAiConsent(creation(), null), true);
  });
  it("not when they have, nor while it is not known yet", () => {
    assert.equal(finishNeedsAiConsent(creation(), "consent-1"), false);
    assert.equal(finishNeedsAiConsent(creation(), undefined), false);
  });
  it("not when the organization turned AI off, nor for a line whose mouth is drawn", () => {
    assert.equal(finishNeedsAiConsent(creation({ ai: ai({ enabled: false }) }), null), false);
    assert.equal(finishNeedsAiConsent(creation({ face_type: "animal" }), null), false);
    assert.equal(finishNeedsAiConsent(creation({ face_type: "cartoon" }), null), false);
  });
});

describe("a person's mouth, expected", () => {
  it("when the line is a person, AI is on and the member has agreed", () => {
    assert.equal(mouthExpected(creation(), "consent-1"), true);
  });
  it("not without the member's own consent, or while it loads", () => {
    assert.equal(mouthExpected(creation(), null), false);
    assert.equal(mouthExpected(creation(), undefined), false);
  });
  it("not when the organization turned AI off, nor for another line", () => {
    assert.equal(mouthExpected(creation({ ai: ai({ enabled: false }) }), "consent-1"), false);
    assert.equal(mouthExpected(creation({ face_type: "animal" }), "consent-1"), false);
    assert.equal(mouthExpected(creation({ face_type: "cartoon" }), "consent-1"), false);
    assert.equal(mouthExpected(creation({ face_type: null }), "consent-1"), false);
  });
});

describe("the mouth, before finishing", () => {
  const checked = (reasons, extra = {}) =>
    creation({ analysis: { checks: [], recommendation: { image: "original", mode: "touchup", reasons } }, ...extra });

  it("says what the finish answer will warn about", () => {
    assert.deepEqual(expectedMouthWarnings(checked(["eyes_closed", "teeth_showing"])), ["teeth_showing"]);
    assert.deepEqual(expectedMouthWarnings(checked(["mouth_open"])), ["mouth_open"]);
  });
  it("names an open mouth alone, as the server does", () => {
    assert.deepEqual(expectedMouthWarnings(checked(["mouth_open", "teeth_showing"])), ["mouth_open"]);
  });
  it("says nothing when the check found neither, or is about another image", () => {
    assert.deepEqual(expectedMouthWarnings(checked(["eyes_closed"])), []);
    assert.deepEqual(expectedMouthWarnings(checked(["teeth_showing"], { current: "cutout" })), []);
    assert.deepEqual(expectedMouthWarnings(creation()), []);
  });
  it("says nothing on a line whose mouth is drawn over the picture, as the server does", () => {
    // A realistic dog the landmarker read a "mouth" on: the muzzle is drawn.
    assert.deepEqual(expectedMouthWarnings(checked(["mouth_open"], { face_type: "animal" })), []);
    assert.deepEqual(expectedMouthWarnings(checked(["teeth_showing"], { face_type: "cartoon" })), []);
    assert.deepEqual(expectedMouthWarnings(checked(["mouth_open"], { face_type: null })), []);
  });
});

describe("the finish notice", () => {
  const warnings = [{ code: "teeth_showing", detail: "The lips are parted" }];

  it("reaches the avatar's page, for that avatar only, until dismissed", () => {
    const store = memoryStore();
    rememberFinishNotice(store, "av1", warnings);
    assert.deepEqual(finishNoticeFor(store, "av1"), { warnings });
    assert.equal(finishNoticeFor(store, "av2"), null);
    forgetFinishNotice(store, "av1");
    assert.equal(finishNoticeFor(store, "av1"), null);
  });
  it("is kept with no warnings: arriving from the wizard is itself news", () => {
    const store = memoryStore();
    rememberFinishNotice(store, "av1", []);
    assert.deepEqual(finishNoticeFor(store, "av1"), { warnings: [] });
  });
  it("lets nothing malformed through", () => {
    const store = memoryStore([
      [finishNoticeKey("bad"), "{"],
      [finishNoticeKey("none"), JSON.stringify({})],
      [
        finishNoticeKey("mixed"),
        JSON.stringify({ warnings: [null, 3, { code: 1 }, { code: "mouth_open" }, ...warnings] }),
      ],
    ]);
    assert.equal(finishNoticeFor(store, "bad"), null);
    assert.equal(finishNoticeFor(store, "none"), null);
    assert.deepEqual(finishNoticeFor(store, "mixed"), {
      warnings: [{ code: "mouth_open", detail: "" }, ...warnings],
    });
  });
  it("survives storage that is missing or throws", () => {
    const throwing = {
      length: 0,
      key: () => null,
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    rememberFinishNotice(throwing, "av1", warnings);
    forgetFinishNotice(throwing, "av1");
    assert.equal(finishNoticeFor(throwing, "av1"), null);
    rememberFinishNotice(null, "av1", warnings);
    assert.equal(finishNoticeFor(null, "av1"), null);
  });
});
