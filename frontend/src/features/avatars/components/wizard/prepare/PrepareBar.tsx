import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { BackButton, BarAction, StepFooter } from "@/features/avatars/components/wizard/Footer";
import type { PrepareScreenState } from "@/features/avatars/hooks/usePrepareScreen";
import { footerPlan } from "@/features/avatars/wizard";
import { useT } from "@/i18n";

/** The action bar once a picture is ready: Back, Retry (or Use AI after
 *  the original), the photo as it is, and Continue to Publish. */
export function PrepareBar({
  prepare,
  busy,
  onBack,
  onContinue,
}: {
  prepare: PrepareScreenState;
  busy: string | null;
  onBack: () => void;
  onContinue: () => void;
}) {
  const { t } = useT();
  const footer = footerPlan("prepare", { prepared: Boolean(prepare.result) });
  const held = prepare.redoing || busy !== null;
  const offerAi = prepare.canAi && !prepare.askAi;
  return (
    <StepFooter back={footer.back && <BackButton onClick={onBack} disabled={busy !== null} compact />}>
      {offerAi && !prepare.lastWasOriginal && (
        <BarAction
          icon="refresh"
          label={t("wzRetry")}
          short={t("wzRetry")}
          onClick={prepare.retry}
          disabled={held}
          busy={busy === "prepare" && prepare.redoing}
        />
      )}
      {offerAi && prepare.lastWasOriginal && (
        <BarAction
          icon="sparkles"
          label={t("wzUseAi")}
          short={t("wzUseAiShort")}
          onClick={prepare.useAi}
          disabled={held}
        />
      )}
      {prepare.originalOffered && !prepare.lastWasOriginal && (
        <BarAction
          icon="image"
          label={t("wzUseOriginal")}
          short={t("wzUseOriginalShort")}
          onClick={prepare.original}
          disabled={held}
        />
      )}
      {footer.primary === "continue" && (
        <Button
          size="xl"
          className="whitespace-nowrap shadow-sm shadow-brand-600/20 sm:px-6"
          iconEnd={<Icon name="arrow" className="h-4 w-4 rtl:-scale-x-100" strokeWidth={2} />}
          onClick={onContinue}
          disabled={held}
        >
          <span className="sm:hidden">{t("wzContinueShort")}</span>
          <span className="hidden sm:inline">{t("wzContinue")}</span>
        </Button>
      )}
    </StepFooter>
  );
}
