import type { ReactNode } from "react";

import { Badge } from "@/components/ui/Badge";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import type { MouthPanelState } from "@/features/avatars/hooks/useMouthPanel";
import type { MotionChoice } from "@/features/avatars/mouth-config";
import { kitTeethText, shapesLabel, standardShapeText, teethNoteText } from "@/features/avatars/mouth-kit";
import { teethNoteKey } from "@/features/avatars/teeth";
import { useT } from "@/i18n";

const MOTION_CHOICES: readonly MotionChoice[] = ["own", "standard"];

/** Where a part of the mouth comes from, as a badge: this photo's (made by
 * AI, with its mark; or the owner's own photo), or standard. */
function SourceChip({ made, ai = made, children }: { made: boolean; ai?: boolean; children: ReactNode }) {
  return (
    <Badge tone={made ? "brand" : "muted"} icon={ai ? "sparkles" : undefined}>
      {children}
    </Badge>
  );
}

/**
 * The photographic mouth's shapes: whether they are the person's own (made
 * by AI from the photo), some of them, or the standard ones, and why each
 * standard one is; with a compare switch that plays the standard shapes in
 * the preview instead (`motion`), saving nothing.
 */
export function MouthShapes({
  shapes,
  motion,
  onMotion,
}: {
  shapes: NonNullable<MouthPanelState["shapes"]>;
  motion: MotionChoice;
  onMotion: (choice: MotionChoice) => void;
}) {
  const { t } = useT();
  const { view } = shapes;
  return (
    <div className="p-3">
      <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
        {t("mouthShapesInUse")}
        <SourceChip made={view.kind !== "standard"}>{shapesLabel(t, view)}</SourceChip>
      </p>
      <p className="mt-1 text-xs leading-relaxed text-gray-500">
        {shapes.dropped ??
          t(
            view.kind === "standard"
              ? "mouthShapesStandardHint"
              : view.kind === "mixed"
                ? "mouthShapesAiHintMixed"
                : "mouthShapesAiHint"
          )}
      </p>
      {shapes.standard.length > 0 && (
        <div className="mt-1.5 text-xs leading-relaxed text-gray-600 dark:text-gray-300">
          <p className="font-medium">{t("mouthShapesWhy")}</p>
          <ul className="mt-0.5 list-disc space-y-0.5 ps-4">
            {shapes.standard.map((shape) => (
              <li key={shape.shape}>{standardShapeText(t, shape)}</li>
            ))}
          </ul>
        </div>
      )}
      {shapes.compare && (
        <div className="mt-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <span id="mouth-compare-label" className="text-xs font-medium text-gray-600 dark:text-gray-300">
              {t("mouthCompare")}
            </span>
            <SegmentedControl
              look="pill"
              labelledBy="mouth-compare-label"
              describedBy="mouth-compare-hint"
              options={MOTION_CHOICES.map((choice) => ({
                value: choice,
                label: t(`mouthCompare_${choice}`),
              }))}
              value={motion}
              onChange={(choice) => motion !== choice && onMotion(choice)}
            />
          </div>
          <p id="mouth-compare-hint" className="mt-1.5 text-xs leading-relaxed text-gray-500">
            {t("mouthCompareHint")}
          </p>
        </div>
      )}
    </div>
  );
}

/** Whose teeth the photographic mouth shows (the AI's "ee", the owner's own
 *  photo, or standard ones) and, for standard ones, why. */
export function MouthTeeth({ teeth }: { teeth: MouthPanelState["teeth"] }) {
  const { t } = useT();
  const { view, note, kitReason } = teeth;
  return (
    <div className="p-3">
      {view && (
        <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
          {t("mouthTeethInUse")}
          <SourceChip made={view.kind !== "generic"} ai={view.kind === "ai"}>
            {t(`mouthTeethKind_${view.kind}`)}
          </SourceChip>
        </p>
      )}
      <p className="mt-1 text-xs leading-relaxed text-gray-500">
        {t(view?.kind === "ai" ? "mouthTeethAiHint" : teeth.hasPhoto ? "mouthPhotoActive" : "mouthPhotoHint")}
      </p>
      {note && (
        <p className="mt-1.5 text-xs leading-relaxed text-amber-700 dark:text-amber-300">
          {teethNoteText(t, note, teethNoteKey)}
        </p>
      )}
      {kitReason && (
        <p className="mt-1.5 text-xs leading-relaxed text-gray-600 dark:text-gray-300">{kitTeethText(t, kitReason)}</p>
      )}
    </div>
  );
}
