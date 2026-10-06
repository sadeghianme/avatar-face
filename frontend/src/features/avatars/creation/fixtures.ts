/**
 * Creations as the API returns them, for the tests: each builder takes the
 * fields a case changes. Not a test itself; typed, so tsc reads it (and the
 * tests that use it, tsconfig.test.json). Node runs it by stripping its
 * types: the imports are types only.
 */
import type { FaceMarks, RegionMarks } from "@/features/avatars/face-marks";

import type {
  Creation,
  CreationAi,
  CreationAnalysis,
  CreationAnchors,
  CreationJob,
  CreationStep,
  StepAdjust,
  StepId,
} from "./types.ts";

/** A region of the 800x1000 photo around (x, y), w wide and h high. */
const region = (x: number, y: number, w: number, h: number): RegionMarks => ({
  left: { x: x - w / 2, y },
  right: { x: x + w / 2, y },
  top: { x, y: y - h / 2 },
  bottom: { x, y: y + h / 2 },
});
/** The parts every line marks: a head and its two eyes. */
export const marks = (): FaceMarks => ({
  head: region(400, 500, 500, 700),
  left_eye: region(310, 420, 100, 40),
  right_eye: region(490, 420, 100, 40),
});

export const step = (id: StepId, extra: Partial<CreationStep> = {}): CreationStep => ({
  id,
  url: `/api/storage/orgs/o/creations/c/${id}-abc.png?expires=1&signature=s`,
  width: 800,
  height: 1000,
  from: null,
  crop: null,
  roll: null,
  ...extra,
});
export const adjust = (extra: Partial<StepAdjust> = {}): StepAdjust => ({
  mode: "touchup",
  style: null,
  model: "gemini-3.1-flash-image",
  generated_eyes: false,
  rejected: null,
  checks: { detected: true, fit_ok: true, skin_delta_e: 1.2 },
  ...extra,
});
export const adjustedStep = (n: number, extra: Partial<CreationStep> = {}): CreationStep =>
  step(`adjusted:${n}`, { from: "original", adjust: adjust(), ...extra });
export const job = (extra: Partial<CreationJob> = {}): CreationJob => ({
  id: "job1",
  step: "ingest",
  state: "done",
  error: null,
  started_at: "2026-09-25T10:00:00Z",
  progress: null,
  retryable: false,
  ...extra,
});
export const analysis = (extra: Partial<CreationAnalysis> = {}): CreationAnalysis => ({
  image_size: [800, 1000],
  detector: "mediapipe",
  detected: true,
  face_box: null,
  roll: 0,
  suggested_face_type: "human",
  suggested_framing: null,
  checks: [],
  ...extra,
});
export const anchors = (extra: Partial<CreationAnchors> = {}): CreationAnchors => ({
  id: "a1",
  image: "original",
  image_size: [800, 1000],
  detected: true,
  marks: marks(),
  validation: { ok: true, reasons: [], warnings: [], detected: true, one_click: true },
  ...extra,
});
export const ai = (extra: Partial<CreationAi> = {}): CreationAi => ({
  enabled: true,
  modes: ["touchup", "stylise", "regenerate"],
  suggested: [],
  adjust_rounds_left: 2,
  ai_detections_left: 1,
  last_round: null,
  ...extra,
});
export const creation = (extra: Partial<Creation> = {}): Creation => ({
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
/** A Web Storage stand-in: a Map with the four calls the drafts use. */
export function memoryStore(entries: [string, string][] = []) {
  const map = new Map(entries);
  return {
    map,
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: unknown) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
  };
}
