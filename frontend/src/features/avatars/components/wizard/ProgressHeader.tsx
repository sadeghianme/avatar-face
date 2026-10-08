import { type Screen, SCREENS } from "@/features/avatars/wizard";
import { useT } from "@/i18n";
import { cx } from "@/lib/cx";

/**
 * 1 Model · 2 Photo · 3 Prepare · 4 Publish: four slim bars, the ones
 * behind and the current one filled, centred at the step list's own width.
 * Information only: the Back button in the action bar goes back (a step
 * behind a creation is not a place to jump to, it is a new start). On a
 * phone it folds to one line, "2 of 4 · Photo", over one thin bar.
 * Screen readers hear every name, where it is, and which are done.
 */
export function ProgressHeader({ screen }: { screen: Screen }) {
  const { t } = useT();
  const at = SCREENS.indexOf(screen);
  const total = SCREENS.length;
  return (
    <nav aria-label={t("wzStepsLabel")} className="mx-auto max-w-4xl py-3 sm:py-4">
      {/* Phone: one line and one bar. */}
      <div className="sm:hidden">
        <p className="text-xs font-medium text-gray-600 dark:text-gray-300">
          <span className="tabular-nums">{t("wzStepCompact", { n: at + 1, total, name: t(`wzStep_${screen}`) })}</span>
        </p>
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-gray-200 dark:bg-white/[0.08]" aria-hidden="true">
          <div
            className="h-full rounded-full bg-brand-500 transition-[width] duration-300 motion-reduce:transition-none"
            style={{ width: `${((at + 1) / total) * 100}%` }}
          />
        </div>
      </div>

      <ol className="hidden grid-cols-4 gap-3 sm:grid">
        {SCREENS.map((id, i) => {
          const done = i < at;
          const current = i === at;
          return (
            <li key={id} aria-current={current ? "step" : undefined} className="min-w-0">
              <span
                className={cx(
                  "block h-1.5 rounded-full transition-colors duration-300",
                  done || current ? "bg-brand-500" : "bg-gray-200 dark:bg-white/[0.08]",
                  current && "motion-safe:animate-glow"
                )}
                aria-hidden="true"
              />
              <span
                className={cx(
                  "mt-2 flex items-center gap-1.5 text-sm",
                  current
                    ? "font-semibold text-gray-900 dark:text-white"
                    : done
                      ? "text-gray-600 dark:text-gray-300"
                      : "text-gray-400 dark:text-gray-500"
                )}
              >
                <span className="sr-only">{t("wzStepN", { n: i + 1, total })} </span>
                <span aria-hidden="true" className="tabular-nums">
                  {i + 1}
                </span>
                <span className="truncate">{t(`wzStep_${id}`)}</span>
                {done && <span className="sr-only"> ({t("wzStepDone")})</span>}
              </span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
