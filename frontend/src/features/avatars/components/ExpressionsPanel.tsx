import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ConfirmButton } from "@/components/ui/ConfirmButton";
import { FieldError } from "@/components/ui/FieldError";
import { Icon } from "@/components/ui/Icon";
import { Label } from "@/components/ui/Label";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Spinner } from "@/components/ui/Spinner";
import { Switch } from "@/components/ui/Switch";
import { JobProgressBar, ShapeTicks } from "@/features/avatars/components/create/JobProgress";
import { ExpressionShots } from "@/features/avatars/components/expressions/ExpressionShots";
import type { Delivery } from "@/features/avatars/expressions";
import { useExpressionsPanel } from "@/features/avatars/hooks/useExpressionsPanel";
import { useT } from "@/i18n";
import type { Avatar } from "@/lib/types";

/**
 * The avatar's expressions: animated from its photo (always), or AI
 * pictures of this same face making each one (the owner's choice, made by
 * Google's image model from the photo, so it asks the member's third-party
 * AI consent first). The state and the requests are useExpressionsPanel's;
 * this draws them.
 *
 * On, the next publish makes the pictures (now, or as a batch: cheaper,
 * ready within hours) and publishes them when ready; Make now makes them
 * as a draft edit. The grid shows each of the five, or why it stays
 * animated. Remove takes them out of the draft and turns the choice off.
 */
export function ExpressionsPanel({ avatar, orgId }: { avatar: Avatar; orgId: string }) {
  const { t } = useT();
  const panel = useExpressionsPanel(avatar, orgId);
  const working = panel.running !== null;
  const deliveries: { value: Delivery; label: string }[] = [
    { value: "now", label: t("exprDeliveryNow") },
    { value: "batch", label: t("exprDeliveryBatch") },
  ];

  if (!panel.aiEnabled) {
    return (
      <section className="space-y-3" aria-label={t("exprTitle")}>
        <p className="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{t("exprIntro")}</p>
        <Banner tone="info" appearance="soft">
          {t("exprAiOff")}
        </Banner>
      </section>
    );
  }

  return (
    <section className="space-y-4" aria-label={t("exprTitle")}>
      <p className="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{t("exprIntro")}</p>

      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Label as="p" id="expr-use-label" className="text-[13.5px]">
            {t("exprUse")}
          </Label>
          <p id="expr-use-hint" className="mt-0.5 text-xs leading-relaxed text-gray-500">
            {t("exprUseHint")}
          </p>
        </div>
        <Switch
          checked={panel.ai}
          disabled={panel.busy || panel.loading}
          aria-labelledby="expr-use-label"
          aria-describedby="expr-use-hint"
          onChange={(on) => void panel.setAi(on)}
        />
      </div>

      {panel.ai && (
        <div>
          <Label as="p" id="expr-delivery-label" className="mb-1.5 text-xs">
            {t("exprDelivery")}
          </Label>
          <SegmentedControl
            options={deliveries}
            value={panel.delivery}
            onChange={(value) => void panel.setDelivery(value)}
            labelledBy="expr-delivery-label"
            itemClassName="flex-1"
          />
        </div>
      )}

      {panel.pending && (
        <Banner tone="info" appearance="soft">
          {t("exprPending")}
        </Banner>
      )}

      {panel.running && (
        <Card className="rounded-lg border-black/10 p-2.5 shadow-none dark:border-white/10">
          <p className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs font-medium">
            <span className="flex items-center gap-2">
              <Spinner className="h-3.5 w-3.5 shrink-0 text-brand-600" />
              {panel.progressText}
            </span>
            {panel.count && (
              <span className="tabular-nums text-brand-700 dark:text-brand-300">
                {t("exprCount", { done: panel.count.done, total: panel.count.total })}
              </span>
            )}
          </p>
          {panel.count && <ShapeTicks count={panel.count} />}
          <JobProgressBar fraction={panel.running.progress?.fraction ?? null} label={panel.progressText} />
        </Card>
      )}

      {panel.view?.kit && (
        <div className="space-y-2">
          <p className="text-xs font-medium" role="status">
            {t("exprMade", { made: panel.made, total: panel.shots.length })}
          </p>
          <ExpressionShots shots={panel.shots} />
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          size="lg"
          icon={<Icon name="sparkles" className="h-4 w-4 shrink-0" />}
          loading={panel.busy && !panel.removing}
          disabled={working || panel.loading}
          onClick={() => void panel.make()}
          aria-describedby="expr-make-hint"
        >
          {t(panel.made > 0 ? "exprMakeAgain" : "exprMake")}
        </Button>
        {panel.view?.kit && (
          <ConfirmButton
            label={t("exprRemove")}
            question={t("exprRemoveQuestion")}
            confirmLabel={t("exprRemoveConfirm")}
            cancelLabel={t("cancel")}
            busy={panel.removing}
            disabled={working}
            onConfirm={() => void panel.remove()}
          />
        )}
      </div>
      <p id="expr-make-hint" className="text-xs leading-relaxed text-gray-500">
        {t("exprMakeHint")}
      </p>
      {(panel.error || panel.loadError) && (
        <FieldError className="text-xs leading-relaxed">{panel.error || panel.loadError}</FieldError>
      )}
      {panel.consentDialog}
    </section>
  );
}
