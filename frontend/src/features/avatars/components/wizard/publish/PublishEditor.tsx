import { useId } from "react";

import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Spinner } from "@/components/ui/Spinner";
import { JobProgress } from "@/features/avatars/components/create/JobProgress";
import { BackButton, PhoneNote, StepFooter } from "@/features/avatars/components/wizard/Footer";
import { FaceFound, PublishChecks } from "@/features/avatars/components/wizard/publish/PublishChecks";
import { PublishPicture } from "@/features/avatars/components/wizard/publish/PublishPicture";
import { type CreationAnchors, currentStep } from "@/features/avatars/creation";
import type { ConsentApi } from "@/features/avatars/hooks/useConsent";
import type { Run } from "@/features/avatars/hooks/useCreation";
import { usePublishEditor } from "@/features/avatars/hooks/usePublishEditor";
import { footerPlan, type WizardCreation } from "@/features/avatars/wizard";
import { SampleSpeech } from "@/features/voices";
import { useT } from "@/i18n";

/**
 * Step 4 with a face to publish from: the picture with its points or the
 * talking preview (PublishPicture), what was found, the sample sentence
 * (playing it shows the talking preview), what Publish waits for
 * (PublishChecks), and Publish. The state and requests are
 * usePublishEditor's; a failed build is said at the top, with Retry.
 */
export function PublishEditor({
  orgId,
  creation,
  anchors,
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
  anchors: CreationAnchors;
  busy: string | null;
  run: Run;
  consent: ConsentApi;
  refetch: () => unknown;
  clearError: () => void;
  onBack: () => void;
  onFixing: (fixing: boolean) => void;
}) {
  const { t } = useT();
  const ids = useId();
  const editor = usePublishEditor({ orgId, creation, anchors, run, consent, refetch, clearError, onFixing });
  const { hold } = editor;
  const footer = footerPlan("publish");

  return (
    <div className="space-y-6">
      {editor.failure && creation.job && (
        <div id="finish-failure" tabIndex={-1} className="outline-none">
          <JobProgress job={creation.job} onRetry={hold ? undefined : editor.publish} retrying={busy !== null} />
        </div>
      )}

      <div className="grid gap-8 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] xl:gap-12">
        {/* The picture, big, with its points on. */}
        <div className="min-w-0">
          <PublishPicture
            editor={editor}
            texture={currentStep(creation)?.url ?? ""}
            imageSize={anchors.image_size}
            faceType={creation.face_type}
          />
        </div>

        {/* What was found, the sample, the name. */}
        <div className="flex flex-col gap-5">
          <FaceFound editor={editor} busy={busy !== null} />

          {/* Playing the sample shows the talking preview. */}
          <div onClickCapture={() => editor.setView("preview")}>
            <SampleSpeech
              engine={editor.engine}
              orgId={orgId}
              text={t("wzSample")}
              labels={{ play: t("wzPlay"), stop: t("wzStop") }}
            />
            {editor.previewError && (
              <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">{editor.previewError}</p>
            )}
          </div>

          <PublishChecks editor={editor} />

          {hold && <PhoneNote id={`${ids}-hold`}>{t(hold)}</PhoneNote>}
        </div>
      </div>

      <StepFooter
        back={footer.back && <BackButton onClick={onBack} disabled={busy !== null} />}
        note={hold ? t(hold) : null}
      >
        {footer.primary === "publish" && (
          <Button
            size="xl"
            className="px-6 shadow-sm shadow-brand-600/20 sm:px-7"
            icon={
              busy === "finish" ? (
                <Spinner className="h-4 w-4" />
              ) : (
                <Icon name="bolt" className="h-4 w-4" strokeWidth={1.9} />
              )
            }
            onClick={editor.publish}
            disabled={Boolean(hold) || busy !== null}
            aria-describedby={hold ? `${ids}-hold` : undefined}
          >
            {t("wzPublish")}
          </Button>
        )}
      </StepFooter>
    </div>
  );
}
