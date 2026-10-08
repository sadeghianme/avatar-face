import type { ReactNode } from "react";

import { ButtonLink } from "@/components/ui/ButtonLink";
import { Icon } from "@/components/ui/Icon";
import { Spinner } from "@/components/ui/Spinner";
import { ActionErrorNote } from "@/features/avatars/components/create/JobProgress";
import { StepFooter } from "@/features/avatars/components/wizard/Footer";
import { ModelStep } from "@/features/avatars/components/wizard/ModelStep";
import { PhotoStep } from "@/features/avatars/components/wizard/PhotoStep";
import { PrepareScreen } from "@/features/avatars/components/wizard/PrepareScreen";
import { PublishScreen } from "@/features/avatars/components/wizard/PublishScreen";
import { isJobActive, tabStore } from "@/features/avatars/creation";
import type { NewWizardState } from "@/features/avatars/hooks/useNewWizard";
import { FRESH_ENTRY, preparePhase, recallChoices } from "@/features/avatars/wizard";
import { useT } from "@/i18n";

/** "Start a new one", where the creation is gone or expired. */
function StartNew() {
  const { t } = useT();
  return (
    <StepFooter>
      <ButtonLink to="/avatars/new" state={FRESH_ENTRY} className="min-h-11">
        {t("createStartNew")}
      </ButtonLink>
    </StepFooter>
  );
}

/**
 * The screen the wizard is on, under its heading (focused on every change
 * of screen) and its one line of intro: the model, the photo, the
 * preparation, publishing; or why there is nothing to show (gone,
 * expired, still loading). The action error and the other ways to add an
 * avatar (`children`) follow it.
 */
export function WizardStep({ wizard, children }: { wizard: NewWizardState; children?: ReactNode }) {
  const { t } = useT();
  const { screen, model, creation, loadError, gone, orgId } = wizard;
  const job = creation?.job ?? null;
  let title = t(`wzHeading_${screen}`);
  let intro = "";
  let body: ReactNode;

  if (screen === "model") {
    intro = t("wzIntro_model");
    body = (
      <>
        <ModelStep chosen={recallChoices(tabStore(), null)?.model ?? null} onChoose={wizard.chooseModel} />
        <StepFooter
          back={
            <ButtonLink
              to="/app"
              variant="secondary"
              className="min-h-11"
              icon={<Icon name="back" className="h-4 w-4 rtl:-scale-x-100" />}
            >
              {t("wzCancel")}
            </ButtonLink>
          }
        >
          <p className="text-end text-sm text-gray-500 dark:text-gray-400">{t("wzModelPick")}</p>
        </StepFooter>
      </>
    );
  } else if (screen === "photo" && model) {
    intro = t(`wzIntro_photo_${model}`);
    const last = recallChoices(tabStore(), null);
    body = (
      <PhotoStep
        key={model}
        orgId={orgId}
        model={model}
        consent={wizard.consent}
        initial={last?.model === model ? last : null}
        onBack={wizard.toModel}
        onCreated={wizard.created}
      />
    );
  } else if (loadError && (!creation || gone)) {
    title = t("wzHeading_prepareFailed");
    body = (
      <>
        <p role="alert" className="text-sm text-gray-600 dark:text-gray-300">
          {gone ? t("createErr_creation_not_found") : t("error")}
        </p>
        <StartNew />
      </>
    );
  } else if (wizard.isLoading || !creation) {
    body = (
      <p className="flex items-center gap-2 text-sm text-gray-500">
        <Spinner className="h-4 w-4" /> {t("loading")}
      </p>
    );
  } else if (creation.status === "expired") {
    body = (
      <>
        <p className="text-sm text-gray-600 dark:text-gray-300">{t("createExpired")}</p>
        <StartNew />
      </>
    );
  } else if (screen === "prepare") {
    const phase = preparePhase(creation);
    title = t(
      phase === "done" ? "wzHeading_prepared" : phase === "failed" ? "wzHeading_prepareFailed" : "wzHeading_prepare"
    );
    intro = t(phase === "done" ? "wzIntro_prepared" : phase === "failed" ? "wzIntro_prepareFailed" : "wzIntro_prepare");
    body = (
      <PrepareScreen
        orgId={orgId}
        creation={creation}
        busy={wizard.busy}
        run={wizard.run}
        consent={wizard.consent}
        onBack={wizard.backToPhoto}
        onContinue={wizard.toPublish}
      />
    );
  } else {
    const building =
      creation.status === "finishing" || creation.status === "finished" || (job?.step === "finish" && isJobActive(job));
    const { fixing } = wizard;
    title = t(building ? "wzHeading_publishing" : fixing ? "wzHeading_fix" : "wzHeading_publish");
    intro = t(building ? "wzIntro_publishing" : fixing ? "wzIntro_fix" : "wzIntro_publish");
    body = (
      <PublishScreen
        orgId={orgId}
        creation={creation}
        busy={wizard.busy}
        run={wizard.run}
        consent={wizard.consent}
        refetch={wizard.refetch}
        clearError={wizard.clearError}
        onBack={wizard.toPrepare}
        onFixing={wizard.setFixing}
      />
    );
  }

  return (
    // The step scrolls between the bars; its foot is padded past the
    // fixed action bar (and the iPhone's home indicator under it).
    <section aria-labelledby="wizard-heading" className="pb-[calc(7.5rem+env(safe-area-inset-bottom))] pt-6 sm:pt-8">
      <header className="mb-6 sm:mb-7">
        <p className="mb-1 text-sm font-medium text-gray-500 dark:text-gray-400">{t("wzTitle")}</p>
        {/* Focused on every change of screen, for screen readers: no
            ring, it is not a control. */}
        <h1
          id="wizard-heading"
          ref={wizard.heading}
          tabIndex={-1}
          className="scroll-mt-32 text-2xl font-semibold tracking-[-0.02em] outline-none sm:text-[28px]"
        >
          {title}
        </h1>
        {intro && <p className="mt-2 max-w-3xl text-sm text-gray-500 dark:text-gray-400 sm:text-[15px]">{intro}</p>}
      </header>
      {wizard.reconnecting && (
        <p className="mb-4 flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
          <Spinner className="h-4 w-4" /> {t("createReconnecting")}
        </p>
      )}
      {body}
      <ActionErrorNote text={wizard.actionError} />
      {children}
    </section>
  );
}
