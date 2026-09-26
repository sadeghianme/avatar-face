import { useTranslation } from "react-i18next";

import { JobProgress, useSeenStages } from "@/features/avatars/components/create/JobProgress";
import { MouthWarnings } from "@/features/avatars/components/create/MouthWarnings";
import {
  expectedMouthWarnings,
  finishNoticeFor,
  finishRows,
  isJobActive,
  type Creation,
  type DraftStore,
} from "@/features/avatars/creation";
import { Spinner } from "@/components/ui/Spinner";

function tabStore(): DraftStore | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Step 5, "Preparing your avatar": the finish, watched. The avatar is
 * built from the confirmed points and published; for a person, when AI may
 * make it (the member's consent, the organization's switch), their own
 * teeth and six mouth shapes are made from the chosen picture first and
 * the mouth is fitted to them: what gives the photo the Reference avatar's
 * quality. Nothing is asked here: the AI statement, when the member had
 * not agreed to the words in force, was asked at the press that opened
 * this step (PointsStep), before anything was sent.
 *
 * The job's stages are listed in plain words (creation.finishRows), the
 * shapes counted as they are made, and what is said around the list
 * follows the same rows: what the AI makes and an honest time (a few
 * seconds, up to half a minute for the teeth alone, up to about a minute
 * for the shapes) only while the list shows it. The wizard announces each
 * stage from its live region, and opens the avatar's page once it is
 * built. Everything here is read from the creation and this tab's storage,
 * so a tab reloaded mid-build shows the same view.
 */
export function PrepareStep({ creation, mouthExpected }: { creation: Creation; mouthExpected: boolean }) {
  const { t } = useTranslation();
  const job = creation.job;
  const seen = useSeenStages(job);
  const rows = finishRows(job, mouthExpected, seen);
  // The person's own mouth was not made after all: said once, and no word
  // around the list claims the AI is still making it.
  const standard = rows.some((row) => row.state === "skipped");
  const mouth = standard
    ? null
    : rows.find((row) => row.phase === "shapes" || row.phase === "teeth")?.phase ?? null;
  // The finish answer's warnings, kept for this tab (PointsStep); a tab that
  // never saw the answer shows what the photo check says it was.
  const kept = creation.avatar_id ? finishNoticeFor(tabStore(), creation.avatar_id) : null;
  const warnings = kept?.warnings ?? expectedMouthWarnings(creation).map((code) => ({ code, detail: "" }));

  return (
    <div className="space-y-4">
      {mouth && (
        <p className="text-sm text-gray-600 dark:text-gray-300">
          {t(mouth === "teeth" ? "createPrepareTeeth" : "createPrepareMouth")}
        </p>
      )}
      {standard && <p className="text-sm text-gray-600 dark:text-gray-300">{t("createPrepareStandard")}</p>}
      {job && isJobActive(job) ? (
        <JobProgress job={job} rows={rows} />
      ) : (
        <p className="flex items-center gap-2 text-sm">
          <Spinner className="h-4 w-4" />
          {creation.status === "finished" ? t("createFinished") : t("createJob_finish")}
        </p>
      )}
      <p className="text-xs text-gray-500 dark:text-gray-400">
        {t(mouth === "teeth" ? "createFinishingHintTeeth" : mouth ? "createFinishingHintMouth" : "createFinishingHint")}
      </p>
      <MouthWarnings warnings={warnings} />
    </div>
  );
}
