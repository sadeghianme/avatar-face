import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { Icon } from "@/components/ui/Icon";
import { FIT_REASON_LABELS, type FitReason } from "@/features/avatars/face-marks";
import type { PublishEditorState } from "@/features/avatars/hooks/usePublishEditor";
import { statementKey } from "@/features/avatars/wizard";
import { useT } from "@/i18n";
import { cx } from "@/lib/cx";

const PARTS = ["eyes", "lips", "head"] as const;

/** What was found, said as it is: the eyes, lips and head (drag a point
 *  only if it is off); found, but with points to look at (the refusal
 *  below says which); or not found at all, with a hint to place them. Then
 *  Reset and the keyboard's keys. */
export function FaceFound({ editor, busy }: { editor: PublishEditorState; busy: boolean }) {
  const { t } = useT();
  return (
    <>
      {editor.found ? (
        <div>
          <p className="flex items-center gap-2 text-sm font-medium text-emerald-700 dark:text-emerald-400">
            <span className="grid h-6 w-6 place-items-center rounded-full bg-emerald-500 text-white">
              <Icon name="check" className="h-3.5 w-3.5" strokeWidth={2.6} />
            </span>
            {t("wzFaceFound")}
          </p>
          <ul className="mt-3 flex flex-wrap gap-2" aria-label={t("wzFaceFound")}>
            {PARTS.map((part) => (
              <li
                key={part}
                className={cx(
                  "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium",
                  "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-300"
                )}
              >
                <Icon name="check" className="h-3 w-3" strokeWidth={2.6} />
                {t(`wzFound_${part}`)}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-sm text-gray-600 dark:text-gray-300">{t("wzPointsHint")}</p>
        </div>
      ) : editor.detected ? (
        <Banner appearance="soft" tone="info" icon="target">
          {t("wzFoundCheck")}
        </Banner>
      ) : (
        <Banner appearance="soft" tone="warning" icon="target">
          {t("wzNotFound")}
        </Banner>
      )}

      <div>
        {/* Greyed, not faded, while there is nothing to reset. */}
        <Button
          variant="link"
          icon="undo"
          className="min-h-10 gap-2 rounded-lg text-sm disabled:text-gray-400 disabled:opacity-100 coarse:min-h-11 dark:disabled:text-gray-600"
          onClick={editor.resetMarks}
          disabled={!editor.edited || busy}
        >
          {t("wzResetPoints")}
        </Button>
        <details className="group mt-1 hidden text-xs text-gray-500 dark:text-gray-400 sm:block">
          <summary className="inline-flex min-h-8 coarse:min-h-11 cursor-pointer list-none items-center gap-1 font-medium hover:text-gray-700 dark:hover:text-gray-200">
            <Icon name="chevron" className="h-3.5 w-3.5 transition-transform group-open:rotate-90 rtl:-scale-x-100" />
            {t("wzKeysTitle")}
          </summary>
          <p className="mt-1 leading-relaxed">{t("markFaceKeys")}</p>
        </details>
      </div>
    </>
  );
}

/**
 * What Publish waits for, each beside its answer: points that would
 * stretch the face (listed, with "Fix it for me", which puts the points
 * back where they were found, a layout that always publishes), points
 * placed by hand to confirm, the statement about this face (worded for the
 * plan: on an "Animal" plan, the detector's person on a photo may be a
 * dog, wizard.statementKey); then the name it will have. A crease the fit
 * smoothed between two points is said in a line, and holds nothing.
 */
export function PublishChecks({ editor }: { editor: PublishEditorState }) {
  const { t } = useT();
  const reasonText = (reason: FitReason) => {
    const key = FIT_REASON_LABELS[reason.code];
    return key ? t(key, { count: reason.count ?? 0 }) : reason.detail;
  };
  return (
    <>
      {editor.reasons.length > 0 && (
        <Banner appearance="soft" tone="warning" role="alert">
          <p className="font-medium">{t("wzFitProblems")}</p>
          <ul className="mt-1 list-disc ps-5">
            {editor.reasons.map((reason) => (
              <li key={reason.code}>{reasonText(reason)}</li>
            ))}
          </ul>
          {editor.canFix && (
            <Button variant="secondary" size="sm" icon="sparkles" className="mt-3" onClick={editor.resetMarks}>
              {t("wzFixPoints")}
            </Button>
          )}
        </Banner>
      )}

      {editor.reasons.length === 0 && editor.notes.length > 0 && (
        <p role="status" className="flex items-start gap-2 text-sm text-gray-600 dark:text-gray-300">
          <Icon name="check" className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
          {t("wzFitSmoothed")}
        </p>
      )}

      {editor.needsConfirm && (
        <Checkbox
          size="md"
          className="text-gray-800 dark:text-gray-200"
          checked={editor.confirmed}
          onChange={(e) => editor.confirm(e.target.checked)}
          label={<span>{t("wzPointsConfirm")}</span>}
        />
      )}

      {editor.statementScope && (
        <Checkbox
          ref={editor.statementBox}
          size="md"
          className="rounded-xl border border-gray-200 p-3 text-gray-800 dark:border-line dark:text-gray-200"
          checked={editor.statement}
          onChange={(e) => editor.agreeStatement(e.target.checked)}
          label={<span>{t(statementKey(editor.statementScope, editor.plan))}</span>}
        />
      )}

      <div className="rounded-2xl bg-gray-50 p-4 text-sm dark:bg-white/[0.04]">
        <p className="text-gray-600 dark:text-gray-300">
          {t("wzPublishAs")} <strong className="font-semibold text-gray-900 dark:text-white">{editor.name}</strong>
        </p>
        <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{t("wzPublishHint")}</p>
      </div>
    </>
  );
}
