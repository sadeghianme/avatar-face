/**
 * The AI expression pictures as the owner is told about them, without a
 * browser: the job's stages, when to ask again, the five as the grid shows
 * them, the section's summary and the refusals' words. `npm test`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { CreationJob } from "@/features/avatars/creation";

import {
  EXPR_BATCH_POLL_MS,
  EXPR_POLL_MS,
  EXPR_STAGES,
  EXPRESSION_NAMES,
  type ExpressionsView,
  exprStage,
  isExprActive,
  pollEvery,
  refusalKey,
  SHOT_REASONS,
  shotReason,
  shotsView,
  summaryKey,
} from "./expressions.ts";

const job = (extra: Partial<CreationJob> = {}): CreationJob => ({
  id: "j1",
  step: "expression_kit",
  state: "running",
  error: null,
  started_at: "2026-10-11T10:00:00Z",
  progress: { fraction: 0.4, label: "making the expressions", count: { done: 2, total: 5 } },
  retryable: false,
  ...extra,
});

const view = (extra: Partial<ExpressionsView> = {}): ExpressionsView => ({
  ai: true,
  delivery: "now",
  kit: null,
  pending: false,
  manifest_url: null,
  picture_urls: {},
  job: null,
  ...extra,
});

describe("expressions", () => {
  it("names the five in the engine's order", () => {
    assert.deepEqual(EXPRESSION_NAMES, ["happy", "surprised", "concerned", "thinking", "serious"]);
  });

  it("reads the job's stage from the server's labels, and nothing it does not know", () => {
    assert.equal(exprStage(job()), "making");
    assert.equal(exprStage(job({ progress: { fraction: 0.9, label: "saving", count: null } })), "saving");
    assert.equal(exprStage(job({ progress: { fraction: 0.2, label: "sending the batch", count: null } })), "batch");
    assert.equal(exprStage(job({ progress: { fraction: 0.2, label: "dancing", count: null } })), null);
    assert.equal(exprStage(job({ progress: { fraction: 0.2, label: null, count: null } })), null);
    assert.equal(exprStage(job({ step: "mouth_kit" })), null);
    assert.equal(exprStage(job({ state: "done" })), null);
    assert.equal(exprStage(null), null);
    assert.deepEqual([...EXPR_STAGES], ["making", "saving", "batch"]);
  });

  it("asks again while a job runs, slowly while a batch is on its way, else not", () => {
    assert.equal(pollEvery(undefined), false);
    assert.equal(pollEvery(view()), false);
    assert.equal(pollEvery(view({ job: job() })), EXPR_POLL_MS);
    assert.equal(pollEvery(view({ job: job({ state: "queued" }) })), EXPR_POLL_MS);
    assert.equal(pollEvery(view({ pending: true })), EXPR_BATCH_POLL_MS);
    assert.equal(pollEvery(view({ job: job({ state: "done" }) })), false);
    assert.equal(isExprActive(job({ state: "failed" })), false);
  });

  it("shows each of the five, made with its picture or why it stays animated", () => {
    const kit = {
      id: "k",
      made_at: "2026-10-11T10:00:00Z",
      source: "panel" as const,
      model: "m",
      made: 2,
      calls: 5,
      shots: {
        happy: { status: "ok" as const, outcome: "generated", reason: null, smile: true },
        surprised: { status: "ok" as const, outcome: "generated", reason: null, smile: false },
        concerned: {
          status: "failed" as const,
          outcome: "rejected",
          reason: { code: "expression_not_reached", detail: "Not concerned" },
          smile: false,
        },
        thinking: {
          status: "failed" as const,
          outcome: "rejected",
          reason: { code: "something_new", detail: "A new reason" },
          smile: false,
        },
      },
    };
    const shots = shotsView(view({ kit, picture_urls: { happy: "https://h", surprised: "https://s" } }));
    assert.deepEqual(
      shots.map((s) => [s.name, s.made, s.pictureUrl, s.smile, s.reasonKey, s.reasonText]),
      [
        ["happy", true, "https://h", true, null, null],
        ["surprised", true, "https://s", false, null, null],
        ["concerned", false, null, false, "exprReason_notReached", null],
        ["thinking", false, null, false, null, "A new reason"],
        ["serious", false, null, false, null, null],
      ]
    );
    assert.equal(shotsView(undefined).length, 5);
  });

  it("words the reasons by kind", () => {
    assert.equal(shotReason("safety_refused"), "declined");
    assert.equal(shotReason("skin_tone_changed"), "changed");
    assert.equal(shotReason("image_limit_reached"), "stopped");
    assert.equal(shotReason("timeout"), "failed");
    assert.equal(shotReason("expression_not_reached"), "notReached");
    assert.equal(shotReason("unknown"), null);
    assert.equal(shotReason(null), null);
    assert.deepEqual([...SHOT_REASONS], ["declined", "notReached", "changed", "stopped", "failed"]);
  });

  it("sums the section up in a word", () => {
    assert.equal(summaryKey(undefined), "exprSummaryOff");
    assert.equal(summaryKey(view({ ai: false })), "exprSummaryOff");
    assert.equal(summaryKey(view()), "exprSummaryChosen");
    assert.equal(summaryKey(view({ pending: true })), "exprSummaryMaking");
    assert.equal(summaryKey(view({ job: job() })), "exprSummaryMaking");
    const kit = { id: "k", made_at: "", source: "publish" as const, model: null, made: 5, calls: 5, shots: {} };
    assert.equal(summaryKey(view({ kit })), "exprSummaryOn");
  });

  it("words the refusals it knows, and leaves the rest to the server", () => {
    assert.equal(refusalKey("third_party_ai_disabled"), "exprErr_disabled");
    assert.equal(refusalKey("image_limit_reached"), "exprErr_limit");
    assert.equal(refusalKey("imagegen_unavailable"), "exprErr_unavailable");
    assert.equal(refusalKey("not_a_person"), "exprErr_person");
    assert.equal(refusalKey("expressions_in_progress"), "exprErr_busy");
    assert.equal(refusalKey("consent_required"), null);
  });
});
