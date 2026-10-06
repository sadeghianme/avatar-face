import { useRef } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "@/components/ui/Icon";
import { Spinner } from "@/components/ui/Spinner";
import {
  type CreationJob,
  errorText,
  type FinishRow,
  type FinishStage,
  finishStage,
  isJobActive,
  type JobCount,
  jobFailure,
} from "@/features/avatars/creation";

/**
 * A creation job, drawn: what is happening and how far along, or why it
 * stopped and what to do about it. A finish (step 5) lists its stages in
 * plain words, the one it is at among them.
 *
 * Not a live region itself: the wizard announces job changes from one
 * persistent region (see CreationWizard), because a region that is mounted
 * together with its text is not reliably read out.
 */
export function JobProgress({
  job,
  onRetry,
  retrying = false,
  rows,
  children,
}: {
  job: CreationJob;
  onRetry?: () => void;
  retrying?: boolean;
  /** A finish's checklist (creation.finishRows), from the step that knows
   * what the page expects and has seen. */
  rows?: FinishRow[];
  /** Extra actions beside Retry (for a failure nothing can retry). */
  children?: React.ReactNode;
}) {
  const { t } = useTranslation();

  if (isJobActive(job) && job.step === "finish" && rows) {
    return <FinishProgress job={job} rows={rows} />;
  }

  if (isJobActive(job)) {
    const fraction = job.progress?.fraction ?? null;
    const label = job.state === "queued" ? t("createJobQueued") : t(`createJob_${job.step}`);
    return (
      <div className="rounded-xl border border-gray-200 bg-gray-50 p-4 dark:border-line dark:bg-white/[0.03]">
        <p className="flex items-center gap-2 text-sm font-medium">
          <Spinner className="h-4 w-4 shrink-0 text-brand-600" />
          {label}
        </p>
        <ProgressBar fraction={fraction} label={label} />
      </div>
    );
  }

  const failure = jobFailure(job);
  if (!failure) return null;
  return (
    <div
      className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900
        dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
    >
      <p>{errorText(t, failure.code, failure.detail)}</p>
      {(job.retryable && onRetry) || children ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {job.retryable && onRetry && (
            <button type="button" className="btn-secondary" onClick={onRetry} disabled={retrying}>
              {retrying ? <Spinner className="h-4 w-4" /> : null}
              {t("retry")}
            </button>
          )}
          {children}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The stages of a finish this page has watched go by, for that job only
 * (creation.finishRows ticks a row only for work seen happening, never for
 * work the server may have had no AI for). A new job starts afresh.
 */
export function useSeenStages(job: CreationJob | null | undefined): ReadonlySet<FinishStage> {
  const seen = useRef<{ id: string | null; stages: Set<FinishStage> }>({ id: null, stages: new Set() });
  const id = job?.id ?? null;
  if (seen.current.id !== id) seen.current = { id, stages: new Set() };
  const stage = finishStage(job);
  // Adding what is on screen is the same on every render, so a render
  // that is thrown away changes nothing.
  if (stage) seen.current.stages.add(stage);
  return seen.current.stages;
}

/**
 * Building an avatar, as a checklist: "Building your avatar", then a
 * person's teeth and mouth shapes (counted: "3 of 7"), the mouth fitted to
 * them, and publishing (`rows`, creation.finishRows). The mouth is an
 * image-model call per shape and can take a minute: a bar that sits still
 * without a word looks stuck, and a list says what is left. A mouth that
 * was not made after all is shown as such ("skipped"), never ticked.
 */
function FinishProgress({ job, rows }: { job: CreationJob; rows: FinishRow[] }) {
  const { t } = useTranslation();
  const stage = finishStage(job);
  const label = t("createJob_finish");

  return (
    <div className="rounded-xl border border-gray-200 bg-gray-50 p-4 dark:border-line dark:bg-white/[0.03]">
      {job.state === "queued" && (
        <p className="mb-3 flex items-center gap-2 text-sm font-medium">
          <Spinner className="h-4 w-4 shrink-0 text-brand-600" />
          {t("createJobQueued")}
        </p>
      )}
      <ol className="space-y-3" aria-label={label}>
        {rows.map((row) => (
          <FinishRowItem key={row.phase} row={row} stage={stage} />
        ))}
      </ol>
      <ProgressBar fraction={job.progress?.fraction ?? null} label={label} />
    </div>
  );
}

// What the row the build is at says beneath its name: the part of the
// build under way, or where a person's mouth comes from.
function currentDetail(row: FinishRow, stage: FinishStage | null): string | null {
  if (row.phase === "build") return stage ? `createFinishStage_${stage}` : null;
  if (row.phase === "shapes" || row.phase === "teeth") return `createFinishPhaseHint_${row.phase}`;
  return null;
}

function FinishRowItem({ row, stage }: { row: FinishRow; stage: FinishStage | null }) {
  const { t } = useTranslation();
  const detail = row.state === "current" ? currentDetail(row, stage) : null;
  return (
    <li className="flex items-start gap-3" aria-current={row.state === "current" ? "step" : undefined}>
      <span className="mt-px grid h-5 w-5 shrink-0 place-items-center" aria-hidden="true">
        {row.state === "done" ? (
          <span className="grid h-5 w-5 place-items-center rounded-full bg-emerald-500 text-white">
            <Icon name="check" className="h-3 w-3" strokeWidth={3} />
          </span>
        ) : row.state === "skipped" ? (
          <span className="grid h-5 w-5 place-items-center">
            <span className="h-0.5 w-3 rounded-full bg-gray-400 dark:bg-white/30" />
          </span>
        ) : row.state === "current" ? (
          <Spinner className="h-5 w-5 text-brand-600 dark:text-brand-400" />
        ) : (
          <span className="h-4 w-4 rounded-full border-2 border-gray-300 dark:border-white/20" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <p
          className={`flex flex-wrap items-baseline gap-x-2.5 text-sm ${
            row.state === "current"
              ? "font-medium text-gray-900 dark:text-gray-100"
              : row.state === "done"
                ? "text-gray-700 dark:text-gray-300"
                : row.state === "skipped"
                  ? "text-gray-500 line-through decoration-gray-400/70 dark:text-gray-400"
                  : "text-gray-500 dark:text-gray-400"
          }`}
        >
          <span>
            {t(`createFinishPhase_${row.phase}`)}
            <span className="sr-only"> ({t(`createFinishPhaseState_${row.state}`)})</span>
          </span>
          {row.count && (
            <span className="text-[13px] font-semibold tabular-nums text-brand-700 dark:text-brand-300">
              {t("mouthShapesCount", { done: row.count.done, total: row.count.total })}
            </span>
          )}
        </p>
        {row.count && <ShapeTicks count={row.count} />}
        {detail && <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{t(detail)}</p>}
      </div>
    </li>
  );
}

/** One tick per mouth shape, filled once settled: the count, at a glance.
 * Decoration only: the words beside it say the same to a screen reader.
 * Step 5's and the Mouth panel's. */
export function ShapeTicks({ count }: { count: JobCount }) {
  return (
    <span className="mt-1.5 flex gap-1" aria-hidden="true">
      {Array.from({ length: count.total }, (_, i) => (
        <span
          key={i}
          className={`h-1.5 w-5 rounded-full transition-colors duration-300 motion-reduce:transition-none ${
            i < count.done ? "bg-brand-500" : "bg-gray-200 dark:bg-white/[0.1]"
          }`}
        />
      ))}
    </span>
  );
}

/** A job's bar: its fraction, or a pulse while it has none. */
export function ProgressBar({ fraction, label }: { fraction: number | null; label: string }) {
  return (
    <div
      className="mt-3 h-1.5 overflow-hidden rounded-full bg-gray-200 dark:bg-white/[0.08]"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={fraction === null ? undefined : Math.round(fraction * 100)}
    >
      <div
        className={`h-full rounded-full bg-brand-500 transition-[width] duration-500 motion-reduce:transition-none ${
          fraction === null ? "w-1/3 animate-pulse" : ""
        }`}
        style={fraction === null ? undefined : { width: `${Math.max(4, Math.round(fraction * 100))}%` }}
      />
    </div>
  );
}

/** An error from one of the wizard's requests. */
export function ActionErrorNote({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <p role="alert" className="field-error mt-3 text-sm">
      {text}
    </p>
  );
}
