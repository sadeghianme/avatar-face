import { useId, useRef } from "react";

import { Chip } from "@/components/ui/Chip";
import { Field } from "@/components/ui/Field";
import { Textarea } from "@/components/ui/Textarea";
import { type AvatarModel, MAX_WORDS } from "@/features/avatars/wizard";
import { useT } from "@/i18n";

const EXAMPLES = [1, 2, 3, 4] as const;

/** The character in words, its length counted, and a few examples to
 *  start from (each puts its words in the box). */
export function DescribeField({
  model,
  description,
  onChange,
  busy,
}: {
  model: AvatarModel;
  description: string;
  onChange: (description: string) => void;
  busy: boolean;
}) {
  const { t } = useT();
  const ids = useId();
  const box = useRef<HTMLTextAreaElement>(null);
  return (
    <div>
      <Field id={`${ids}-describe`} label={t(`wzDescribeLabel_${model}`)}>
        <div className="relative">
          <Textarea
            ref={box}
            rows={3}
            maxLength={MAX_WORDS}
            className="min-h-[96px] resize-none pb-7 text-[15px] leading-relaxed"
            placeholder={t(`wzDescribePlaceholder_${model}`)}
            value={description}
            onChange={(e) => onChange(e.target.value)}
            aria-describedby={`${ids}-count`}
            disabled={busy}
          />
          <span
            id={`${ids}-count`}
            className="pointer-events-none absolute bottom-2 end-3 text-[11px] tabular-nums text-gray-400"
          >
            {t("wzCharCount", { count: description.length, max: MAX_WORDS })}
          </span>
        </div>
      </Field>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-gray-500 dark:text-gray-400">{t("wzTry")}</span>
        {EXAMPLES.map((n) => {
          const text = t(`wzExample_${model}_${n}`);
          return (
            <Chip
              key={n}
              variant="suggestion"
              disabled={busy}
              onClick={() => {
                onChange(text);
                box.current?.focus();
              }}
            >
              {text}
            </Chip>
          );
        })}
      </div>
    </div>
  );
}
