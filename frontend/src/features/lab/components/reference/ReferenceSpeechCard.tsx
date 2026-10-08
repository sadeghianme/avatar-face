import type { RefObject } from "react";

import { Card } from "@/components/ui/Card";
import { PlaybackButtons } from "@/features/lab/components/PlaybackControls";
import { ReferenceRecording } from "@/features/lab/components/ReferenceRecording";
import type { ReferenceWorkspace } from "@/features/lab/hooks/useReferenceWorkspace";
import { useT } from "@/i18n";

/**
 * The phrase both previews speak on one clock: where it is, Replay, Pause
 * and Stop, where its timing came from, and the side-by-side recording;
 * then what to check, and what this prototype cannot do yet.
 */
export function ReferenceSpeechCard({
  bench,
  previews,
}: {
  bench: ReferenceWorkspace;
  previews: RefObject<HTMLElement>;
}) {
  const { t } = useT();
  const { comparison, ready, photographic } = bench;
  return (
    <>
      <Card as="section" className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-semibold">{t("referenceSpeech")}</h3>
          <span className="font-mono text-xs text-gray-500">
            {comparison.position.toFixed(1)} / {comparison.duration.toFixed(1)} s
          </span>
        </div>
        <p className="text-sm leading-relaxed text-gray-500">{t("referenceSameTiming")}</p>
        <progress
          className="h-1.5 w-full accent-orange-500"
          aria-label={t("lipSyncProgress")}
          max={comparison.duration || 1}
          value={comparison.position}
        />
        <PlaybackButtons
          comparison={comparison}
          ready={ready}
          onReplay={bench.replay}
          onStop={() => bench.freeze("rest")}
        />
        <p role="status" className="text-xs leading-relaxed text-gray-500">
          {t(
            !comparison.payload
              ? "lipSyncBeforeTest"
              : comparison.payload.timing_source === "native_phonemes"
                ? "referenceNative"
                : "referenceFallback"
          )}
        </p>
        <p className="text-xs text-gray-500">{t("lipSyncReplayHint")}</p>
        <ReferenceRecording
          previews={previews}
          enabled={Boolean(comparison.payload && ready && !comparison.busy && !comparison.playing)}
          replay={comparison.replay}
          beforeReplay={bench.unfreeze}
          photographic={photographic}
          mouthOnly={bench.mouthOnly}
        />
      </Card>
      <Card as="section" className="space-y-3">
        <h3 className="font-semibold">{t("referenceAcceptance")}</h3>
        <ul className="list-disc space-y-2 pl-5 text-sm leading-relaxed text-gray-500">
          <li>{t("referenceCheckClosure")}</li>
          <li>{t("referenceCheckTeeth")}</li>
          <li>{t("referenceCheckIdentity")}</li>
        </ul>
        <p className="border-t border-black/10 pt-3 text-xs leading-relaxed text-gray-500 dark:border-white/10">
          {t(photographic ? "referencePhotographicLimit" : "referenceLimit")}
        </p>
      </Card>
    </>
  );
}
