import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";

import { AdjustStep } from "@/features/avatars/components/create/AdjustStep";
import { BackgroundStep } from "@/features/avatars/components/create/BackgroundStep";
import { ActionErrorNote } from "@/features/avatars/components/create/JobProgress";
import { PointsStep } from "@/features/avatars/components/create/PointsStep";
import { StepIndicator } from "@/features/avatars/components/create/StepIndicator";
import { DropZone, FrameStep } from "@/features/avatars/components/create/UploadStep";
import {
  errorText,
  forgetDraftMarks,
  finishStage,
  isJobActive,
  jobFailure,
  nameFromFile,
  resolveStep,
  type Creation,
  type Framing,
  type WizardStep,
} from "@/features/avatars/creation";
import { consentProblem } from "@/features/avatars/consent";
import {
  creationKey,
  draftsKey,
  useCreation,
  useCreationActions,
} from "@/features/avatars/hooks/useCreation";
import { useConsent } from "@/features/avatars/hooks/useConsent";
import { Spinner } from "@/components/ui/Spinner";
import { api, ApiError } from "@/lib/api";
import type { FaceType } from "@/lib/types";

// The name typed nowhere yet: the upload's file name (or the one given
// under "Other ways"), kept for this tab so a reload on the points step
// still offers it. A convenience only; the points step asks.
const NAME_KEY = (id: string) => `liveface.creationName.${id}`;

export function rememberCreationName(id: string, name: string): void {
  try {
    sessionStorage.setItem(NAME_KEY(id), name);
  } catch {
    // storage blocked: the points step falls back to a default name
  }
}

function recalledName(id: string): string | null {
  try {
    return sessionStorage.getItem(NAME_KEY(id));
  } catch {
    return null;
  }
}

const HEADINGS: Record<WizardStep, string> = {
  frame: "createHeading_frame",
  background: "createHeading_background",
  adjust: "createHeading_adjust",
  points: "createHeading_points",
};

/**
 * The creation wizard: 1 Upload + frame, 2 Background, 3 AI adjust,
 * 4 Points (the owner's order; creation.WIZARD_STEPS).
 *
 * The creation's id is in the URL (/avatars/new/:id) and the step in the
 * query (?step=points), so a reload, a shared tab or the browser's Back
 * button all land where they should; without a step, the creation's own
 * state says where it was left (creation.inferStep). Each step saves when
 * it is left with Continue, and the server holds the creation. Two things
 * live in this tab only, since nothing is saved before Finish: the name
 * being typed, and the points placed so far (PointsStep keeps those in
 * sessionStorage, so stepping back or reloading does not lose them).
 *
 * A poll that fails while the creation is on screen (a deploy restarting
 * the server, Cloudflare answering 5xx meanwhile) keeps the wizard up with
 * a note; only a creation never loaded, or one that is gone (404), replaces
 * it with an error.
 *
 * Focus moves to the step's heading on every step change, and job progress
 * is announced from one live region that is always mounted.
 *
 * Every step that sends the picture to Google needs the member's
 * third-party AI statement (useConsent): step 3 asks for it inline, the
 * points step through the dialog rendered here, once, for all of them.
 * It is asked once per member and wording; the server remembers it.
 */
export function CreationWizard({ orgId, creationId }: { orgId: string; creationId?: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [params] = useSearchParams();
  const { creation, error: loadError, isLoading, refetch, apply } = useCreation(orgId, creationId);
  const { busy, error, setError, run } = useCreationActions(apply, refetch);
  const consent = useConsent(orgId);
  const base = `/orgs/${orgId}/creations/${creationId}`;

  const step: WizardStep = creation ? resolveStep(creation, params.get("step")) : "frame";
  const goTo = (next: WizardStep) => navigate(`/avatars/new/${creationId}?step=${next}`);

  const location = useLocation();
  const heading = useRef<HTMLHeadingElement>(null);
  const shown = useRef<WizardStep | null>(null);
  const focusHeading = useCallback(() => heading.current?.focus(), []);
  // An error belongs to the step it happened on.
  useEffect(() => setError(null), [step, setError]);
  useEffect(() => {
    // A step change moves focus to its heading; so does arriving from an
    // upload, since the drop zone that had focus is gone.
    const arrived = shown.current === null && (location.state as { uploaded?: boolean } | null)?.uploaded;
    if ((shown.current !== null && shown.current !== step) || arrived) heading.current?.focus();
    shown.current = step;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // Built: open the avatar. Also where a finished creation's old wizard URL
  // leads.
  useEffect(() => {
    if (creation?.status !== "finished" || !creation.avatar_id) return;
    void queryClient.invalidateQueries({ queryKey: ["avatars", orgId] });
    void queryClient.invalidateQueries({ queryKey: draftsKey(orgId) });
    navigate(`/avatars/${creation.avatar_id}`, { replace: true });
  }, [creation?.status, creation?.avatar_id, orgId, navigate, queryClient]);

  const job = creation?.job ?? null;
  // A finish's stages are transitions too ("Adding realistic teeth…"):
  // a screen reader hears the same as the bar shows.
  const stage = finishStage(job);
  const announcement = useMemo(() => {
    if (!job) return "";
    if (isJobActive(job)) {
      if (job.state === "queued") return t("createJobQueued");
      return stage ? t(`createFinishStage_${stage}`) : t(`createJob_${job.step}`);
    }
    const failure = jobFailure(job);
    if (failure) return errorText(t, failure.code, failure.detail);
    return job.state === "done" ? t(`createJobDone_${job.step}`) : "";
    // Announce transitions, not every poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.id, job?.state, stage, t]);

  const created = (next: Creation, file: File) => {
    rememberCreationName(next.id, nameFromFile(file.name));
    queryClient.setQueryData(creationKey(orgId, next.id), next);
    void queryClient.invalidateQueries({ queryKey: draftsKey(orgId) });
    navigate(`/avatars/new/${next.id}`, { state: { uploaded: true } });
  };

  const startOver = async () => {
    // "Use another photo": this one is abandoned, so it goes rather than
    // waiting a week in the resume list. Best effort; it expires anyway.
    await api.delete(base).catch(() => undefined);
    if (creationId) {
      try {
        forgetDraftMarks(window.sessionStorage, creationId);
      } catch {
        // storage blocked: nothing was kept
      }
    }
    void queryClient.invalidateQueries({ queryKey: draftsKey(orgId) });
    navigate("/avatars/new");
  };

  const saveFrame = async (change: { face_type?: FaceType; framing?: Framing }) => {
    if (change.face_type || change.framing) {
      const outcome = await run("frame", () =>
        api.patch<Creation>(base, {
          ...(change.face_type ? { face_type: change.face_type } : {}),
          ...(change.framing ? { crop: change.framing.crop, roll: change.framing.roll } : {}),
        })
      );
      if (!outcome.ok) return;
    }
    goTo("background");
  };

  // A job that sends pixels out (adjust, AI points, generating from a
  // photo) is retried on the retrying member's own consent: the one it was
  // started with may be a colleague's. Refused for that, the member is
  // asked (or their remembered consent is used) and it is tried again;
  // "Not now" leaves the job as it was.
  const retry = () =>
    void run("retry", async () => {
      try {
        return await api.post<Creation>(`${base}/retry`);
      } catch (err) {
        const problem = err instanceof ApiError ? consentProblem(err.code, err.body) : null;
        if (problem?.kind !== "required" || problem.scope !== "third_party_ai") throw err;
        const again = await consent.withAi(t("createRetryAi"), (consentId) =>
          api.post<Creation>(`${base}/retry`, { consent_id: consentId })
        );
        return again ?? creation;
      }
    });
  const gone = loadError instanceof ApiError && loadError.status === 404;
  // A failed refetch keeps the creation it had (TanStack keeps `data`).
  const reconnecting = Boolean(loadError && creation && !gone);
  const actionError = error ? errorText(t, error.code, error.detail, error.retryAfter) : null;

  let body: React.ReactNode;
  if (!creationId) {
    body = (
      <div className="space-y-4">
        <DropZone orgId={orgId} headingId="wizard-heading" onCreated={created} />
        <button type="button" className="btn-secondary min-h-11" onClick={() => navigate("/app")}>
          {t("createBack")}
        </button>
      </div>
    );
  } else if (loadError && (!creation || gone)) {
    body = (
      <div className="space-y-4">
        <p role="alert" className="text-sm text-gray-600 dark:text-gray-300">
          {gone ? t("createErr_creation_not_found") : t("error")}
        </p>
        <Link to="/avatars/new" className="btn-primary min-h-11">
          {t("createStartNew")}
        </Link>
      </div>
    );
  } else if (isLoading || !creation) {
    body = (
      <p className="flex items-center gap-2 text-sm text-gray-500">
        <Spinner className="h-4 w-4" /> {t("loading")}
      </p>
    );
  } else if (creation.status === "expired") {
    body = (
      <div className="space-y-4">
        <p className="text-sm text-gray-600 dark:text-gray-300">{t("createExpired")}</p>
        <Link to="/avatars/new" className="btn-primary min-h-11">
          {t("createStartNew")}
        </Link>
      </div>
    );
  } else if (step === "frame") {
    body = (
      <FrameStep
        creation={creation}
        busy={busy}
        onContinue={(change) => void saveFrame(change)}
        onRetry={retry}
        onStartOver={() => void startOver()}
        onBack={() => navigate("/app")}
      />
    );
  } else if (step === "background") {
    body = (
      <BackgroundStep
        creation={creation}
        busy={busy}
        onChoose={(mode) => void run("background", () => api.post<Creation>(`${base}/background`, { mode }))}
        onRetry={retry}
        onContinue={() => goTo("adjust")}
        onBack={() => goTo("frame")}
      />
    );
  } else if (step === "adjust") {
    body = (
      <AdjustStep
        orgId={orgId}
        creation={creation}
        busy={busy}
        run={run}
        consent={consent}
        onRetry={retry}
        onContinue={() => goTo("points")}
        onBack={() => goTo("background")}
        onStartOver={() => void startOver()}
      />
    );
  } else {
    body = (
      <PointsStep
        orgId={orgId}
        creation={creation}
        busy={busy}
        run={run}
        refetch={refetch}
        withAi={consent.withAi}
        recordConsent={consent.record}
        defaultName={recalledName(creation.id) || t("createDefaultName")}
        onBack={() => goTo("adjust")}
        onFocusLost={focusHeading}
      />
    );
  }

  const finishing = creation?.status === "finishing" || creation?.status === "finished";
  return (
    <div>
      <h1 className="mb-5 text-2xl font-semibold tracking-[-0.02em]">{t("newAvatar")}</h1>
      <StepIndicator step={step} onGo={creation ? goTo : undefined} locked={finishing} />
      <section aria-labelledby="wizard-heading" className="card">
        <h2
          id="wizard-heading"
          ref={heading}
          tabIndex={-1}
          className="mb-1 text-lg font-semibold outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        >
          {t(HEADINGS[step])}
        </h2>
        <p className="mb-5 text-sm text-gray-500 dark:text-gray-400">{t(`createIntro_${step}`)}</p>
        {reconnecting && (
          <p className="mb-4 flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
            <Spinner className="h-4 w-4" /> {t("createReconnecting")}
          </p>
        )}
        {body}
        <ActionErrorNote text={actionError} />
      </section>
      {/* Always mounted, so a change is read out; a region mounted with its
          text is not reliably announced. */}
      <p className="sr-only" aria-live="polite" role="status">
        {reconnecting ? t("createReconnecting") : announcement}
      </p>
      {consent.dialog}
    </div>
  );
}
