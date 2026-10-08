/**
 * Steps, jobs and the finish: `npm test` (node --test). Node runs this file
 * as TypeScript by stripping its types, so it imports by file name and uses
 * no syntax that needs compiling.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ai, analysis, creation, job } from "./fixtures.ts";
import type { AutoAdjust, Creation, CreationJob, FinishRow, FinishStage } from "./index.ts";
import {
  autoAdjustKey,
  autoAdjustToStart,
  expectedMouthWarnings,
  FINISH_PHASES,
  FINISH_POLL_MAX_MS,
  FINISH_STAGES,
  finishMouthStandard,
  finishNeedsAiConsent,
  finishRows,
  finishStage,
  isBusy,
  jobFailure,
  mouthExpected,
  pollDelay,
  PUBLISH_STANDARD_LABEL,
  stageCount,
} from "./index.ts";

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
    assert.equal(jobFailure(job({ state: "interrupted", error: null }))!.code, "interrupted");
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

describe("the touch-up started without a press", () => {
  const offer: AutoAdjust = { mode: "touchup", image: "original", reasons: ["teeth_showing"] };
  const offered = (extra: Partial<Creation> = {}) => creation({ ai: ai({ auto_adjust: offer }), ...extra });

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
    const other: AutoAdjust = { ...offer, image: "cutout" };
    assert.deepEqual(autoAdjustToStart(creation({ ai: ai({ auto_adjust: other }) }), "c", started), other);
  });
  it("does nothing without an offer, or once the creation is being built", () => {
    assert.equal(autoAdjustToStart(creation(), "c", new Set()), null);
    assert.equal(autoAdjustToStart(offered({ status: "finishing" }), "c", new Set()), null);
  });
});

describe("building the avatar", () => {
  const running = (label: string | null, extra: Partial<CreationJob> = {}) =>
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
  const counted = (done: number, total = 6, extra: Partial<CreationJob> = {}) =>
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
  const at = (label: string, extra: Partial<CreationJob> = {}) =>
    job({ step: "finish", state: "running", progress: { fraction: 0.5, label }, ...extra });
  const rows = (list: FinishRow[]) => list.map((row) => `${row.phase}:${row.state}`);
  const seen = (...stages: FinishStage[]) => new Set(stages);

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
  const checked = (reasons: string[], extra: Partial<Creation> = {}) =>
    creation({
      analysis: analysis({ checks: [], recommendation: { image: "original", mode: "touchup", reasons } }),
      ...extra,
    });

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
