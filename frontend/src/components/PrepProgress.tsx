import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type { Avatar } from "../lib/types";

const STALL_SECONDS = 60;

/**
 * Avatar-prep UX: step indicator (detect -> mesh+visemes -> preview),
 * elapsed seconds, stall detection at 60s with a Retry button.
 */
export function PrepProgress({
  avatar,
  onRetry,
}: {
  avatar: Avatar;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [avatar.id]);

  const stepIndex = avatar.status === "pending" ? 0 : avatar.status === "processing" ? 1 : 2;
  const steps = [t("prep.detect"), t("prep.rig"), t("prep.preview")];
  const stalled = elapsed >= STALL_SECONDS;

  return (
    <div className="card">
      <ol className="flex flex-col gap-3">
        {steps.map((label, i) => (
          <li key={label} className="flex items-center gap-3">
            <span
              className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ${
                i < stepIndex
                  ? "bg-emerald-500 text-white"
                  : i === stepIndex
                    ? "animate-pulse bg-brand-600 text-white"
                    : "bg-gray-200 text-gray-500 dark:bg-gray-700"
              }`}
            >
              {i < stepIndex ? "✓" : i + 1}
            </span>
            <span className={i === stepIndex ? "font-medium" : "text-gray-500"}>{label}</span>
          </li>
        ))}
      </ol>
      <p className="mt-4 text-sm text-gray-400">{t("prep.elapsed", { seconds: elapsed })}</p>
      {stalled && (
        <div className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-900/30 dark:text-amber-200">
          <p className="mb-2">{t("prep.stalled")}</p>
          <button className="btn-secondary" onClick={onRetry}>
            {t("retry")}
          </button>
        </div>
      )}
    </div>
  );
}
