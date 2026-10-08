import { useId } from "react";

import { Card } from "@/components/ui/Card";
import { Checkbox } from "@/components/ui/Checkbox";
import { Icon } from "@/components/ui/Icon";
import { AiConsentReagreeNote } from "@/features/avatars/components/create/AiConsentDialog";
import { CONSENT_TEXT_VERSIONS } from "@/features/avatars/consent";
import type { PhotoStepState } from "@/features/avatars/hooks/usePhotoStep";
import { useT } from "@/i18n";

/**
 * The agreements, asked here and only here, never later as a pop-up: to
 * send the photo or the description to the AI (optional for a realistic
 * upload, which can go without it), and for a person the statement about
 * the face. Nothing to show when the organization's AI is off and no
 * statement is asked.
 */
export function Agreements({ step, reagree }: { step: PhotoStepState; reagree: boolean }) {
  const { t } = useT();
  const ids = useId();
  const { aiEnabled, statement, providers, busy } = step;
  const { source, aiAgreed, statementAgreed } = step.form;
  if (!aiEnabled && !statement) return null;
  return (
    <Card tone="muted" className="space-y-3 p-4">
      {aiEnabled && (
        <div>
          <Checkbox
            size="md"
            className="text-gray-800 dark:text-gray-200"
            checked={aiAgreed}
            disabled={busy}
            onChange={(e) => step.agreeAi(e.target.checked)}
            aria-describedby={`${ids}-ai-more`}
            label={<span>{t(source === "upload" ? "wzConsentAi_upload" : "wzConsentAi_generate")}</span>}
          />
          <div id={`${ids}-ai-more`} className="ms-8 mt-1 space-y-1 text-xs text-gray-500 dark:text-gray-400">
            {reagree && <AiConsentReagreeNote className="!text-xs font-medium" />}
            <p>
              {t("wzConsentAiProvider", { providers })} {!step.needsAi && t("wzConsentOptional")}
            </p>
            <details className="group">
              <summary className="inline-flex cursor-pointer list-none items-center gap-1 font-medium text-brand-700 hover:underline coarse:min-h-11 dark:text-brand-300">
                <Icon
                  name="chevron"
                  className="h-3.5 w-3.5 transition-transform group-open:rotate-90 rtl:-scale-x-100"
                />
                {t("wzConsentDetails")}
              </summary>
              <div className="mt-2 space-y-2 leading-relaxed">
                <p>{t("aiConsentSent", { providers })}</p>
                <p>{t("aiConsentKept")}</p>
                <p>{t("aiConsentRights")}</p>
                <p className="text-[11px]">
                  {t("aiConsentRecorded", { version: CONSENT_TEXT_VERSIONS.third_party_ai })}
                </p>
              </div>
            </details>
          </div>
        </div>
      )}
      {statement && (
        <Checkbox
          size="md"
          className="text-gray-800 dark:text-gray-200"
          checked={statementAgreed}
          disabled={busy}
          onChange={(e) => step.agreeStatement(e.target.checked)}
          label={
            <span>{t(statement === "depiction" ? "createDepictionStatement" : "createGeneratedFaceStatement")}</span>
          }
        />
      )}
    </Card>
  );
}
