import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { FieldError } from "@/components/ui/FieldError";
import { ScriptField } from "@/features/lab/components/PlaybackControls";
import { ReferenceFitControls } from "@/features/lab/components/ReferenceFitControls";
import { ReferencePhotoUpload } from "@/features/lab/components/ReferencePhotoUpload";
import { SpeechStreamStatus } from "@/features/lab/components/SpeechStreamStatus";
import type { ReferenceWorkspace } from "@/features/lab/hooks/useReferenceWorkspace";
import { REFERENCE_SCRIPT_ID } from "@/features/lab/reference-avatar";
import { VoicePicker } from "@/features/voices";
import { useT } from "@/i18n";
import type { Avatar } from "@/lib/types";

/**
 * Beside the bench: the avatar's quality note, the member's own mouth
 * photo (not for the authored sample), the fit profile, and the speech to
 * test with (a server voice and a script).
 */
export function ReferenceSidebar({
  avatar,
  orgId,
  bench,
}: {
  avatar: Avatar;
  orgId: string;
  bench: ReferenceWorkspace;
}) {
  const { t } = useT();
  const { authored, photographic, oralPhoto, comparison } = bench;
  return (
    <aside className="space-y-5">
      {avatar.quality_note && (
        <p
          role="status"
          className="rounded-xl bg-amber-50 p-4 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-200"
        >
          {avatar.quality_note}
        </p>
      )}
      {!authored && <ReferencePhotoUpload orgId={orgId} purpose="mouth" onUploaded={bench.setOralPhoto} />}
      {!authored && photographic && (
        <p className="text-xs text-gray-500">
          {t(oralPhoto ? "referenceOwnMouthActive" : "referenceFittedMouthActive")}
        </p>
      )}
      {oralPhoto && (
        <Button variant="secondary" onClick={() => bench.setOralPhoto(null)}>
          {t("referenceRemoveMouth")}
        </Button>
      )}
      <ReferenceFitControls
        {...bench.draft}
        continuous={photographic}
        photographic={photographic && (authored || Boolean(oralPhoto))}
      />
      <Card as="section" id="reference-speech" className="scroll-mt-6 space-y-4">
        <h3 className="font-semibold">{t("lipSyncTestTitle")}</h3>
        <SpeechStreamStatus {...comparison} />
        <VoicePicker value={bench.voice} onChange={bench.setVoice} />
        {!bench.supported && <p className="text-sm text-amber-700 dark:text-amber-300">{t("lipSyncServerOnly")}</p>}
        <ScriptField id={REFERENCE_SCRIPT_ID} text={bench.text} onChange={bench.setText} className="min-h-40" />
        <Button
          fullWidth
          disabled={!bench.ready || !bench.supported || !bench.text.trim() || comparison.busy || comparison.playing}
          onClick={bench.generate}
        >
          {t(comparison.busy ? "lipSyncPreparing" : "lipSyncGenerate")}
        </Button>
        {comparison.error && <FieldError>{comparison.error}</FieldError>}
      </Card>
    </aside>
  );
}
