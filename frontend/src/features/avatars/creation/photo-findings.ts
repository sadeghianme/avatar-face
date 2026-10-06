/** What the photo's analysis found, in the wizard's words (see index.ts). */
import type { FaceType } from "@/lib/types";

import type { CreationAnalysis, PhotoCheck } from "./types.ts";

/** Check codes with our own words (photoCheck_<code>); others show the
 * server's sentence. */
export const PHOTO_CHECKS: ReadonlySet<string> = new Set([
  "face_small",
  "face_at_edge",
  "head_turned",
  "low_resolution",
  "no_face",
  "blurry",
  "too_dark",
  "too_bright",
  "eyes_closed",
  "mouth_open",
  "eyes_half_closed",
  "gaze_off_camera",
  "teeth_showing",
  "head_tilted",
  // Warnings of an AI point search that fell back to the template.
  "ai_points_failed",
  "ai_no_face",
  "ai_points_implausible",
  "safety_refused",
  "vision_limit_reached",
]);

/** Checks that are not news on the line chosen: "no human face" on a dog
 * is the reason it is a dog. */
const NOT_A_PROBLEM_FOR: Record<string, readonly FaceType[]> = {
  no_face: ["animal", "cartoon"],
  head_turned: ["animal"],
};

/** The analysis' findings worth telling the owner of a `line` picture.
 * With no line chosen yet, "no human face" is left out: it is asked about
 * as a question (which line?) instead. */
export function photoFindings(analysis: CreationAnalysis | null | undefined, line: FaceType | null): PhotoCheck[] {
  return (analysis?.checks ?? []).filter((check) =>
    line ? !NOT_A_PROBLEM_FOR[check.code]?.includes(line) : check.code !== "no_face"
  );
}
