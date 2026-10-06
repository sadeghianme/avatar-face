/**
 * The words for every code the wizard names: `npm test` (node --test). Node
 * runs this file as TypeScript by stripping its types, so it imports by file
 * name and uses no syntax that needs compiling.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  ADJUST_MODES,
  CANDIDATE_REASONS,
  DRAWN_REASONS,
  FINISH_PHASES,
  FINISH_STAGES,
  KNOWN_ERRORS,
  PHOTO_CHECKS,
  REGENERATE_REASONS,
  TOUCHUP_REASONS,
  WIZARD_STEPS,
} from "./creation/index.ts";
import { LINE_ORDER, LINES } from "./lines.ts";

describe("strings", () => {
  // Read as text: importing a locale would take a path that climbs out of
  // this feature, which the structure check forbids.
  const keysOf = (lang: string) =>
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
