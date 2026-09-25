import { useTranslation } from "react-i18next";

import { WIZARD_STEPS, type WizardStep } from "@/features/avatars/creation";
import { Icon } from "@/components/ui/Icon";

const LABELS: Record<WizardStep, string> = {
  frame: "createStep_frame",
  background: "createStep_background",
  adjust: "createStep_adjust",
  points: "createStep_points",
  prepare: "createStep_prepare",
};

/**
 * 1 Upload · 2 Background · 3 AI adjust · 4 Points · 5 Prepare
 * (WIZARD_STEPS). Steps already passed are buttons back to them; the ones
 * ahead are not, since each step's Continue is what saves it and a jump
 * forward would skip that. Step 5 is reached only by finishing, and while
 * the avatar is built nothing behind it may be revisited (`locked`).
 */
export function StepIndicator({
  step,
  onGo,
  locked = false,
}: {
  step: WizardStep;
  onGo?: (step: WizardStep) => void;
  /** Nothing may be revisited (the avatar is being built). */
  locked?: boolean;
}) {
  const { t } = useTranslation();
  const at = WIZARD_STEPS.indexOf(step);
  return (
    <nav aria-label={t("createStepsLabel")} className="mb-6">
      {/* Five steps and the current one's name share a phone's width: the
          gaps and connectors are short there, and gone on the narrowest. */}
      <ol className="flex items-center gap-1 sm:gap-3">
        {WIZARD_STEPS.map((id, i) => {
          const done = i < at;
          const current = i === at;
          const badge = (
            <span
              className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs font-semibold ${
                current
                  ? "bg-brand-600 text-white"
                  : done
                    ? "bg-emerald-500 text-white"
                    : "bg-gray-200 text-gray-500 dark:bg-white/[0.08] dark:text-gray-400"
              }`}
              aria-hidden="true"
            >
              {done ? <Icon name="check" className="h-3.5 w-3.5" strokeWidth={2.5} /> : i + 1}
            </span>
          );
          const text = (
            <span
              className={`whitespace-nowrap text-[13px] sm:text-sm ${
                current ? "font-semibold" : "text-gray-500 dark:text-gray-400"
              }`}
            >
              <span className="sr-only">{t("createStepN", { n: i + 1, total: WIZARD_STEPS.length })} </span>
              {/* On a phone only the current step is named; the others are
                  their numbers, and screen readers still hear every name. */}
              <span className={current ? "" : "sr-only sm:not-sr-only"}>{t(LABELS[id])}</span>
              {done && <span className="sr-only"> ({t("createStepDone")})</span>}
            </span>
          );
          return (
            <li key={id} className="flex min-w-0 items-center gap-1 sm:gap-3" aria-current={current ? "step" : undefined}>
              {done && onGo && !locked ? (
                <button
                  type="button"
                  className="flex min-h-11 items-center gap-2 rounded-lg px-1 hover:bg-gray-100 focus-visible:outline-none
                    focus-visible:ring-2 focus-visible:ring-brand-500 dark:hover:bg-white/[0.06]"
                  onClick={() => onGo(id)}
                >
                  {badge}
                  {text}
                </button>
              ) : (
                <span className="flex min-h-11 items-center gap-2 px-1">
                  {badge}
                  {text}
                </span>
              )}
              {i < WIZARD_STEPS.length - 1 && (
                <span
                  className="hidden h-px w-2 shrink-0 bg-gray-300 min-[360px]:block sm:w-8 dark:bg-white/[0.15]"
                  aria-hidden="true"
                />
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
