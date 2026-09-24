import { useTranslation } from "react-i18next";

import { CHECKER } from "@/features/avatars/components/create/checker";
import { JobProgress } from "@/features/avatars/components/create/JobProgress";
import {
  backgroundSource,
  currentStep,
  cutoutOf,
  isJobActive,
  isTransparent,
  jobFailure,
  type Creation,
} from "@/features/avatars/creation";
import { Spinner } from "@/components/ui/Spinner";

/**
 * Step 2: remove the background, or keep it. Before and after side by
 * side; either is a click to choose, and the cut-out, once made, stays
 * choosable, so changing one's mind costs nothing.
 *
 * It works on the picture chosen so far: the photo, or an AI version when
 * the owner comes back here after step 3 (its cut-out is "cutout:N"). The
 * answer is remembered (`creation.background`): a version taken in step 3
 * later is cut out too when it is "remove". Continue without choosing
 * keeps the background, the same as choosing Keep.
 *
 * Only people so far (the segmenter is trained on people: on a muzzle or a
 * drawing it cuts ears, whiskers and outlines). Other lines, and servers
 * without the segmenter, get a sentence saying so and a Continue.
 */
export function BackgroundStep({
  creation,
  busy,
  onChoose,
  onRetry,
  onContinue,
  onBack,
}: {
  creation: Creation;
  busy: string | null;
  onChoose: (mode: "remove" | "keep") => void;
  onRetry: () => void;
  onContinue: () => void;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const current = currentStep(creation);
  const source = backgroundSource(creation);
  const removed = isTransparent(current);
  // What the Remove card shows: the transparent image on screen (a
  // touch-up of a cut-out included), else the cut-out made from the source.
  const cutout = removed ? current : cutoutOf(creation, source?.id);
  const offer = creation.background_removal;
  const job = creation.job?.step === "background" ? creation.job : null;
  const working = isJobActive(creation.job);
  // "Keep" goes back to the opaque image behind the cut-out, which is the
  // photo before a touch-up made on the cut-out: said before it happens.
  const keepDropsTouchup = removed && Boolean(current?.adjust);

  const actions = (
    <div className="flex flex-wrap items-center gap-3">
      <button type="button" className="btn-secondary min-h-11" onClick={onBack} disabled={busy !== null}>
        {t("createBack")}
      </button>
      <button
        type="button"
        className="btn-primary min-h-11 px-5"
        onClick={onContinue}
        disabled={busy !== null || working}
      >
        {t("createContinue")}
      </button>
    </div>
  );

  if (!offer.available) {
    return (
      <div className="space-y-5">
        <p className="rounded-xl bg-gray-50 p-4 text-sm text-gray-600 dark:bg-white/[0.04] dark:text-gray-300">
          {t(`createBgUnavailable_${offer.reason ?? "segmentation_unavailable"}`)}
        </p>
        {source && (
          <img src={source.url} alt={t("createBgBefore")} className="mx-auto max-h-80 rounded-xl" />
        )}
        {actions}
      </div>
    );
  }

  const choice = (mode: "keep" | "remove", selected: boolean, label: string, image: React.ReactNode) => (
    <button
      type="button"
      aria-pressed={selected}
      onClick={() => onChoose(mode)}
      disabled={busy !== null || working}
      className={`flex flex-col overflow-hidden rounded-2xl border-2 text-start transition-colors focus-visible:outline-none
        focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 disabled:cursor-wait ${
          selected
            ? "border-brand-500"
            : "border-gray-200 hover:border-gray-300 dark:border-line dark:hover:border-gray-600"
        }`}
    >
      <span className={`grid aspect-square w-full place-items-center overflow-hidden ${CHECKER}`}>{image}</span>
      <span className="flex items-center justify-between gap-2 px-3 py-2.5 text-sm font-medium">
        {label}
        {selected && (
          <span className="rounded-full bg-brand-600 px-2 py-0.5 text-[11px] font-medium text-white">
            {t("createBgChosen")}
          </span>
        )}
      </span>
    </button>
  );

  return (
    <div className="space-y-5">
      <p className="text-sm text-gray-600 dark:text-gray-300">{t("createBgIntro")}</p>
      <div className="grid gap-4 sm:grid-cols-2">
        {choice(
          "keep",
          !removed,
          t("createBgKeep"),
          source ? <img src={source.url} alt={t("createBgBefore")} className="max-h-full max-w-full object-contain" /> : null
        )}
        {choice(
          "remove",
          removed,
          t("createBgRemove"),
          cutout ? (
            <img src={cutout.url} alt={t("createBgAfter")} className="max-h-full max-w-full object-contain" />
          ) : (
            <span className="px-6 text-center text-xs text-gray-500 dark:text-gray-400">
              {working && job ? <Spinner className="mx-auto mb-2 h-6 w-6" /> : null}
              {working && job ? t("createJob_background") : t("createBgNotYet")}
            </span>
          )
        )}
      </div>
      {keepDropsTouchup && <p className="text-xs text-gray-500 dark:text-gray-400">{t("createBgKeepDropsTouchup")}</p>}
      {job && (isJobActive(job) || jobFailure(job)) && (
        <JobProgress job={job} onRetry={onRetry} retrying={busy === "retry"} />
      )}
      {actions}
    </div>
  );
}
