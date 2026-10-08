import type { RefObject } from "react";

import { Card } from "@/components/ui/Card";
import { LipSyncPreview } from "@/features/lab/components/LipSyncPreview";
import type { ReferenceWorkspace } from "@/features/lab/hooks/useReferenceWorkspace";
import { useT } from "@/i18n";
import type { Avatar } from "@/lib/types";

/**
 * The two previews side by side: the baseline mouth, and the candidate
 * (the photographic one, or the geometric reference), on the same clock
 * and in the same pose. The photographic one waits for its performance,
 * and says why when it cannot have it.
 */
export function ReferenceCompare({
  avatar,
  bench,
  previews,
}: {
  avatar: Avatar;
  bench: ReferenceWorkspace;
  /** The pair, for the recording (ReferenceRecording films this box). */
  previews: RefObject<HTMLElement>;
}) {
  const { t } = useT();
  const { comparison, photographic, performance, performanceError } = bench;
  return (
    <section ref={previews} className="grid gap-4 md:grid-cols-2" aria-label={t("referenceCompare")}>
      <Card as="figure" className="p-3">
        <figcaption className="mb-3 px-1">
          <h3 className="text-sm font-semibold">{t("referenceBaseline")}</h3>
          <p className="mt-1 text-xs text-gray-500">{t("referenceBaselineHint")}</p>
        </figcaption>
        <LipSyncPreview
          avatar={avatar}
          clock={comparison.clock}
          pose={bench.readPose}
          still
          mouthOnly={bench.mouthOnly}
          onEngine={bench.baselineReady}
        />
      </Card>
      <Card as="figure" className="border-brand-300 p-3 dark:border-brand-700">
        <figcaption className="mb-3 px-1">
          <h3 className="text-sm font-semibold text-brand-600 dark:text-brand-300">
            {t(photographic ? "referencePhotographic" : "referenceCandidate")}
          </h3>
          <p className="mt-1 text-xs text-gray-500">
            {t(photographic ? "referencePhotographicHint" : "referenceCandidateHint")}
          </p>
        </figcaption>
        {photographic && !performance ? (
          <div
            className="grid aspect-square place-items-center rounded-xl bg-gray-100 p-6 text-center text-sm dark:bg-gray-800"
            role={performanceError ? "alert" : "status"}
          >
            {t(
              performanceError === "teeth"
                ? "referenceTeethPhotoError"
                : performanceError
                  ? "referencePerformanceError"
                  : "referencePerformanceLoading"
            )}
          </div>
        ) : (
          <LipSyncPreview
            key={photographic ? "photographic" : "geometry"}
            avatar={avatar}
            clock={comparison.clock}
            pose={bench.readPose}
            still
            mouthOnly={bench.mouthOnly}
            mouthExtension={photographic ? performance! : bench.mouth}
            onEngine={bench.candidateReady}
          />
        )}
      </Card>
    </section>
  );
}
