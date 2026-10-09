import { FIT_REASON_LABELS, type FitReason } from "@/features/avatars/face-marks";
import { useT } from "@/i18n";

/** What the server would refuse about the marks (and Save refuses too), one line each. */
export function FitReasons({ reasons }: { reasons: FitReason[] }) {
  const { t } = useT();
  if (reasons.length === 0) return null;
  const reasonText = (reason: FitReason) => {
    const key = FIT_REASON_LABELS[reason.code];
    return key ? t(key, { count: reason.count ?? 0 }) : reason.detail;
  };
  return (
    <div
      className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900
      dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
      role="alert"
    >
      <p className="font-medium">{t("fitRefusedTitle")}</p>
      <ul className="mt-1 list-disc pl-5">
        {reasons.map((reason) => (
          <li key={reason.code}>{reasonText(reason)}</li>
        ))}
      </ul>
    </div>
  );
}
