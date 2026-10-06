import { useTranslation } from "react-i18next";

import { ChoiceCard } from "@/components/ui/ChoiceCard";
import { Icon } from "@/components/ui/Icon";
import { LookPicture } from "@/features/avatars/components/wizard/Art";
import { type AvatarModel, MODELS } from "@/features/avatars/wizard";
import { cx } from "@/lib/cx";

/** A big picture card that lifts on hover; ringed in the brand colour when chosen. */
const MODEL_CARD = cx(
  "group relative flex h-full w-full flex-col overflow-hidden rounded-3xl border bg-white text-start shadow-sm",
  "transition duration-200 hover:-translate-y-0.5 hover:border-brand-400 hover:shadow-lg",
  "motion-reduce:transition-none motion-reduce:hover:translate-y-0",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2",
  "dark:bg-raised dark:shadow-none dark:focus-visible:ring-offset-ink"
);

/** The picture's warm backdrop (ember in dark). */
const MODEL_BACKDROP = cx(
  "relative block aspect-square w-full overflow-hidden md:aspect-[4/3] md:max-h-[min(56vh,560px)]",
  "bg-gradient-to-b from-brand-50 via-orange-50 to-white dark:from-ember-800 dark:via-ember-900 dark:to-raised"
);

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
    <ul className="mx-auto grid max-w-[1400px] grid-cols-2 gap-3 sm:gap-6 xl:gap-8">
      {MODELS.map((model) => (
        <li key={model}>
          <ChoiceCard
            look="custom"
            onClick={() => onChoose(model)}
            aria-describedby={`model-hint-${model}`}
            aria-pressed={chosen === model}
            className={cx(
              MODEL_CARD,
              chosen === model ? "border-brand-500 ring-1 ring-brand-500" : "border-gray-200 dark:border-line"
            )}
          >
            <span className={MODEL_BACKDROP}>
              {/* A soft halo behind the face. */}
              <span
                aria-hidden="true"
                className="absolute left-1/2 top-[58%] h-[78%] w-[62%] -translate-x-1/2 -translate-y-1/2 rounded-full bg-brand-200/60 blur-2xl md:w-[46%] dark:bg-brand-500/15"
              />
              <LookPicture
                model={model}
                look="animation"
                className={cx(
                  "absolute inset-y-0 left-1/2 aspect-square h-full w-auto max-w-none -translate-x-1/2",
                  "transition-transform duration-300 group-hover:scale-[1.04] motion-reduce:transition-none motion-reduce:group-hover:scale-100"
                )}
              />
            </span>
            <span className="flex flex-1 items-start justify-between gap-2 p-3 sm:p-6">
              <span className="min-w-0">
                <span className="block text-base font-semibold tracking-[-0.01em] sm:text-xl">
                  {t(`wzModel_${model}`)}
                </span>
                <span
                  id={`model-hint-${model}`}
                  className="mt-1 block text-xs leading-snug text-gray-500 sm:text-[15px] dark:text-gray-400"
                >
                  {t(`wzModelHint_${model}`)}
                </span>
              </span>
              <span
                aria-hidden="true"
                className={cx(
                  "mt-0.5 hidden h-10 w-10 shrink-0 place-items-center rounded-full bg-gray-100 text-gray-500 sm:grid",
                  "transition-colors group-hover:bg-brand-600 group-hover:text-white dark:bg-white/[0.06] dark:text-gray-300"
                )}
              >
                <Icon name="arrow" className="h-4 w-4 rtl:-scale-x-100" strokeWidth={2} />
              </span>
            </span>
          </ChoiceCard>
        </li>
      ))}
    </ul>
  );
}
