import { BackButton, StepFooter } from "@/features/avatars/components/wizard/Footer";
import { PublishEditor } from "@/features/avatars/components/wizard/publish/PublishEditor";
import { PublishingView } from "@/features/avatars/components/wizard/publish/PublishingView";
import { anchorsCurrent, isJobActive } from "@/features/avatars/creation";
import type { ConsentApi } from "@/features/avatars/hooks/useConsent";
import type { Run } from "@/features/avatars/hooks/useCreation";
import type { WizardCreation } from "@/features/avatars/wizard";
import { useT } from "@/i18n";

/**
 * Step 4: test and publish.
 *
 * The face was found on step 3; here it talks. The preview is the rig
 * Publish would build (preview-rig fits without saving), and the play
 * button reads a sample sentence through it. "Publish" builds and
 * publishes the avatar and opens its page (the wizard goes there by
 * itself once it is built); for a realistic person their own teeth and
 * mouth shapes are made meanwhile, listed with the other stages
 * (PublishingView).
 *
 * The big picture shows the points found, on by default (MarkCanvas, with
 * its 3x zoom in the corner): drag one only if it is off; Publish sends
 * them as "Fix points" did, and a refused fit says why beside them. The
 * talking preview is another canvas, so a toggle above the picture picks
 * Points or Talking preview, and playing the sample switches to it. When
 * the face was not found, the points start from the template's guess, a
 * hint says to place them, and the owner ticks that they are right
 * (PublishEditor).
 *
 * The statement about a face was made on step 2; a creation without one
 * (a draft from the old wizard) asks for it here, inline, when publishing
 * says so.
 */
export function PublishScreen({
  orgId,
  creation,
  busy,
  run,
  consent,
  refetch,
  clearError,
  onBack,
  onFixing,
}: {
  orgId: string;
  creation: WizardCreation;
  busy: string | null;
  run: Run;
  consent: ConsentApi;
  refetch: () => unknown;
  /** Drops the last request's error banner (a refusal this screen answers itself). */
  clearError: () => void;
  onBack: () => void;
  /** The editor opened or closed (the heading says which). */
  onFixing: (fixing: boolean) => void;
}) {
  const { t } = useT();
  const job = creation.job;
  const building = creation.status === "finishing" || creation.status === "finished";
  const anchors = anchorsCurrent(creation) ? creation.anchors : null;

  if (building || (job?.step === "finish" && isJobActive(job))) {
    return <PublishingView creation={creation} aiConsentId={consent.aiConsentId} />;
  }

  if (!anchors) {
    // Nothing to publish from: the picture changed under this tab.
    return (
      <>
        <p className="text-sm text-gray-600 dark:text-gray-300">{t("createErr_anchors_stale")}</p>
        <StepFooter back={<BackButton onClick={onBack} />} />
      </>
    );
  }

  return (
    <PublishEditor
      key={anchors.id}
      orgId={orgId}
      creation={creation}
      anchors={anchors}
      busy={busy}
      run={run}
      consent={consent}
      refetch={refetch}
      clearError={clearError}
      onBack={onBack}
      onFixing={onFixing}
    />
  );
}
