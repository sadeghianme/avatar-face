import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useSearchParams } from "react-router-dom";

import { ActionErrorNote } from "@/features/avatars/components/create/JobProgress";
import { FooterSlot, StepFooter } from "@/features/avatars/components/wizard/Footer";
import { ModelStep } from "@/features/avatars/components/wizard/ModelStep";
import { PhotoStep } from "@/features/avatars/components/wizard/PhotoStep";
import { PrepareScreen } from "@/features/avatars/components/wizard/PrepareScreen";
import { ProgressHeader } from "@/features/avatars/components/wizard/ProgressHeader";
import { PublishScreen } from "@/features/avatars/components/wizard/PublishScreen";
import {
  errorText,
  finishStage,
  forgetDraftMarks,
  isJobActive,
  jobFailure,
  stageCount,
  type Creation,
  type DraftStore,
} from "@/features/avatars/creation";
import {
  creationKey,
  draftsKey,
  useCreation,
  useCreationActions,
} from "@/features/avatars/hooks/useCreation";
import { useConsent } from "@/features/avatars/hooks/useConsent";
import {
  forgetChoices,
  isPrepareJob,
  parseModel,
  planOf,
  preparePhase,
  prepareStage,
  recallChoices,
  screenFor,
  type AvatarModel,
  type Screen,
  type WizardCreation,
} from "@/features/avatars/wizard";
import { Icon } from "@/components/ui/Icon";
import { Spinner } from "@/components/ui/Spinner";
import { api, ApiError } from "@/lib/api";

function tabStore(): DraftStore | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * The creation wizard: 1 Model · 2 Photo · 3 Prepare · 4 Publish (the
 * owner's flow; wizard.ts has the rules, services.wizard the server side).
 *
 * Steps 1 and 2 are this page (`/avatars/new`, `?model=` once one is
 * chosen), so the browser's Back goes from the photo to the model. "Create
 * my avatar" makes a creation and its id goes into the URL
 * (`/avatars/new/:id`, `?step=publish` on step 4): a reload, a shared tab
 * or the resume list lands where it should, and the creation's own state
 * decides what step 4 may show (wizard.screenFor). Back from step 3 goes
 * to step 2 as it was filled in; the draft left behind is deleted (a new
 * one is made with the next "Create").
 *
 * One heading per screen, focused on every change of screen, and one live
 * region, always mounted, for what the server is doing. Every error has a
 * next action beside it.
 */
export function NewWizard({
  orgId,
  creationId,
  children,
}: {
  orgId: string;
  creationId?: string;
  /** Shown under the step, inside its scroll area (the other ways to add an avatar). */
  children?: React.ReactNode;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [params] = useSearchParams();
  const consent = useConsent(orgId);
  const { creation: loaded, error: loadError, isLoading, refetch, apply } = useCreation(orgId, creationId);
  const creation = loaded as WizardCreation | undefined;
  const { busy, error, setError, run } = useCreationActions(apply, refetch);
  const [fixing, setFixing] = useState(false);
  // The action bar's element: the screens portal their buttons into it.
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  const model = parseModel(params.get("model"));

  const screen: Screen = !creationId ? (model ? "photo" : "model") : creation ? screenFor(creation, params.get("step")) : "prepare";

  // --- Focus follows the screen -------------------------------------------------------
  const heading = useRef<HTMLHeadingElement>(null);
  const shown = useRef<Screen | null>(null);
  useEffect(() => setError(null), [screen, setError]);
  useEffect(() => {
    if (shown.current !== null && shown.current !== screen) {
      const failure = document.getElementById("finish-failure");
      (failure ?? heading.current)?.focus();
    }
    shown.current = screen;
  }, [screen]);

  // --- Built: the avatar's page ------------------------------------------------------
  useEffect(() => {
    if (creation?.status !== "finished" || !creation.avatar_id) return;
    forgetDraftMarks(tabStore(), creation.id);
    forgetChoices(tabStore(), creation.id);
    void queryClient.invalidateQueries({ queryKey: ["avatars", orgId] });
    void queryClient.invalidateQueries({ queryKey: draftsKey(orgId) });
    navigate(`/avatars/${creation.avatar_id}`, { replace: true });
  }, [creation?.status, creation?.avatar_id, creation?.id, orgId, navigate, queryClient]);

  // --- Moves ---------------------------------------------------------------------------
  const chooseModel = (next: AvatarModel) => navigate(`/avatars/new?model=${next}`);
  const created = (next: Creation) => {
    queryClient.setQueryData(creationKey(orgId, next.id), next);
    void queryClient.invalidateQueries({ queryKey: draftsKey(orgId) });
    navigate(`/avatars/new/${next.id}`);
  };
  const backToPhoto = async () => {
    const m = creation ? planOf(creation).model : "human";
    if (creationId && creation?.status === "draft") {
      // Abandoned for a new start: gone now rather than a week from now.
      await api.delete(`/orgs/${orgId}/creations/${creationId}`).catch(() => undefined);
      forgetDraftMarks(tabStore(), creationId);
      void queryClient.invalidateQueries({ queryKey: draftsKey(orgId) });
    }
    navigate(`/avatars/new?model=${m}`);
  };
  const toPublish = () => navigate(`/avatars/new/${creationId}?step=publish`);
  const toPrepare = () => navigate(`/avatars/new/${creationId}`);

  // --- What the server is doing, said once per change --------------------------------
  const job = creation?.job ?? null;
  const pStage = prepareStage(job);
  const fStage = finishStage(job);
  const count = fStage === "shapes" ? stageCount(job) : null;
  const announcement = useMemo(() => {
    if (!job) return "";
    if (isJobActive(job)) {
      if (isPrepareJob(job) && pStage) return t(`wzStage_${pStage}`);
      if (job.state === "queued") return t("createJobQueued");
      if (!fStage) return t(`createJob_${job.step}`);
      const words = t(`createFinishStage_${fStage}`);
      return count ? `${words} ${t("mouthShapesCount", { done: count.done, total: count.total })}` : words;
    }
    const failure = jobFailure(job);
    if (failure) return errorText(t, failure.code, failure.detail);
    return job.state === "done" ? t(`createJobDone_${job.step}`) : "";
    // Transitions, not every poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.id, job?.state, pStage, fStage, count?.done, t]);

  // --- The screen ----------------------------------------------------------------------
  const gone = loadError instanceof ApiError && loadError.status === 404;
  const reconnecting = Boolean(loadError && creation && !gone);
  let title = t(`wzHeading_${screen}`);
  let intro = "";
  let body: React.ReactNode;

  if (screen === "model") {
    intro = t("wzIntro_model");
    body = (
      <>
        <ModelStep chosen={recallChoices(tabStore(), null)?.model ?? null} onChoose={chooseModel} />
        <StepFooter
          back={
            <Link to="/app" className="btn-secondary min-h-11">
              <Icon name="back" className="h-4 w-4 rtl:-scale-x-100" />
              {t("wzCancel")}
            </Link>
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
        consent={consent}
        initial={last?.model === model ? last : null}
        onBack={() => navigate("/avatars/new")}
        onCreated={created}
      />
    );
  } else if (loadError && (!creation || gone)) {
    title = t("wzHeading_prepareFailed");
    body = (
      <>
        <p role="alert" className="text-sm text-gray-600 dark:text-gray-300">
          {gone ? t("createErr_creation_not_found") : t("error")}
        </p>
        <StepFooter>
          <Link to="/avatars/new" className="btn-primary min-h-11">
            {t("createStartNew")}
          </Link>
        </StepFooter>
      </>
    );
  } else if (isLoading || !creation) {
    body = (
      <p className="flex items-center gap-2 text-sm text-gray-500">
        <Spinner className="h-4 w-4" /> {t("loading")}
      </p>
    );
  } else if (creation.status === "expired") {
    body = (
      <>
        <p className="text-sm text-gray-600 dark:text-gray-300">{t("createExpired")}</p>
        <StepFooter>
          <Link to="/avatars/new" className="btn-primary min-h-11">
            {t("createStartNew")}
          </Link>
        </StepFooter>
      </>
    );
  } else if (screen === "prepare") {
    const phase = preparePhase(creation);
    title = t(phase === "done" ? "wzHeading_prepared" : phase === "failed" ? "wzHeading_prepareFailed" : "wzHeading_prepare");
    intro = t(phase === "done" ? "wzIntro_prepared" : phase === "failed" ? "wzIntro_prepareFailed" : "wzIntro_prepare");
    body = (
      <PrepareScreen
        orgId={orgId}
        creation={creation}
        busy={busy}
        run={run}
        consent={consent}
        onBack={() => void backToPhoto()}
        onContinue={toPublish}
      />
    );
  } else {
    const building = creation.status === "finishing" || creation.status === "finished" || (job?.step === "finish" && isJobActive(job));
    title = t(building ? "wzHeading_publishing" : fixing ? "wzHeading_fix" : "wzHeading_publish");
    intro = t(building ? "wzIntro_publishing" : fixing ? "wzIntro_fix" : "wzIntro_publish");
    body = (
      <PublishScreen
        orgId={orgId}
        creation={creation}
        busy={busy}
        run={run}
        consent={consent}
        refetch={refetch}
        clearError={() => setError(null)}
        onBack={toPrepare}
        onFixing={setFixing}
      />
    );
  }

  const actionError = error ? errorText(t, error.code, error.detail, error.retryAfter) : null;
  return (
    <FooterSlot value={slot}>
      {/* The progress stays at the top of the content area, full-bleed
          across it (the main column's padding undone), the steps centred. */}
      <div className="sticky top-14 z-20 -mx-5 border-b border-black/[0.06] bg-white/85 px-5 backdrop-blur-xl dark:border-white/[0.06] dark:bg-ink/85 sm:-mx-8 sm:px-8 lg:-mx-10 lg:px-10">
        <ProgressHeader screen={screen} />
      </div>

      {/* The step scrolls between the bars; its foot is padded past the
          fixed action bar (and the iPhone's home indicator under it). */}
      <section
        aria-labelledby="wizard-heading"
        className="pb-[calc(7.5rem+env(safe-area-inset-bottom))] pt-6 sm:pt-8"
      >
        <header className="mb-6 sm:mb-7">
          <p className="mb-1 text-sm font-medium text-gray-500 dark:text-gray-400">{t("wzTitle")}</p>
          {/* Focused on every change of screen, for screen readers: no
              ring, it is not a control. */}
          <h1
            id="wizard-heading"
            ref={heading}
            tabIndex={-1}
            className="scroll-mt-32 text-2xl font-semibold tracking-[-0.02em] outline-none sm:text-[28px]"
          >
            {title}
          </h1>
          {intro && <p className="mt-2 max-w-3xl text-sm text-gray-500 dark:text-gray-400 sm:text-[15px]">{intro}</p>}
        </header>
        {reconnecting && (
          <p className="mb-4 flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
            <Spinner className="h-4 w-4" /> {t("createReconnecting")}
          </p>
        )}
        {body}
        <ActionErrorNote text={actionError} />
        {children}
      </section>

      {/* The step's actions: Back on the left, the primary one on the
          right. A landmark, after the step in the DOM (Tab reaches it last),
          fixed over the content area beside the rail. */}
      <div
        role="region"
        aria-label={t("wzActionsLabel")}
        className="fixed bottom-0 end-0 start-0 z-30 border-t border-black/[0.07] bg-white/90 backdrop-blur-xl dark:border-white/[0.08] dark:bg-ink/90 lg:start-[232px]"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <div ref={setSlot} className="flex min-h-[72px] items-center px-4 py-3 sm:px-8 lg:px-10" />
      </div>

      <p className="sr-only" aria-live="polite" role="status">
        {reconnecting ? t("createReconnecting") : announcement}
      </p>
      {consent.dialog}
    </FooterSlot>
  );
}
