/**
 * The three avatar lines, as the creation wizard presents them.
 *
 * A line is configuration: what it is called, how it is explained, which
 * example stands for it, which points its owner places and whether the
 * background can be removed. The server decides the same things for
 * itself (services.creations.LINES) and is the authority; this table only
 * lets the wizard say so BEFORE asking, instead of offering a button the
 * server will refuse. The stored value `cartoon` is labelled "Animation".
 */
import type { MarkPart } from "@/features/avatars/creation";
import type { FaceType } from "@/lib/types";

export type LineExample = "portrait" | "animal" | "animation";

export interface LineConfig {
  id: FaceType;
  /** i18n keys. */
  label: string;
  summary: string;
  /** What to put where, for this line's marks. */
  guide: string;
  example: LineExample;
  /** The parts this line's owner marks, in the order the guide names them. */
  marks: readonly MarkPart[];
  /** Offered in step 2 (M3: the person segmenter, so people only). */
  backgroundRemoval: boolean;
  /** "Looks right" may finish on the detected marks. Never for an animal:
   * nothing detects one, so its marks are always a template's guess. */
  oneClick: boolean;
}

export const LINES: Record<FaceType, LineConfig> = {
  human: {
    id: "human",
    label: "faceType_human",
    summary: "lineSummary_human",
    guide: "createGuide_human",
    example: "portrait",
    marks: ["head", "left_eye", "right_eye", "mouth", "left_pupil", "right_pupil"],
    backgroundRemoval: true,
    oneClick: true,
  },
  animal: {
    id: "animal",
    label: "faceType_animal",
    summary: "lineSummary_animal",
    guide: "createGuide_animal",
    example: "animal",
    marks: ["head", "left_eye", "right_eye", "mouth_line", "chin"],
    backgroundRemoval: false,
    oneClick: false,
  },
  cartoon: {
    id: "cartoon",
    label: "faceType_cartoon",
    summary: "lineSummary_cartoon",
    guide: "createGuide_cartoon",
    example: "animation",
    marks: ["head", "left_eye", "right_eye", "mouth_line", "chin", "left_pupil", "right_pupil"],
    backgroundRemoval: false,
    oneClick: true,
  },
};

/** The order the choice is offered in. */
export const LINE_ORDER: readonly FaceType[] = ["human", "animal", "cartoon"];
