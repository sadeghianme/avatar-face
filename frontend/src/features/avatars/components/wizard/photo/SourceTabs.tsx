import { useId } from "react";

import { ChoiceCard } from "@/components/ui/ChoiceCard";
import { Icon } from "@/components/ui/Icon";
import type { PhotoStepState } from "@/features/avatars/hooks/usePhotoStep";
import { SOURCES } from "@/features/avatars/wizard";
import { useT } from "@/i18n";
import { cx } from "@/lib/cx";

/** Generate / Upload: two halves of one grey bar, the chosen one raised. */
const SOURCE_TAB = cx(
  "flex min-h-14 items-center justify-center gap-2.5 rounded-xl px-3 py-2.5 text-start transition",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:cursor-not-allowed disabled:opacity-50"
);
const SOURCE_TAB_ON = "bg-white shadow-sm ring-1 ring-black/5 dark:bg-raised dark:ring-white/10";
const SOURCE_TAB_OFF = "text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white";

/** How to start: a description with AI, or a photo (a radio group). */
export function SourceTabs({ step }: { step: PhotoStepState }) {
  const { t } = useT();
  const ids = useId();
  const { aiEnabled } = step;
  return (
    <div>
      <p id={`${ids}-source`} className="sr-only">
        {t("wzSourceLabel")}
      </p>
      <div
        role="radiogroup"
        aria-labelledby={`${ids}-source`}
        className="grid grid-cols-2 gap-1.5 rounded-2xl bg-gray-100 p-1.5 dark:bg-white/[0.05]"
      >
        {SOURCES.map((s) => {
          const disabled = s === "generate" && !aiEnabled;
          const on = s === step.form.source;
          return (
            <ChoiceCard
              key={s}
              look="custom"
              {...step.sourceRadio(s)}
              disabled={disabled}
              className={cx(SOURCE_TAB, on ? SOURCE_TAB_ON : SOURCE_TAB_OFF)}
            >
              <span
                aria-hidden="true"
                className={cx(
                  "grid h-9 w-9 shrink-0 place-items-center rounded-lg",
                  on ? "bg-brand-600 text-white" : "bg-white text-gray-500 dark:bg-white/[0.06] dark:text-gray-400"
                )}
              >
                <Icon name={s === "generate" ? "sparkles" : "upload"} className="h-[18px] w-[18px]" strokeWidth={1.9} />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold leading-tight">{t(`wzSource_${s}`)}</span>
                <span className="hidden text-xs text-gray-500 sm:block dark:text-gray-400">
                  {disabled ? t("wzAiOffBadge") : t(`wzSourceHint_${s}`)}
                </span>
              </span>
            </ChoiceCard>
          );
        })}
      </div>
      {!aiEnabled && <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">{t("wzAiOffGenerate")}</p>}
    </div>
  );
}
