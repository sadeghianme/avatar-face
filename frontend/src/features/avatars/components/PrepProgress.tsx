import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import type { Avatar } from "@/lib/types";

const STALL_SECONDS = 60;

/**
 * Avatar-prep UX: step indicator (detect -> mesh+visemes -> preview),
 * elapsed seconds, stall detection at 60s with a Retry button, and why a
 * retry was refused (`error`). For an avatar the rig job builds (an
 * upload, a re-detection); one the creation wizard's step 5 is preparing
 * is followed there instead (AvatarDetailPage).
 */
export function PrepProgress({
  avatar,
  onRetry,
  error = null,
}: {
  avatar: Avatar;
  onRetry: () => void;
  error?: string | null;
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
    <Card>
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
        <Banner
          appearance="soft"
          tone="warning"
          className="mt-3"
          actions={
            <Button variant="secondary" onClick={onRetry}>
              {t("retry")}
            </Button>
          }
          footer={
            error && (
              <p className="field-error mt-2" role="alert">
                {error}
              </p>
            )
          }
        >
          {t("prep.stalled")}
        </Banner>
      )}
    </Card>
  );
}
