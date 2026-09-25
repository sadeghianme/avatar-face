import { useTranslation } from "react-i18next";

import type { FinishWarning } from "@/features/avatars/creation";
import { Icon } from "@/components/ui/Icon";

/**
 * What the picture will show around the mouth once built: before the
 * press, on the points step, from the photo check (with the way back to AI
 * adjust, which can fix it), and after, while step 5 builds the avatar,
 * from the finish answer. Information, not a refusal: the avatar is built
 * either way.
 */
export function MouthWarnings({
  warnings,
  before = false,
  onFix,
  disabled = false,
}: {
  warnings: FinishWarning[];
  /** Said before finishing: the owner can still act on it. */
  before?: boolean;
  onFix?: () => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  if (warnings.length === 0) return null;
  return (
    <div
      className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
      // After the press it arrives while the page is being watched; before
      // it, it is part of the page, read in order like the rest.
      role={before ? undefined : "status"}
    >
      <p className="font-medium">{t(before ? "finishWarningsBeforeTitle" : "finishWarningsTitle")}</p>
      <ul className="mt-1 list-disc space-y-1 ps-5">
        {warnings.map((warning) => (
          <li key={warning.code}>{t(`finishWarning_${warning.code}`, { defaultValue: warning.detail })}</li>
        ))}
      </ul>
      {before && onFix && (
        <button type="button" className="btn-secondary mt-3 min-h-11" onClick={onFix} disabled={disabled}>
          <Icon name="sparkles" className="h-4 w-4" />
          {t("finishWarningsFix")}
        </button>
      )}
    </div>
  );
}
