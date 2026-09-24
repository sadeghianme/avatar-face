import { useTranslation } from "react-i18next";

import {
  errorText,
  isJobActive,
  jobFailure,
  type CreationJob,
} from "@/features/avatars/creation";
import { Spinner } from "@/components/ui/Spinner";

/**
 * A creation job, drawn: what is happening and how far along, or why it
 * stopped and what to do about it.
 *
 * Not a live region itself: the wizard announces job changes from one
 * persistent region (see CreationWizard), because a region that is mounted
 * together with its text is not reliably read out.
 */
export function JobProgress({
  job,
  onRetry,
  retrying = false,
  children,
}: {
  job: CreationJob;
  onRetry?: () => void;
  retrying?: boolean;
  /** Extra actions beside Retry (for a failure nothing can retry). */
  children?: React.ReactNode;
}) {
  const { t } = useTranslation();

  if (isJobActive(job)) {
    const fraction = job.progress?.fraction ?? null;
    const label = job.state === "queued" ? t("createJobQueued") : t(`createJob_${job.step}`);
    return (
      <div className="rounded-xl border border-gray-200 bg-gray-50 p-4 dark:border-line dark:bg-white/[0.03]">
        <p className="flex items-center gap-2 text-sm font-medium">
          <Spinner className="h-4 w-4 shrink-0 text-brand-600" />
          {label}
        </p>
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

/** An error from one of the wizard's requests. */
export function ActionErrorNote({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <p role="alert" className="field-error mt-3 text-sm">
      {text}
    </p>
  );
}
