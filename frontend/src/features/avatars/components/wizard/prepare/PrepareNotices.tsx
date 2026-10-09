import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { Icon } from "@/components/ui/Icon";
import { Spinner } from "@/components/ui/Spinner";
import type { PrepareScreenState } from "@/features/avatars/hooks/usePrepareScreen";
import { useT } from "@/i18n";

/** The agreement the AI needs before it runs here: ticked, then Use AI
 *  (or the photo as it is, for a realistic upload); with the
 *  organization's AI off, why it cannot. */
export function AiAgreement({ prepare, busy }: { prepare: PrepareScreenState; busy: string | null }) {
  const { t } = useT();
  return (
    <Banner appearance="soft" tone="brand">
      <p className="text-sm font-medium text-gray-900 dark:text-white">{t("wzAiNeeded")}</p>
      {prepare.aiOn ? (
        <>
          <Checkbox
            size="md"
            className="mt-3 text-gray-800 dark:text-gray-200"
            checked={prepare.agree}
            onChange={(e) => prepare.setAgree(e.target.checked)}
            label={<span>{t(prepare.plan.source === "generate" ? "wzConsentAi_generate" : "wzConsentAi_upload")}</span>}
          />
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              size="lg"
              icon={busy === "prepare" ? <Spinner className="h-4 w-4" /> : "sparkles"}
              disabled={!prepare.agree || busy !== null}
              onClick={prepare.agreeAndPrepare}
            >
              {t("wzUseAi")}
            </Button>
            {prepare.originalOffered && (
              <Button variant="secondary" size="lg" disabled={busy !== null} onClick={prepare.originalInstead}>
                {t("wzUseOriginal")}
              </Button>
            )}
          </div>
        </>
      ) : (
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">{t("wzHoldAiOff")}</p>
      )}
    </Banner>
  );
}

/** A failure with nothing to show: why, and what to do next (try again,
 *  the photo as it is, or Back to change what was given). */
export function PrepareFailed({
  prepare,
  busy,
  onBack,
}: {
  prepare: PrepareScreenState;
  busy: string | null;
  onBack: () => void;
}) {
  const { t } = useT();
  const { job, originalOffered } = prepare;
  return (
    <Banner
      appearance="soft"
      tone="warning"
      icon="alert"
      role="alert"
      actions={
        <>
          {job?.retryable && !prepare.askAi && (
            <Button
              size="lg"
              icon={busy === "retry" ? <Spinner className="h-4 w-4" /> : "refresh"}
              onClick={prepare.retryJob}
              disabled={busy !== null}
            >
              {t("wzTryAgain")}
            </Button>
          )}
          {originalOffered && job?.step !== "ingest" && (
            <Button variant="secondary" size="lg" onClick={prepare.original} disabled={busy !== null}>
              {t("wzUseOriginal")}
            </Button>
          )}
          <Button
            variant={job?.retryable || originalOffered ? "secondary" : "primary"}
            size="lg"
            icon={<Icon name="back" className="h-4 w-4 rtl:-scale-x-100" />}
            onClick={onBack}
            disabled={busy !== null}
          >
            {t(prepare.plan.source === "generate" ? "wzEditDescription" : "wzOtherPhoto")}
          </Button>
        </>
      }
    >
      {prepare.failureText}
    </Banner>
  );
}
