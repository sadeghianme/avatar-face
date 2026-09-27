import { useTranslation } from "react-i18next";

import { SCREENS, type Screen } from "@/features/avatars/wizard";

/**
 * 1 Model · 2 Photo · 3 Prepare · 4 Publish: four slim bars, the ones
 * behind and the current one filled. Information only: the screen's own
 * Back button goes back (a step behind a creation is not a place to jump
 * to, it is a new start). On a phone only the current step is named;
 * screen readers hear every name, where it is, and which are done.
 */
export function ProgressHeader({ screen }: { screen: Screen }) {
  const { t } = useTranslation();
  const at = SCREENS.indexOf(screen);
  return (
    <nav aria-label={t("wzStepsLabel")} className="mb-6">
      <ol className="grid grid-cols-4 gap-2 sm:gap-3">
        {SCREENS.map((id, i) => {
          const done = i < at;
          const current = i === at;
          return (
            <li key={id} aria-current={current ? "step" : undefined} className="min-w-0">
              <span
                className={`block h-1.5 rounded-full transition-colors duration-300 ${
                  done || current ? "bg-brand-500" : "bg-gray-200 dark:bg-white/[0.08]"
                } ${current ? "motion-safe:animate-glow" : ""}`}
                aria-hidden="true"
              />
              <span
                className={`mt-2 flex items-center gap-1.5 text-xs sm:text-sm ${
                  current
                    ? "font-semibold text-gray-900 dark:text-white"
                    : done
                      ? "text-gray-600 dark:text-gray-300"
                      : "text-gray-400 dark:text-gray-500"
                }`}
              >
                <span className="sr-only">{t("wzStepN", { n: i + 1, total: SCREENS.length })} </span>
                <span aria-hidden="true" className="tabular-nums">
                  {i + 1}
                </span>
                <span className={`truncate ${current ? "" : "sr-only sm:not-sr-only"}`}>{t(`wzStep_${id}`)}</span>
                {done && <span className="sr-only"> ({t("wzStepDone")})</span>}
              </span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
