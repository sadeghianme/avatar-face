import { CloneJobsCards } from "@/features/voices/components/CloneJobsCards";
import { RecordVoiceCard } from "@/features/voices/components/RecordVoiceCard";
import { useVoicesPage } from "@/features/voices/hooks/useVoicesPage";
import { useT } from "@/i18n";

/**
 * Record a voice, queue the clone, watch it render, play the result.
 *
 * The rendering itself happens on the operator's own hardware (see
 * scripts/clone_worker.py) because the server has no GPU — this page is the
 * whole human side of that: everything from microphone to playback, no
 * terminal anywhere. The state and requests are useVoicesPage's.
 */
export function VoicesPage() {
  const { t } = useT();
  const page = useVoicesPage();
  return (
    <div>
      <h1 className="text-2xl font-semibold">{t("voicesTitle")}</h1>
      <p className="mb-6 mt-1 text-[13px] max-lg:text-sm text-gray-500 dark:text-gray-400">{t("voicesSubtitle")}</p>

      <div className="grid gap-6 lg:grid-cols-2">
        <RecordVoiceCard page={page} />
        <div className="flex flex-col gap-6">
          <CloneJobsCards page={page} />
        </div>
      </div>
    </div>
  );
}
