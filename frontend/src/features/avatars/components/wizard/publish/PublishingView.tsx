import { Spinner } from "@/components/ui/Spinner";
import { JobProgress, useSeenStages } from "@/features/avatars/components/create/JobProgress";
import { PICTURE_BACKDROP } from "@/features/avatars/components/wizard/Art";
import { currentStep, finishRows, isJobActive, mouthExpected } from "@/features/avatars/creation";
import type { WizardCreation } from "@/features/avatars/wizard";
import { useT } from "@/i18n";
import { cx } from "@/lib/cx";

/**
 * The avatar being built after Publish: its picture, glowing, over the
 * build's stages (for a realistic person, their own teeth and mouth shapes
 * made meanwhile, listed with the rest), until the wizard opens its page.
 */
export function PublishingView({
  creation,
  aiConsentId,
}: {
  creation: WizardCreation;
  aiConsentId: string | null | undefined;
}) {
  const { t } = useT();
  const job = creation.job;
  const seen = useSeenStages(job);
  const rows = finishRows(job, mouthExpected(creation, aiConsentId), seen);
  const mouth = rows.some((row) => (row.phase === "shapes" || row.phase === "teeth") && row.state !== "skipped");
  const image = currentStep(creation);
  return (
    <div className="mx-auto max-w-lg space-y-4 py-2">
      {image && (
        <div
          className={cx(
            "relative mx-auto aspect-square w-48 overflow-hidden rounded-full border-4 border-white shadow-xl dark:border-raised",
            PICTURE_BACKDROP
          )}
        >
          <img src={image.url} alt="" className="absolute inset-0 h-full w-full object-cover object-top" />
          <span
            aria-hidden="true"
            className="absolute inset-0 rounded-full ring-2 ring-brand-500/60 motion-safe:animate-glow"
          />
        </div>
      )}
      {job && isJobActive(job) ? (
        <JobProgress job={job} rows={rows} />
      ) : (
        <p className="flex items-center justify-center gap-2 text-sm">
          <Spinner className="h-4 w-4 text-brand-600" /> {t("createFinished")}
        </p>
      )}
      {mouth && <p className="text-center text-xs text-gray-500 dark:text-gray-400">{t("wzMouthKitNote")}</p>}
    </div>
  );
}
