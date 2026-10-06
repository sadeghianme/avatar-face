/**
 * Creations as the API returns them, for the tests: each builder takes the
 * fields a case changes. Not a test itself; typed, so tsc reads it.
 */
type Loose = Record<string, unknown>;

export const step = (id: string, extra: Loose = {}) => ({
  id,
  url: `/api/storage/orgs/o/creations/c/${id}-abc.png?expires=1&signature=s`,
  width: 800,
  height: 1000,
  from: null,
  crop: null,
  roll: null,
  ...extra,
});
export const adjustedStep = (n: number, extra: Loose = {}) =>
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
export const job = (extra: Loose = {}) => ({
  id: "job1",
  step: "ingest",
  state: "done",
  error: null,
  started_at: "2026-09-25T10:00:00Z",
  progress: null,
  retryable: false,
  ...extra,
});
export const anchors = (extra: Loose = {}) => ({
  id: "a1",
  image: "original",
  image_size: [800, 1000],
  detected: true,
  marks: {},
  validation: { ok: true, reasons: [], warnings: [], detected: true, one_click: true },
  ...extra,
});
export const ai = (extra: Loose = {}) => ({
  enabled: true,
  modes: ["touchup", "stylise", "regenerate"],
  suggested: [],
  adjust_rounds_left: 2,
  ai_detections_left: 1,
  last_round: null,
  ...extra,
});
export const creation = (extra: Loose = {}) => ({
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
    getItem: (k: string) => (map.has(k) ? map.get(k) : null),
    setItem: (k: string, v: unknown) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
  };
}
