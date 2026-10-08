import { Button, type ButtonProps } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import type { ReferenceWorkspace } from "@/features/lab/hooks/useReferenceWorkspace";
import { useT } from "@/i18n";
import type { MessageKey } from "@/i18n/types";

/** One of a set of choices shown as buttons: the chosen one filled. */
function Toggle({ on, ...props }: ButtonProps & { on: boolean }) {
  return <Button variant={on ? "primary" : "secondary"} aria-pressed={on} {...props} />;
}

const POSE_LABELS: Record<string, MessageKey> = {
  rest: "referenceRest",
  closed: "referenceClosed",
  aa: "referenceAA",
  ee: "referenceEE",
  oo: "referenceOO",
  oh: "referenceOH",
  fv: "referenceFV",
  th: "referenceTH",
};

/** Which mouth is the candidate, the pose both hold, and how close they are shown. */
export function ReferencePoseCard({ bench }: { bench: ReferenceWorkspace }) {
  const { t } = useT();
  return (
    <Card as="section" className="space-y-4" aria-label={t("referencePoseTitle")}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-semibold">{t("referencePoseTitle")}</h3>
        <span className="rounded-full bg-brand-50 px-3 py-1 text-xs font-medium text-brand-700 dark:bg-brand-950 dark:text-brand-300">
          {t("referencePrototype")}
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        <Toggle on={bench.photographic} onClick={() => bench.setPhotographic(true)}>
          {t("referencePhotographic")}
        </Toggle>
        <Toggle on={!bench.photographic} onClick={() => bench.setPhotographic(false)}>
          {t("referenceGeometry")}
        </Toggle>
      </div>
      <div className="flex flex-wrap gap-2">
        {Object.entries(POSE_LABELS).map(([key, label]) => (
          <Toggle key={key} on={bench.pose === key} disabled={!bench.ready} onClick={() => bench.freeze(key)}>
            {t(label)}
          </Toggle>
        ))}
      </div>
      <p className="text-xs leading-relaxed text-gray-500">{t("referencePoseHint")}</p>
      <div className="flex gap-2">
        <Toggle on={!bench.mouthOnly} onClick={() => bench.setMouthOnly(false)}>
          {t("referencePortraitView")}
        </Toggle>
        <Toggle on={bench.mouthOnly} onClick={() => bench.setMouthOnly(true)}>
          {t("referenceMouthView")}
        </Toggle>
      </div>
    </Card>
  );
}
