import { useRef } from "react";

import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { FieldError } from "@/components/ui/FieldError";
import { FileInput } from "@/components/ui/FileInput";
import { Icon } from "@/components/ui/Icon";
import { Spinner } from "@/components/ui/Spinner";
import { JobProgressBar, ShapeTicks } from "@/features/avatars/components/create/JobProgress";
import type { MouthPanelState } from "@/features/avatars/hooks/useMouthPanel";
import { useT } from "@/i18n";
import { cx } from "@/lib/cx";

/**
 * What can be done to the photographic mouth: its AI action (the person's
 * mouth shapes and teeth made from this photo, followed while the job
 * runs), the owner's own teeth photo (added, replaced, removed), a refusal
 * said beside these buttons, and a Publish prompt for what this visit
 * changed, since the bar that also offers it may be a long scroll away.
 */
export function MouthKitActions({ panel }: { panel: MouthPanelState }) {
  const { t } = useT();
  const fileRef = useRef<HTMLInputElement>(null);
  const { kit, teeth, busy } = panel;
  const working = kit.running !== null;
  const held = kit.asking || working;
  return (
    <div className="p-3">
      {kit.offered && (
        <>
          {/* Held with aria-disabled, not disabled, while the job is
              asked for and runs (up to a minute): a disabled button
              drops the keyboard's focus to the page, and the next
              Tab would start from the top. */}
          <Button
            variant="secondary"
            size="lg"
            className="max-w-full text-start aria-disabled:cursor-not-allowed aria-disabled:opacity-60"
            icon={
              held ? <Spinner className="h-4 w-4 shrink-0" /> : <Icon name="sparkles" className="h-4 w-4 shrink-0" />
            }
            disabled={busy}
            aria-disabled={held}
            onClick={() => {
              if (!held) kit.make();
            }}
            aria-describedby="mouth-kit-hint"
          >
            {t(kit.actionKey)}
          </Button>
          <p id="mouth-kit-hint" className="mt-1.5 text-xs leading-relaxed text-gray-500">
            {t(teeth.own ? "mouthKitHintShapes" : "mouthKitHint")}
          </p>
        </>
      )}
      {kit.running && (
        <Card className="mt-2.5 rounded-lg border-black/10 p-2.5 shadow-none dark:border-white/10">
          <p className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs font-medium">
            <span className="flex items-center gap-2">
              <Spinner className="h-3.5 w-3.5 shrink-0 text-brand-600" />
              {kit.progressText}
            </span>
            {kit.count && (
              <span className="tabular-nums text-brand-700 dark:text-brand-300">
                {t("mouthShapesCount", { done: kit.count.done, total: kit.count.total })}
              </span>
            )}
          </p>
          {kit.count && <ShapeTicks count={kit.count} />}
          <JobProgressBar fraction={kit.running.progress?.fraction ?? null} label={kit.progressText} />
        </Card>
      )}
      <div className={cx("flex flex-wrap gap-2", (kit.offered || kit.running) && "mt-2.5")}>
        <FileInput
          ref={fileRef}
          accept="image/jpeg,image/png,image/webp"
          onChange={(event) => {
            panel.upload(event.target.files?.[0]);
            event.target.value = "";
          }}
        />
        <Button
          variant="secondary"
          size="lg"
          loading={busy}
          disabled={working}
          onClick={() => fileRef.current?.click()}
        >
          {t(teeth.own ? "mouthPhotoReplace" : "mouthPhotoAdd")}
        </Button>
        {teeth.hasPhoto && (
          <Button variant="secondary" size="lg" disabled={busy || working} onClick={panel.remove}>
            {t("mouthPhotoRemove")}
          </Button>
        )}
      </div>
      {panel.error && <FieldError className="mt-2.5 text-xs leading-relaxed">{panel.error}</FieldError>}
      {panel.publishPrompt && (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-amber-300/70 p-2.5 dark:border-amber-500/40">
          <p className="min-w-0 flex-1 text-xs leading-relaxed text-gray-700 dark:text-gray-200">
            {panel.publishPrompt}
          </p>
          <Button size="lg" loading={panel.publishing} disabled={busy || working} onClick={panel.publish}>
            {t("publish")}
          </Button>
        </div>
      )}
    </div>
  );
}
