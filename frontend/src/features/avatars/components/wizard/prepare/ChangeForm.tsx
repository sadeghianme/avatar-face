import { useId } from "react";

import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Label } from "@/components/ui/Label";
import { Spinner } from "@/components/ui/Spinner";
import { Textarea } from "@/components/ui/Textarea";
import type { PrepareScreenState } from "@/features/avatars/hooks/usePrepareScreen";
import { applyKeys, MAX_WORDS } from "@/features/avatars/wizard";
import { useT } from "@/i18n";

// The keys that apply a change, for this platform: read once, not per render.
const APPLY_KEYS = applyKeys(
  typeof navigator === "undefined"
    ? null
    : (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform || navigator.platform
);

/** What the result says it is (the AI's, the photo as it is, the
 *  background kept), what it was made from, and the change in effect with
 *  its removal. */
export function ResultNote({ prepare, busy }: { prepare: PrepareScreenState; busy: string | null }) {
  const { t } = useT();
  const { last, lastWasOriginal, plan, applied } = prepare;
  const note = !last?.cut && last ? t("wzKeptBackground") : lastWasOriginal ? t("wzOriginalNote") : t("wzAiMadeNote");
  return (
    <p className="flex items-start gap-2.5 rounded-2xl bg-gray-50 p-4 text-sm text-gray-700 dark:bg-white/[0.04] dark:text-gray-300">
      <Icon
        name={lastWasOriginal ? "image" : "sparkles"}
        className="mt-0.5 h-4 w-4 shrink-0 text-brand-600 dark:text-brand-300"
      />
      <span>
        {note}
        {plan.source === "generate" && plan.description && (
          <span className="mt-1 block text-xs text-gray-500 dark:text-gray-400">
            {t("wzDescribedAs", { description: plan.description })}
          </span>
        )}
        {applied && (
          <span className="mt-1 block text-xs text-gray-500 dark:text-gray-400">
            {t("wzChangeApplied", { change: applied })}
            {prepare.aiOn && !prepare.askAi && (prepare.canAi || prepare.freeClear) && (
              <>
                {" "}
                {/* In the line of words: inline, so it flows with them. */}
                <Button
                  variant="link"
                  className="inline rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                  onClick={prepare.clearChange}
                  disabled={prepare.redoing || busy !== null}
                  title={t(prepare.freeClear ? "wzChangeClearHint" : "wzChangeClearPaidHint")}
                >
                  {t(prepare.freeClear ? "wzChangeClear" : "wzChangeClearPaid")}
                </Button>
              </>
            )}
          </span>
        )}
      </span>
    </p>
  );
}

/** "Describe a change": the owner's words, applied by the button or
 *  Cmd/Ctrl+Enter (Enter alone is a new line). */
export function ChangeForm({ prepare, busy }: { prepare: PrepareScreenState; busy: string | null }) {
  const { t } = useT();
  const ids = useId();
  const held = prepare.redoing || busy !== null;
  return (
    <form
      className="space-y-2.5"
      onSubmit={(e) => {
        e.preventDefault();
        prepare.applyChange();
      }}
    >
      <Label htmlFor={`${ids}-change`} className="mb-0">
        {t("wzChangeLabel")}
      </Label>
      <Textarea
        id={`${ids}-change`}
        rows={3}
        className="min-h-[96px] resize-y text-[15px] leading-relaxed"
        maxLength={MAX_WORDS}
        placeholder={t("wzChangePlaceholder")}
        value={prepare.change}
        onChange={(e) => prepare.setChange(e.target.value)}
        onKeyDown={(e) => {
          // Cmd/Ctrl+Enter applies; Enter alone is a new line.
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            prepare.applyChange();
          }
        }}
        aria-describedby={`${ids}-change-keys`}
        // Read-only, not disabled, while a picture is made: the focus
        // stays in the box (a disabled one drops it to the page).
        readOnly={held}
        aria-busy={held}
      />
      <div className="flex items-center justify-end gap-3 sm:justify-between">
        <p id={`${ids}-change-keys`} className="hidden text-xs text-gray-500 dark:text-gray-400 sm:block">
          {t("wzChangeShortcut", { keys: APPLY_KEYS })}
        </p>
        <Button
          type="submit"
          variant="secondary"
          size="lg"
          className="shrink-0"
          icon={busy === "change" ? <Spinner className="h-4 w-4" /> : "pencil"}
          disabled={!prepare.change.trim() || held}
        >
          {t("wzApply")}
        </Button>
      </div>
    </form>
  );
}
