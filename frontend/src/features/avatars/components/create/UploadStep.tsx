import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { CropBox } from "@/features/avatars/components/CropBox";
import { JobProgress } from "@/features/avatars/components/create/JobProgress";
import { LinePicker } from "@/features/avatars/components/create/LinePicker";
import {
  ACCEPTED_TYPES,
  appliedFraming,
  checkFile,
  clampRoll,
  errorText,
  framingChanged,
  initialFraming,
  jobFailure,
  MAX_ROLL,
  normalizeCrop,
  stepById,
  type Creation,
  type Framing,
} from "@/features/avatars/creation";
import { Icon } from "@/components/ui/Icon";
import { Spinner } from "@/components/ui/Spinner";
import { ApiError, postFormWithProgress } from "@/lib/api";
import type { FaceType } from "@/lib/types";

/** Checks that are not news on the line chosen: "no human face" on a dog
 * is the reason it is a dog. */
const NOT_A_PROBLEM_FOR: Record<string, readonly FaceType[]> = {
  no_face: ["animal", "cartoon"],
  head_turned: ["animal"],
};

const KNOWN_CHECKS = new Set([
  "face_small", "face_at_edge", "head_turned", "low_resolution", "no_face", "blurry", "too_dark", "too_bright",
]);

/**
 * Step 1, before there is a creation: choose a photo. Type and size are
 * checked here so a file the server would refuse is never sent; the upload
 * reports its progress, and the creation it makes is handed up.
 */
export function DropZone({
  orgId,
  headingId,
  onCreated,
}: {
  orgId: string;
  headingId: string;
  onCreated: (creation: Creation, file: File) => void;
}) {
  const { t } = useTranslation();
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const upload = async (file: File) => {
    setError(null);
    const problem = checkFile(file);
    if (problem) {
      setError(errorText(t, problem, ""));
      return;
    }
    setProgress(0);
    try {
      const form = new FormData();
      form.append("file", file);
      const creation = await postFormWithProgress<Creation>(`/orgs/${orgId}/creations`, form, setProgress);
      onCreated(creation, file);
    } catch (err) {
      setProgress(null);
      setError(
        err instanceof ApiError
          ? errorText(t, err.code, err.detail, err.retryAfter)
          : t("error")
      );
    }
  };

  const busy = progress !== null;
  const open = () => !busy && input.current?.click();

  return (
    <div>
      <div
        role="button"
        tabIndex={busy ? -1 : 0}
        aria-disabled={busy}
        aria-labelledby={headingId}
        aria-describedby="drop-hint"
        className={`flex min-h-56 cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed px-6 py-10 text-center transition-colors
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
            dragging
              ? "border-brand-500 bg-brand-50 dark:bg-brand-700/10"
              : "border-gray-300 bg-white hover:border-brand-400 dark:border-line dark:bg-panel"
          }`}
        onClick={open}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            open();
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          if (!busy) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const file = e.dataTransfer.files[0];
          if (file && !busy) void upload(file);
        }}
      >
        <span className="grid h-12 w-12 place-items-center rounded-2xl bg-brand-50 text-brand-600 dark:bg-brand-500/10 dark:text-brand-300">
          {busy ? <Spinner className="h-6 w-6" /> : <Icon name="upload" className="h-6 w-6" />}
        </span>
        <p className="mt-3 font-medium text-gray-700 dark:text-gray-200">
          {busy ? t("createUploading") : t("dragOrClick")}
        </p>
        <p id="drop-hint" className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {t("createDropHint")}
        </p>
        <input
          ref={input}
          type="file"
          accept={ACCEPTED_TYPES.join(",")}
          className="hidden"
          tabIndex={-1}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = ""; // the same file again is a new attempt
            if (file) void upload(file);
          }}
        />
      </div>

      {progress !== null && (
        <div className="mt-4">
          <div
            className="h-2 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700"
            role="progressbar"
            aria-label={t("createUploading")}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress * 100)}
          >
            <div className="h-full bg-brand-600 transition-all" style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
          <p className="mt-1 text-end text-xs text-gray-500">{Math.round(progress * 100)}%</p>
        </div>
      )}
      {error && (
        <p role="alert" className="field-error mt-3 text-sm">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * Step 1 once the photo is in: while it is prepared, its progress; then the
 * photo with the suggested crop and level, the checks worth knowing, and
 * the line to build it as. Continue saves the framing and the line
 * together, and only what changed: re-sending the same framing would still
 * be a no-op on the server, but a different one drops the cut-out and the
 * points, so an accidental nudge should be visible before it costs that.
 */
export function FrameStep({
  creation,
  busy,
  onContinue,
  onRetry,
  onStartOver,
  onBack,
}: {
  creation: Creation;
  busy: string | null;
  onContinue: (change: { face_type?: FaceType; framing?: Framing }) => void;
  onRetry: () => void;
  onStartOver: () => void;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  if (stepById(creation, "original")) {
    // Keyed by the creation: the editor's state starts from the analysis,
    // which exists only once the original does.
    return (
      <FrameEditor
        key={creation.id}
        creation={creation}
        busy={busy}
        onContinue={onContinue}
        onStartOver={onStartOver}
        onBack={onBack}
      />
    );
  }
  // Still ingesting, or ingest failed.
  const job = creation.job;
  const failure = jobFailure(job);
  return (
    <div className="space-y-4">
      {job ? <JobProgress job={job} onRetry={onRetry} retrying={busy === "retry"} /> : <Spinner className="h-5 w-5" />}
      <div className="flex flex-wrap gap-3">
        <button type="button" className="btn-secondary min-h-11" onClick={onBack}>
          {t("createBack")}
        </button>
        {/* Also beside Retry: a retried ingest can still find its upload
            gone (upload_gone), and a new photo is the answer to both. */}
        {failure && (
          <button type="button" className={job?.retryable ? "btn-secondary min-h-11" : "btn-primary min-h-11"} onClick={onStartOver}>
            {t("createUseAnother")}
          </button>
        )}
      </div>
    </div>
  );
}

function FrameEditor({
  creation,
  busy,
  onContinue,
  onStartOver,
  onBack,
}: {
  creation: Creation;
  busy: string | null;
  onContinue: (change: { face_type?: FaceType; framing?: Framing }) => void;
  onStartOver: () => void;
  onBack: () => void;
}) {
  const { t, i18n } = useTranslation();
  const original = stepById(creation, "original")!;
  const [framing, setFraming] = useState<Framing>(() => initialFraming(creation));
  const [line, setLine] = useState<FaceType | null>(creation.face_type);
  // Until the owner picks, whatever the server has (the suggestion).
  const shownLine = line ?? creation.face_type;

  const analysis = creation.analysis;
  const suggested = analysis?.suggested_framing ?? null;
  const detectedRoll = analysis?.roll ?? null;
  const checks = (analysis?.checks ?? []).filter((check) =>
    shownLine
      ? !NOT_A_PROBLEM_FOR[check.code]?.includes(shownLine)
      : check.code !== "no_face" // asked about below instead
  );
  const noFace = analysis?.detector === "mediapipe" && !analysis.detected;

  const degrees = t("createDegrees", {
    value: new Intl.NumberFormat(i18n.language, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(
      framing.roll
    ),
  });
  // Said only while the suggestion is what the box shows.
  const showingSuggestion = suggested !== null && !framingChanged(framing, suggested);

  const continueStep = () => {
    const change: { face_type?: FaceType; framing?: Framing } = {};
    if (shownLine && shownLine !== creation.face_type) change.face_type = shownLine;
    const next = { crop: normalizeCrop(framing.crop), roll: clampRoll(framing.roll) };
    if (framingChanged(next, appliedFraming(creation))) change.framing = next;
    onContinue(change);
  };

  return (
    <div className="space-y-6">
      {checks.length > 0 && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          <p className="font-medium">{t("createChecksTitle")}</p>
          <ul className="mt-1 list-disc ps-5">
            {checks.map((check) => (
              <li key={check.code}>
                {KNOWN_CHECKS.has(check.code) ? t(`photoCheck_${check.code}`) : check.detail}
              </li>
            ))}
          </ul>
          <button type="button" className="btn-secondary mt-3" onClick={onStartOver} disabled={busy !== null}>
            {t("createUseAnother")}
          </button>
        </div>
      )}

      <section aria-labelledby="frame-heading">
        <h3 id="frame-heading" className="mb-1 text-base font-semibold">
          {t("createFrameTitle")}
        </h3>
        <p className="mb-3 text-[13px] text-gray-500 dark:text-gray-400">
          {showingSuggestion ? t("createFrameSuggested") : t("createFrameHint")}
        </p>
        <div className="mx-auto max-w-xl">
          <CropBox
            src={original.url}
            value={framing.crop}
            onChange={(crop) => setFraming((f) => ({ ...f, crop }))}
            turn={framing.roll}
          />
          <div className="mt-4">
            <div className="flex items-center justify-between gap-3">
              <label htmlFor="frame-level" className="label mb-0">
                {t("createLevel")}
              </label>
              <output htmlFor="frame-level" className="font-mono text-[13px] tabular-nums text-gray-600 dark:text-gray-300">
                {degrees}
              </output>
            </div>
            <input
              id="frame-level"
              type="range"
              min={-MAX_ROLL}
              max={MAX_ROLL}
              step={0.1}
              value={framing.roll}
              onChange={(e) => setFraming((f) => ({ ...f, roll: clampRoll(Number(e.target.value)) }))}
              aria-valuetext={degrees}
              aria-describedby="frame-level-hint"
              className="mt-2 w-full accent-brand-600"
            />
            <p id="frame-level-hint" className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {t("createLevelHint")}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {detectedRoll !== null && Math.abs(detectedRoll - framing.roll) > 0.05 && (
                <button
                  type="button"
                  className="btn-secondary px-3 py-1.5 text-xs"
                  onClick={() => setFraming((f) => ({ ...f, roll: clampRoll(detectedRoll) }))}
                >
                  {t("createLevelAuto")}
                </button>
              )}
              {suggested && (
                <button
                  type="button"
                  className="btn-secondary px-3 py-1.5 text-xs"
                  onClick={() => setFraming({ crop: suggested.crop, roll: suggested.roll })}
                >
                  {t("createFrameUseSuggestion")}
                </button>
              )}
              <button
                type="button"
                className="btn-secondary px-3 py-1.5 text-xs"
                onClick={() => setFraming({ crop: { x: 0, y: 0, w: 1, h: 1 }, roll: 0 })}
              >
                {t("createFrameWhole")}
              </button>
            </div>
          </div>
        </div>
      </section>

      <section aria-labelledby="line-heading">
        <h3 id="line-heading" className="sr-only">
          {t("createLineQuestion")}
        </h3>
        {noFace && !creation.face_type && (
          <p className="mb-3 text-sm text-gray-600 dark:text-gray-300">{t("createNoFaceAsk")}</p>
        )}
        <LinePicker
          value={shownLine}
          suggested={analysis?.suggested_face_type ?? null}
          onChange={setLine}
          disabled={busy !== null}
        />
      </section>

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="btn-secondary min-h-11" onClick={onBack} disabled={busy !== null}>
          {t("createBack")}
        </button>
        <button
          type="button"
          className="btn-primary min-h-11 px-5"
          onClick={continueStep}
          disabled={busy !== null || !shownLine}
        >
          {busy === "frame" ? <Spinner className="h-4 w-4" /> : null}
          {t("createContinue")}
        </button>
        {!shownLine && (
          <span className="text-xs text-gray-500 dark:text-gray-400">{t("createChooseLineFirst")}</span>
        )}
      </div>
    </div>
  );
}
