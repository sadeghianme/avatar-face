import type { CSSProperties } from "react";

import { Banner } from "@/components/ui/Banner";
import { BackButton, StepFooter } from "@/features/avatars/components/wizard/Footer";
import { Result, Working } from "@/features/avatars/components/wizard/Pictures";
import { ChangeForm, ResultNote } from "@/features/avatars/components/wizard/prepare/ChangeForm";
import { PrepareBar } from "@/features/avatars/components/wizard/prepare/PrepareBar";
import { AiAgreement, PrepareFailed } from "@/features/avatars/components/wizard/prepare/PrepareNotices";
import { VersionStrip } from "@/features/avatars/components/wizard/Versions";
import type { ConsentApi } from "@/features/avatars/hooks/useConsent";
import type { Run } from "@/features/avatars/hooks/useCreation";
import { usePrepareScreen } from "@/features/avatars/hooks/usePrepareScreen";
import { footerPlan, selectedVersion, versionsOf, type WizardCreation } from "@/features/avatars/wizard";
import { useT } from "@/i18n";

/** The picture's width for its height to fit between the bars (the
 * header, the progress and the title above, the action bar below). */
function fitPicture(step: { width: number; height: number }): CSSProperties {
  const ratio = Math.max(1, step.width) / Math.max(1, step.height);
  return { maxWidth: `max(${Math.round(300 * ratio)}px, min(100%, calc((100dvh - 23.5rem) * ${ratio})))` };
}

/**
 * Step 3: the picture the avatar is made of, made by itself.
 *
 * It starts on arrival: the AI in the chosen look when the owner agreed to
 * it on step 2 (or had before), else, for a realistic upload, the photo
 * itself cut out (usePrepareScreen). While it works, the photo sits under a
 * shimmer with the stages ticked off (Working). Then the result, big,
 * compared with the upload on a slider; Retry, "Describe a change" (the
 * owner's words, on the picture made), and for a realistic upload "Use my
 * original photo". Nothing is lost by any of them: every version is kept,
 * in a strip under the picture, and choosing one makes it the picture used
 * (the server's POST /version, so a reload shows the same).
 * Every failure says why and what to do next: try again, use the photo as
 * it is, or go Back and change what was given.
 */
export function PrepareScreen({
  orgId,
  creation,
  busy,
  run,
  consent,
  onBack,
  onContinue,
}: {
  orgId: string;
  creation: WizardCreation;
  busy: string | null;
  run: Run;
  consent: ConsentApi;
  onBack: () => void;
  onContinue: () => void;
}) {
  const { t } = useT();
  const prepare = usePrepareScreen({ orgId, creation, busy, run, consent });
  const { plan, phase, result, before, working, stage, askAi } = prepare;
  const footer = footerPlan("prepare", { prepared: Boolean(result) });
  const backButton = <BackButton onClick={onBack} disabled={busy !== null} />;

  if (!result) {
    if (working || (phase === "waiting" && !askAi)) {
      const original = prepare.lastWasOriginal || prepare.choices?.intent === "original";
      return (
        <>
          <Working
            before={before}
            model={plan.model}
            look={plan.look}
            stages={prepare.stages}
            stage={working ? stage : "upload"}
            fraction={prepare.fraction}
            hint={t(original ? "wzWorkingHintOriginal" : "wzWorkingHint")}
          />
          <StepFooter back={footer.back && backButton} />
        </>
      );
    }
    // Failed with nothing to show, or waiting for the owner's agreement.
    return (
      <div className="max-w-2xl space-y-5">
        {prepare.failureText && phase === "failed" && <PrepareFailed prepare={prepare} busy={busy} onBack={onBack} />}
        {askAi && <AiAgreement prepare={prepare} busy={busy} />}
        <StepFooter back={footer.back && backButton} />
      </div>
    );
  }

  const switching = busy === "version";
  return (
    // Three cells. On a phone, a column in this order: the picture, the
    // versions, then the words and the change box. From a laptop up, the
    // picture on the left spans both rows (as tall as the viewport allows),
    // the words and the change box top right, and the versions under them
    // where the right column had room to spare; below the picture they fell
    // under the fixed bar on a 1440x900 screen.
    <div className="grid gap-x-8 gap-y-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:grid-rows-[auto_1fr] lg:gap-y-6 xl:gap-x-12">
      <div className="min-w-0 lg:row-span-2">
        {/* As big as Publish's: as tall as the viewport allows down to the
            bar, in the result's own shape. */}
        <div className="mx-auto w-full" style={fitPicture(result)}>
          <Result
            before={before}
            after={result}
            busy={prepare.redoing || switching}
            busyLabel={switching ? t("wzVersionLoading") : stage ? t(`wzStage_${stage}`) : t("wzStage_create")}
          />
        </div>
      </div>

      <VersionStrip
        versions={versionsOf(creation)}
        selected={selectedVersion(creation)}
        pending={prepare.pending}
        disabled={prepare.redoing || busy !== null}
        onChoose={prepare.chooseVersion}
        className="lg:col-start-2 lg:row-start-2 lg:self-start"
      />

      <div className="flex flex-col gap-5 lg:col-start-2 lg:row-start-1">
        <ResultNote prepare={prepare} busy={busy} />

        {prepare.failureText && !prepare.redoing && (
          <Banner appearance="soft" tone="warning" icon="alert" role="alert">
            {prepare.failureText}
          </Banner>
        )}

        {askAi && <AiAgreement prepare={prepare} busy={busy} />}

        {prepare.canAi && !askAi && <ChangeForm prepare={prepare} busy={busy} />}

        {prepare.aiOn && (
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {prepare.tries > 0 ? t("wzTriesLeft", { count: prepare.tries }) : t("wzNoTries")}
          </p>
        )}
      </div>

      <PrepareBar prepare={prepare} busy={busy} onBack={onBack} onContinue={onContinue} />
    </div>
  );
}
