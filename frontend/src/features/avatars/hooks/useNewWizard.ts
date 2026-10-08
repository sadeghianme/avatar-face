import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";

import { useCreationCache, useDeleteCreation } from "@/features/avatars/api";
import {
  type Creation,
  errorText,
  finishStage,
  forgetDraftMarks,
  isJobActive,
  jobFailure,
  stageCount,
  tabStore,
} from "@/features/avatars/creation";
import { useConsent } from "@/features/avatars/hooks/useConsent";
import { useCreation, useCreationActions } from "@/features/avatars/hooks/useCreation";
import {
  type AvatarModel,
  forgetChoices,
  forgetLastChoices,
  isFreshEntry,
  isPrepareJob,
  parseModel,
  planOf,
  prepareStage,
  type Screen,
  screenFor,
  startFresh,
  type WizardCreation,
} from "@/features/avatars/wizard";
import { useT } from "@/i18n";
import { ApiError } from "@/lib/api";

/**
 * The creation wizard's state (NewWizard draws it): which screen the URL
 * and the creation's own state say to show, the creation (polled) and the
 * requests on it, the moves between screens, the focus that follows the
 * screen, the avatar's page once it is built, and what the server is
 * doing, in words for the live region.
 */
export function useNewWizard(orgId: string, creationId: string | undefined) {
  const { t } = useT();
  const navigate = useNavigate();
  const location = useLocation();
  const creationCache = useCreationCache(orgId);
  const deleteCreation = useDeleteCreation(orgId);
  const [params] = useSearchParams();
  const consent = useConsent(orgId);

  // --- A fresh start -------------------------------------------------------------------
  // "New avatar" arrives with FRESH_ENTRY in its state: every step at its
  // default. The last choices are forgotten before this render reads them
  // (no flash of the old model or description), once per arrival, and the
  // state is then replaced so the browser's Back to this entry is not a
  // fresh start again.
  const freshened = useRef<string | null>(null);
  if (isFreshEntry(location.state) && freshened.current !== location.key) {
    freshened.current = location.key;
    startFresh(tabStore(), location.state);
  }
  useEffect(() => {
    if (!isFreshEntry(location.state)) return;
    navigate({ pathname: location.pathname, search: location.search }, { replace: true, state: null });
  }, [location.key, location.state, location.pathname, location.search, navigate]);
  const { creation: loaded, error: loadError, isLoading, refetch, apply } = useCreation(orgId, creationId);
  const creation = loaded as WizardCreation | undefined;
  const { busy, error, setError, run } = useCreationActions(apply, refetch);
  const [fixing, setFixing] = useState(false);
  const model = parseModel(params.get("model"));

  const screen: Screen = !creationId
    ? model
      ? "photo"
      : "model"
    : creation
      ? screenFor(creation, params.get("step"))
      : "prepare";

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
    // The next avatar starts from nothing, not from this one's choices.
    forgetLastChoices(tabStore());
    creationCache.finished();
    navigate(`/avatars/${creation.avatar_id}`, { replace: true });
  }, [creation?.status, creation?.avatar_id, creation?.id, navigate, creationCache]);

  // --- Moves ---------------------------------------------------------------------------
  const backToPhoto = async () => {
    const m = creation ? planOf(creation).model : "human";
    if (creationId && creation?.status === "draft") {
      // Abandoned for a new start: gone now rather than a week from now.
      await deleteCreation.mutateAsync(creationId).catch(() => undefined);
      forgetDraftMarks(tabStore(), creationId);
    }
    navigate(`/avatars/new?model=${m}`);
  };

  // --- What the server is doing, said once per change --------------------------------
  const job = creation?.job ?? null;
  const pStage = prepareStage(job);
  const fStage = finishStage(job);
  const count = fStage === "shapes" ? stageCount(job) : null;
  // Spoken when its words change, not on every poll: a live region says a
  // change of its text, and a poll that moves nothing leaves the same words.
  const announcement = (() => {
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
  })();

  const gone = loadError instanceof ApiError && loadError.status === 404;
  return {
    orgId,
    creationId,
    screen,
    model,
    creation,
    loadError,
    isLoading,
    /** The creation could not be had: it is gone, or it never loaded. */
    gone,
    /** The creation is shown as last fetched while the polling fails. */
    reconnecting: Boolean(loadError && creation && !gone),
    refetch,
    busy,
    run,
    clearError: () => setError(null),
    actionError: error ? errorText(t, error.code, error.detail, error.retryAfter) : null,
    consent,
    fixing,
    setFixing,
    heading,
    announcement,
    chooseModel: (next: AvatarModel) => navigate(`/avatars/new?model=${next}`),
    toModel: () => navigate("/avatars/new"),
    created: (next: Creation) => {
      creationCache.created(next);
      navigate(`/avatars/new/${next.id}`);
    },
    backToPhoto: () => void backToPhoto(),
    toPublish: () => navigate(`/avatars/new/${creationId}?step=publish`),
    toPrepare: () => navigate(`/avatars/new/${creationId}`),
  };
}

export type NewWizardState = ReturnType<typeof useNewWizard>;
