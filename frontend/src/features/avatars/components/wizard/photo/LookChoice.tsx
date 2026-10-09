import { useId } from "react";

import { ChoiceCard } from "@/components/ui/ChoiceCard";
import { Icon } from "@/components/ui/Icon";
import { Label } from "@/components/ui/Label";
import { LookPicture, PICTURE_BACKDROP } from "@/features/avatars/components/wizard/Art";
import type { PhotoStepState } from "@/features/avatars/hooks/usePhotoStep";
import { type AvatarModel, LOOKS } from "@/features/avatars/wizard";
import { useT } from "@/i18n";
import { cx } from "@/lib/cx";

/** A look: its picture over its name, ringed when chosen. */
const LOOK_CARD = cx(
  "group relative flex flex-col overflow-hidden rounded-2xl border bg-white text-start transition dark:bg-raised",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-ink",
  "disabled:cursor-not-allowed disabled:opacity-45"
);
const LOOK_CARD_ON = "border-brand-500 ring-1 ring-brand-500";
const LOOK_CARD_OFF = "border-gray-200 hover:border-brand-300 dark:border-line dark:hover:border-brand-500/40";

/** The look (Realistic, Animation, Cartoon), each a small picture: a radio
 *  group; a look that needs the AI is off while the organization's is. */
export function LookChoice({ model, step }: { model: AvatarModel; step: PhotoStepState }) {
  const { t } = useT();
  const ids = useId();
  const { look, source } = step.form;
  return (
    <div>
      <Label as="p" id={`${ids}-look`}>
        {t("wzLookLabel")}
      </Label>
      <div role="radiogroup" aria-labelledby={`${ids}-look`} className="grid grid-cols-3 gap-2.5 sm:gap-4">
        {LOOKS.map((l) => {
          const on = l === look;
          const disabled = step.lookDisabled(l);
          return (
            <ChoiceCard
              key={l}
              look="custom"
              {...step.lookRadio(l)}
              disabled={disabled || step.busy}
              aria-describedby={`${ids}-look-${l}`}
              className={cx(LOOK_CARD, on ? LOOK_CARD_ON : LOOK_CARD_OFF)}
            >
              <span className={cx("relative block aspect-square w-full overflow-hidden", PICTURE_BACKDROP)}>
                <LookPicture model={model} look={l} className="absolute inset-0 h-full w-full" />
                {on && (
                  <span className="absolute end-2 top-2 grid h-6 w-6 place-items-center rounded-full bg-brand-600 text-white shadow motion-safe:animate-tick-in">
                    <Icon name="check" className="h-3.5 w-3.5" strokeWidth={2.6} />
                  </span>
                )}
              </span>
              <span className="px-2.5 py-2 sm:px-3.5 sm:py-3">
                <span className="block text-sm font-semibold">{t(`wzLook_${l}`)}</span>
                <span
                  id={`${ids}-look-${l}`}
                  className="mt-0.5 hidden text-xs leading-snug text-gray-500 sm:block dark:text-gray-400"
                >
                  {disabled ? t("wzAiOffBadge") : t(source === "upload" ? `wzLookUploadHint_${l}` : `wzLookHint_${l}`)}
                </span>
              </span>
            </ChoiceCard>
          );
        })}
      </div>
    </div>
  );
}
