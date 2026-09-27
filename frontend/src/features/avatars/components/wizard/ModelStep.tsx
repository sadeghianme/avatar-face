import { useTranslation } from "react-i18next";

import { Face } from "@/features/avatars/components/wizard/Art";
import { MODELS, type AvatarModel } from "@/features/avatars/wizard";
import { Icon } from "@/components/ui/Icon";

/**
 * Step 1: a human avatar or an animal avatar. Two big cards; choosing one
 * is the step's one action and goes straight on. Each card is a button
 * named by its title and described by its line, so a screen reader hears
 * the same choice the eye sees. The last choice is marked (coming Back).
 */
export function ModelStep({
  chosen,
  onChoose,
}: {
  chosen: AvatarModel | null;
  onChoose: (model: AvatarModel) => void;
}) {
  const { t } = useTranslation();
  return (
    <ul className="grid grid-cols-2 gap-3 sm:gap-5">
      {MODELS.map((model) => (
        <li key={model}>
          <button
            type="button"
            onClick={() => onChoose(model)}
            aria-describedby={`model-hint-${model}`}
            aria-pressed={chosen === model}
            className={`group relative flex h-full w-full flex-col overflow-hidden rounded-3xl border bg-white text-start shadow-sm transition
              duration-200 hover:-translate-y-0.5 hover:border-brand-400 hover:shadow-lg focus-visible:outline-none
              focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 dark:bg-raised dark:shadow-none
              dark:focus-visible:ring-offset-ink motion-reduce:transition-none motion-reduce:hover:translate-y-0 ${
                chosen === model ? "border-brand-500 ring-1 ring-brand-500" : "border-gray-200 dark:border-line"
              }`}
          >
            <span className="relative block aspect-square w-full sm:aspect-[4/3] overflow-hidden bg-gradient-to-b from-brand-50 via-orange-50 to-white dark:from-[#2a1d12] dark:via-[#1f1711] dark:to-raised">
              {/* A soft halo behind the face. */}
              <span
                aria-hidden="true"
                className="absolute left-1/2 top-[58%] h-[78%] w-[62%] -translate-x-1/2 -translate-y-1/2 rounded-full bg-brand-200/60 blur-2xl dark:bg-brand-500/15"
              />
              <Face
                model={model}
                look="animation"
                className="absolute inset-x-0 bottom-0 mx-auto h-[92%] w-auto transition-transform duration-300 group-hover:scale-[1.04] motion-reduce:transition-none motion-reduce:group-hover:scale-100"
              />
            </span>
            <span className="flex flex-1 items-start justify-between gap-2 p-3 sm:p-5">
              <span className="min-w-0">
                <span className="block text-base font-semibold tracking-[-0.01em] sm:text-lg">{t(`wzModel_${model}`)}</span>
                <span id={`model-hint-${model}`} className="mt-1 block text-xs leading-snug text-gray-500 dark:text-gray-400 sm:text-sm">
                  {t(`wzModelHint_${model}`)}
                </span>
              </span>
              <span
                aria-hidden="true"
                className="mt-0.5 hidden h-8 w-8 shrink-0 place-items-center rounded-full bg-gray-100 text-gray-500 transition-colors group-hover:bg-brand-600 group-hover:text-white dark:bg-white/[0.06] dark:text-gray-300 sm:grid"
              >
                <Icon name="arrow" className="h-4 w-4 rtl:-scale-x-100" strokeWidth={2} />
              </span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
