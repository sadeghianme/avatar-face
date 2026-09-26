/**
 * The mouth kit as the owner is told about it, without a browser: the
 * Mouth panel's job, where the shapes and teeth come from, the words for
 * every reason, and what step 5 gave an avatar. `npm test` (node --test).
 * Node strips the types, so this imports the modules by their file names.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  canCompareShapes,
  droppedText,
  factNeedsAttention,
  factText,
  factWantsMore,
  heldKitJob,
  isKitActive,
  KIT_DROPPED_CODES,
  KIT_FAILURE_CODES,
  KIT_SHAPES,
  KIT_STAGES,
  KIT_TEETH_CODES,
  kitFailureText,
  kitJobKey,
  kitOutcome,
  kitStage,
  kitTeethReason,
  kitTeethText,
  MOUTH_REASON_CODES,
  preparedFacts,
  reasonText,
  rememberKitJob,
  SHAPE_REASON_CODES,
  shapesLabel,
  shapesView,
  standardShapeText,
  teethNoteText,
  WHOLE_MOUTH_CODES,
} from "./mouth-kit.ts";
import { mouthErrorKey, teethNoteKey, teethView } from "./teeth.ts";

// A translator that shows what it was asked: the key, and its options.
const t = (key: string, options?: Record<string, unknown>) =>
  options ? `${key}${JSON.stringify(options)}` : key;
const generateKey = (code: string) => mouthErrorKey(code, "generate");

const job = (extra = {}) => ({
  id: "kit-1",
  step: "mouth_kit",
  state: "running",
  error: null,
  started_at: "2026-09-26T10:00:00Z",
  progress: { fraction: 0.4, label: "making the mouth shapes", count: { done: 2, total: 6 } },
  retryable: false,
  ...extra,
});

const reason = (code: string, detail = `detail of ${code}`) => ({ code, detail });

const shapeList = (standard: Record<string, string> = {}) =>
  KIT_SHAPES.map((shape) => ({
    shape,
    provenance: shape in standard ? "retargeted" : "generated",
    reason: shape in standard ? reason(standard[shape]) : null,
  }));

const kit = (standard: Record<string, string> = {}, extra = {}) => {
  const shapes = shapeList(standard);
  const generated = shapes.filter((s) => s.provenance === "generated").length;
  return {
    state: "made",
    made_at: "2026-09-26T10:01:00Z",
    model: "gemini-3.1-flash-image",
    generated,
    retargeted: 6 - generated,
    shapes,
    teeth: { used: true, reason: null },
    dropped: null,
    ...extra,
  };
};

const mouth = (extra = {}) => ({
  renderer: "continuous",
  profile: {},
  has_oral_photo: true,
  teeth: { source: "ai", note: null },
  motion_url: "https://files.example/orgs/o/avatars/a/mouth-motion-1a2b.json?signature=s",
  kit: kit(),
  ...extra,
});

function memoryStore(entries: [string, string][] = []) {
  const map = new Map(entries);
  return {
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

describe("the Mouth panel's job", () => {
  it("names the stage it is at, the shapes counted, and nothing it does not know", () => {
    assert.equal(kitStage(job()), "shapes");
    assert.equal(kitStage(job({ progress: { fraction: 0.86, label: "fitting the mouth", count: null } })), "fit");
    assert.equal(kitStage(job({ progress: { fraction: 0.1, label: "making the teeth", count: null } })), "teeth");
    assert.equal(kitStage(job({ progress: { fraction: 1, label: "saving", count: null } })), "save");
    assert.equal(kitStage(job({ progress: { fraction: 0.5, label: "polishing", count: null } })), null);
    assert.equal(kitStage(job({ state: "queued" })), null);
    assert.equal(kitStage(job({ step: "finish" })), null);
    assert.equal(kitStage(null), null);
    assert.deepEqual([...KIT_STAGES], ["shapes", "fit", "teeth", "save"]);
  });

  it("runs while queued or running", () => {
    assert.equal(isKitActive(job({ state: "queued" })), true);
    assert.equal(isKitActive(job()), true);
    assert.equal(isKitActive(job({ state: "done" })), false);
    assert.equal(isKitActive(null), false);
  });

  it("follows a job that runs, whoever started it", () => {
    assert.deepEqual(kitOutcome(job(), "kit-1"), { kind: "running", job: job() });
    assert.equal(kitOutcome(job(), null)?.kind, "running");
    assert.equal(kitOutcome(job({ id: "kit-2" }), "kit-1")?.kind, "running");
  });

  it("says how the job this tab started ended", () => {
    assert.equal(kitOutcome(job({ state: "done", progress: null }), "kit-1")?.kind, "done");
    const failed = kitOutcome(
      job({ state: "failed", progress: null, error: reason("head_turned"), retryable: true }),
      "kit-1"
    );
    assert.deepEqual(failed?.kind === "failed" && failed.error, reason("head_turned"));
    // A failure with no error still says something went wrong.
    const bare = kitOutcome(job({ state: "failed", progress: null, error: null }), "kit-1");
    assert.equal(bare?.kind === "failed" && bare.error.code, "job_failed");
  });

  it("reads a job the server forgot, or replaced, as interrupted", () => {
    // A restart forgets jobs: GET answers null, or a later job's record.
    assert.deepEqual(kitOutcome(null, "kit-1"), { kind: "interrupted" });
    assert.deepEqual(kitOutcome(job({ id: "kit-0", state: "done", progress: null }), "kit-1"), { kind: "interrupted" });
    assert.deepEqual(kitOutcome(job({ state: "interrupted", progress: null }), "kit-1"), { kind: "interrupted" });
  });

  it("says nothing of a job this tab did not start once it has ended", () => {
    assert.equal(kitOutcome(job({ state: "done", progress: null }), null), null);
    assert.equal(kitOutcome(job({ state: "failed", progress: null, error: reason("timeout") }), null), null);
    assert.equal(kitOutcome(null, null), null);
  });

  it("keeps the job it started for this tab, per avatar, until told to forget", () => {
    const store = memoryStore();
    rememberKitJob(store, "av1", "kit-1");
    assert.equal(heldKitJob(store, "av1"), "kit-1");
    assert.equal(heldKitJob(store, "av2"), null);
    assert.equal(store.getItem(kitJobKey("av1")), "kit-1");
    rememberKitJob(store, "av1", null);
    assert.equal(heldKitJob(store, "av1"), null);
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
    rememberKitJob(throwing, "av1", "kit-1");
    assert.equal(heldKitJob(throwing, "av1"), null);
    rememberKitJob(null, "av1", "kit-1");
    assert.equal(heldKitJob(null, "av1"), null);
  });
});

describe("where the mouth shapes come from", () => {
  it("all six from the photo", () => {
    assert.deepEqual(shapesView(mouth()), { kind: "own", generated: 6, total: 6 });
    assert.equal(shapesLabel(t, shapesView(mouth())!), 'mouthShapesKind_own{"generated":6,"total":6}');
  });

  it("some from the photo, the rest standard with why", () => {
    const view = shapesView(mouth({ kit: kit({ th: "head_turned" }) }));
    assert.deepEqual(view, {
      kind: "mixed",
      generated: 5,
      total: 6,
      standard: [{ shape: "th", reason: reason("head_turned") }],
    });
    assert.equal(shapesLabel(t, view!), 'mouthShapesKind_mixed{"generated":5,"total":6,"standard":1}');
    assert.equal(
      standardShapeText(t, { shape: "th", reason: reason("head_turned") }),
      'mouthShapeStandardLine{"shape":"mouthShape_th","reason":"mouthReason_head_turned"}'
    );
    assert.equal(standardShapeText(t, { shape: "fv", reason: null }), "mouthShape_fv");
  });

  it("standard: none made, a kit with no shape of its own, or one dropped since", () => {
    assert.deepEqual(shapesView(mouth({ kit: null, motion_url: null })), {
      kind: "standard", kit: "none", standard: [], dropped: null,
    });
    const refused = Object.fromEntries(KIT_SHAPES.map((shape) => [shape, "safety_refused"]));
    const none = shapesView(mouth({ kit: kit(refused) }));
    assert.equal(none?.kind, "standard");
    assert.equal(none?.kind === "standard" && none.kit, "made");
    assert.equal(none?.kind === "standard" && none.standard.length, 6);
    const dropped = shapesView(mouth({
      motion_url: null,
      kit: kit({}, { state: "dropped", dropped: reason("picture_changed") }),
    }));
    assert.deepEqual(dropped, { kind: "standard", kit: "dropped", standard: [], dropped: reason("picture_changed") });
    assert.equal(shapesLabel(t, dropped!), "mouthShapesKind_standard");
    assert.equal(droppedText(t, dropped!), "mouthShapesDropped_picture_changed");
    // A dropped reason with no words of its own says nothing extra.
    assert.equal(droppedText(t, { ...dropped!, dropped: reason("new_reason") } as never), null);
    assert.equal(droppedText(t, none!), null);
  });

  it("trusts the list of shapes, and the counts only without one", () => {
    const counted = shapesView(mouth({ kit: kit({}, { shapes: [], generated: 4, retargeted: 2 }) }));
    assert.deepEqual(counted, { kind: "mixed", generated: 4, total: 6, standard: [] });
  });

  it("is nothing for the classic mouth", () => {
    assert.equal(shapesView(null), null);
    assert.equal(shapesView(mouth({ renderer: "classic" })), null);
  });

  it("is compared with the standard shapes only when some are the person's own", () => {
    assert.equal(canCompareShapes(mouth()), true);
    assert.equal(canCompareShapes(mouth({ kit: kit({ th: "head_turned", aa: "timeout" }) })), true);
    const all = Object.fromEntries(KIT_SHAPES.map((shape) => [shape, "timeout"]));
    assert.equal(canCompareShapes(mouth({ kit: kit(all) })), false);
    assert.equal(canCompareShapes(mouth({ motion_url: null })), false);
    assert.equal(canCompareShapes(mouth({ kit: null })), false);
    assert.equal(canCompareShapes(mouth({ renderer: "classic" })), false);
    assert.equal(canCompareShapes(null), false);
  });
});

describe("the kit's teeth", () => {
  it("says why its ee is not the teeth when the teeth do not say it", () => {
    const own = mouth({
      teeth: { source: "upload", note: null },
      kit: kit({}, { teeth: { used: false, reason: reason("owner_photo") } }),
    });
    assert.deepEqual(kitTeethReason(own, teethView(own)), reason("owner_photo"));
    assert.equal(kitTeethText(t, reason("owner_photo")), "mouthKitTeeth_owner_photo");
    // Earlier AI teeth kept, the new ee unusable.
    const kept = mouth({ kit: kit({}, { teeth: { used: false, reason: reason("mouth_teeth_unclear") } }) });
    assert.deepEqual(kitTeethReason(kept, teethView(kept)), reason("mouth_teeth_unclear"));
    assert.equal(
      kitTeethText(t, reason("mouth_teeth_unclear")),
      'mouthKitTeethNotUsed{"reason":"mouthReason_mouth_teeth_unclear"}'
    );
    // The photo removed since: standard teeth with no note of their own.
    const removed = mouth({
      has_oral_photo: false,
      teeth: undefined,
      kit: kit({}, { teeth: { used: false, reason: reason("teeth_removed") } }),
    });
    assert.deepEqual(kitTeethReason(removed, teethView(removed)), reason("teeth_removed"));
    assert.equal(kitTeethText(t, reason("teeth_removed")), "mouthKitTeeth_teeth_removed");
  });

  it("names the check a teeth photo failed, in the note and in the kit's own words", () => {
    // "Rejected" alone would not say whether the lips were too close or
    // the head moved: the server names the check it failed.
    const failed = { ...reason("teeth_photo_rejected"), reason: reason("head_moved") };
    assert.equal(
      teethNoteText(t, failed, teethNoteKey),
      'mouthTeethNote_teeth_photo_rejected_because{"reason":"mouthReason_head_moved"}'
    );
    assert.equal(
      kitTeethText(t, failed),
      'mouthKitTeethNotUsed{"reason":"mouthReason_head_moved"}'
    );
    // Without a check it knows, the note's own words.
    assert.equal(teethNoteText(t, reason("teeth_photo_rejected"), teethNoteKey),
                 "mouthTeethNote_teeth_photo_rejected");
    assert.equal(
      teethNoteText(t, { ...reason("teeth_photo_rejected"), reason: reason("brand_new") }, teethNoteKey),
      "mouthTeethNote_teeth_photo_rejected"
    );
    assert.equal(teethNoteText(t, reason("no_ai_consent"), teethNoteKey), "mouthTeethNote_no_ai_consent");
    assert.equal(teethNoteText(t, reason("brand_new", "As sent"), teethNoteKey), "mouthTeethGeneric As sent");
    // A consent that could not be recorded sent nothing, and says so.
    assert.equal(teethNoteText(t, reason("consent_not_recorded"), teethNoteKey),
                 "mouthTeethNote_consent_not_recorded");
  });

  it("leaves it to the teeth note, and says nothing when the ee is the teeth", () => {
    const noted = mouth({
      has_oral_photo: false,
      teeth: { source: null, note: reason("teeth_photo_rejected") },
      kit: kit({}, { teeth: { used: false, reason: reason("teeth_photo_rejected") } }),
    });
    assert.equal(kitTeethReason(noted, teethView(noted)), null);
    assert.equal(kitTeethReason(mouth(), teethView(mouth())), null);
    const dropped = mouth({ kit: kit({}, { state: "dropped", teeth: { used: false, reason: reason("owner_photo") } }) });
    assert.equal(kitTeethReason(dropped, teethView(dropped)), null);
    assert.equal(kitTeethReason(mouth({ kit: null }), null), null);
  });
});

describe("reasons and failures, in words", () => {
  it("words every reason a shape is standard, and shows the server's for others", () => {
    for (const code of MOUTH_REASON_CODES) assert.equal(reasonText(t, reason(code)), `mouthReason_${code}`);
    assert.equal(reasonText(t, reason("brand_new", "Something new")), "Something new");
    assert.equal(reasonText(t, null), "");
  });

  it("says none of the shapes could be made, and why", () => {
    assert.equal(
      kitFailureText(t, reason("head_turned"), generateKey),
      'mouthKitErr_none{"reason":"mouthReason_head_turned"}'
    );
    // A switch turned off mid-kit: some calls may have gone, so not "nothing was sent".
    assert.equal(
      kitFailureText(t, reason("third_party_ai_disabled"), generateKey),
      'mouthKitErr_none{"reason":"mouthReason_third_party_ai_disabled"}'
    );
  });

  it("words the teeth alone as the teeth", () => {
    assert.equal(kitFailureText(t, reason("safety_refused"), generateKey, true), "mouthErr_safety_refused");
    assert.equal(
      kitFailureText(t, reason("mouth_teeth_unclear"), generateKey, true),
      "mouthErr_generate_mouth_teeth_unclear"
    );
    // Codes only the teeth alone can have need no hint.
    assert.equal(kitFailureText(t, reason("reference_no_face"), generateKey), "mouthErr_generate_reference_no_face");
    assert.equal(kitFailureText(t, reason("no_face_for_teeth"), generateKey), "mouthErr_no_face_for_teeth");
  });

  it("words the job's own failures, and the rest as the mouth routes do", () => {
    for (const code of KIT_FAILURE_CODES) assert.equal(kitFailureText(t, reason(code), generateKey), `mouthKitErr_${code}`);
    assert.equal(kitFailureText(t, reason("landmarks_unavailable"), generateKey), "mouthErr_landmarks_unavailable");
    assert.equal(kitFailureText(t, reason("source_gone"), generateKey), "mouthErr_source_gone");
    assert.equal(kitFailureText(t, reason("brand_new", "A new failure"), generateKey), "A new failure");
    assert.equal(kitFailureText(t, reason("brand_new", ""), generateKey), "error");
  });
});

describe("what step 5 gave the avatar", () => {
  const facts = (m: ReturnType<typeof mouth> | null) => preparedFacts(m as never, teethView(m as never));

  it("its own shapes and teeth: a summary, nothing to fix", () => {
    const list = facts(mouth());
    assert.deepEqual(list.map((fact) => factText(t, fact, teethNoteKey)), [
      'finishNoticeShapes_own{"total":6}',
      "finishNoticeTeeth_ai",
    ]);
    assert.equal(list.some(factNeedsAttention), false);
    assert.equal(list.some(factWantsMore), false);
  });

  it("some shapes standard: said, and worth trying again, but not a warning", () => {
    const list = facts(mouth({ kit: kit({ th: "head_turned", fv: "pose_not_reached" }) }));
    assert.equal(factText(t, list[0], teethNoteKey), 'finishNoticeShapes_mixed{"generated":4,"total":6}');
    assert.equal(list.some(factNeedsAttention), false);
    assert.equal(list.some(factWantsMore), true);
  });

  it("no shape made: standard, and why", () => {
    const refused = Object.fromEntries(KIT_SHAPES.map((shape) => [shape, "safety_refused"]));
    const list = facts(mouth({
      has_oral_photo: false,
      teeth: { source: null, note: reason("safety_refused") },
      kit: kit(refused, { teeth: { used: false, reason: reason("safety_refused") } }),
    }));
    assert.deepEqual(list.map((fact) => factText(t, fact, teethNoteKey)), [
      'finishNoticeShapes_none{"reason":"mouthReason_safety_refused"}',
      "mouthTeethNote_safety_refused",
    ]);
    assert.equal(list.every(factNeedsAttention), true);
  });

  it("nothing made because no AI was allowed: one sentence for both", () => {
    for (const code of WHOLE_MOUTH_CODES) {
      const list = facts(mouth({
        has_oral_photo: false, motion_url: null, kit: null, teeth: { source: null, note: reason(code) },
      }));
      assert.deepEqual(list, [{ kind: "both_standard", reason: reason(code) }]);
      assert.equal(factText(t, list[0], teethNoteKey), `finishNoticeStandard_${code}`);
      assert.equal(factNeedsAttention(list[0]), true);
      assert.equal(factWantsMore(list[0]), true);
    }
  });

  it("teeth alone where the shapes cannot be made: each said on its own", () => {
    const list = facts(mouth({ kit: null, motion_url: null }));
    assert.deepEqual(list.map((fact) => factText(t, fact, teethNoteKey)), [
      "finishNoticeShapes_standard",
      "finishNoticeTeeth_ai",
    ]);
    const failed = facts(mouth({
      kit: null, motion_url: null, has_oral_photo: false, teeth: { source: null, note: reason("face_turned") },
    }));
    assert.deepEqual(failed.map((fact) => factText(t, fact, teethNoteKey)), [
      "finishNoticeShapes_standard",
      "mouthTeethNote_face_turned",
    ]);
  });

  it("the teeth note as the server said it when nothing here words it", () => {
    const list = facts(mouth({
      kit: null, motion_url: null, has_oral_photo: false, teeth: { source: null, note: reason("new_code", "Why.") },
    }));
    assert.equal(factText(t, list[1], teethNoteKey), "mouthTeethGeneric Why.");
  });

  it("a kit dropped since says why", () => {
    const list = facts(mouth({ motion_url: null, kit: kit({}, { state: "dropped", dropped: reason("picture_changed") }) }));
    assert.equal(factText(t, list[0], teethNoteKey), "mouthShapesDropped_picture_changed");
  });

  it("the owner's own teeth are theirs, not the AI's", () => {
    const list = facts(mouth({ teeth: { source: "upload", note: null } }));
    assert.equal(factText(t, list[1], teethNoteKey), "finishNoticeTeeth_upload");
    assert.equal(factWantsMore(list[1]), false);
  });

  it("is nothing for the classic mouth", () => {
    assert.deepEqual(facts(mouth({ renderer: "classic" })), []);
    assert.deepEqual(facts(null), []);
  });
});

describe("the words exist", () => {
  const keysOf = (lang: string) =>
    new Set(
      [...readFileSync(new URL(`../../i18n/locales/${lang}/avatars.ts`, import.meta.url), "utf8")
        .matchAll(/^\s{2}([A-Za-z0-9_]+):\s/gm)].map((m) => m[1])
    );
  for (const lang of ["en", "fr"]) {
    it(`in ${lang}, for every shape, stage, reason and failure the kit names`, () => {
      const keys = keysOf(lang);
      const needed = [
        ...KIT_SHAPES.map((shape) => `mouthShape_${shape}`),
        ...KIT_STAGES.map((stage) => `mouthKitStage_${stage}`),
        ...MOUTH_REASON_CODES.map((code) => `mouthReason_${code}`),
        ...KIT_FAILURE_CODES.map((code) => `mouthKitErr_${code}`),
        ...KIT_DROPPED_CODES.map((code) => `mouthShapesDropped_${code}`),
        ...KIT_TEETH_CODES.map((code) => `mouthKitTeeth_${code}`),
        ...WHOLE_MOUTH_CODES.map((code) => `finishNoticeStandard_${code}`),
        ...["own", "mixed", "standard"].map((kind) => `mouthShapesKind_${kind}`),
        ...["own", "standard"].map((choice) => `mouthCompare_${choice}`),
        ...["own", "mixed", "none", "standard"].map((kind) => `finishNoticeShapes_${kind}`),
        ...["ai", "upload"].map((kind) => `finishNoticeTeeth_${kind}`),
        "mouthKitErr_none",
        "mouthKitTeethNotUsed",
        "mouthShapeStandardLine",
        "mouthShapesCount",
        "mouthKitMake",
        "mouthKitMakeShapes",
        "mouthKitMade",
        "mouthKitMadeTeeth",
        // Chosen by a condition, so the literal-key check cannot see them.
        "mouthKitHint",
        "mouthKitHintShapes",
        "mouthKitWorking",
        "mouthKitStage_shapesTeeth",
        "mouthShapesAiHint",
        "mouthShapesAiHintMixed",
        "mouthShapesStandardHint",
        "mouthTeethNote_teeth_photo_rejected_because",
        "finishNoticeTitle",
        "finishNoticePreparedTitle",
        "createFinishingHint",
        "createFinishingHintMouth",
        "createFinishingHintTeeth",
        "createPrepareMouth",
        "createPrepareTeeth",
      ];
      assert.deepEqual(needed.filter((key) => !keys.has(key)), []);
    });
  }

  it("reasons a shape is standard are a subset of every reason worded", () => {
    for (const code of SHAPE_REASON_CODES) assert.ok((MOUTH_REASON_CODES as readonly string[]).includes(code));
  });
});
