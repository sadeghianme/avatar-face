import type { AvatarEngine } from "@liveface/embed";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { AvatarPreview } from "@/features/avatars/components/AvatarPreview";
import { MarkCanvas } from "@/features/avatars/components/MarkCanvas";
import { JobProgress, useSeenStages } from "@/features/avatars/components/create/JobProgress";
import { PICTURE_BACKDROP } from "@/features/avatars/components/wizard/Art";
import {
  anchorsCurrent,
  currentStep,
  errorText,
  finishRows,
  isJobActive,
  jobFailure,
  mouthExpected,
  pickMarks,
  rememberFinishNotice,
  type CreationAnchors,
  type DraftStore,
  type FinishResult,
  type PreviewRig,
} from "@/features/avatars/creation";
import { consentProblem, type FaceStatement } from "@/features/avatars/consent";
import { FIT_REASON_LABELS, type FaceMarks, type FitReason } from "@/features/avatars/face-marks";
import type { ConsentApi } from "@/features/avatars/hooks/useConsent";
import type { Run } from "@/features/avatars/hooks/useCreation";
import { LINES } from "@/features/avatars/lines";
import {
  defaultName,
  faceFound,
  planOf,
  recallChoices,
  type WizardCreation,
} from "@/features/avatars/wizard";
import { SampleSpeech } from "@/features/voices";
import { Icon } from "@/components/ui/Icon";
import { Spinner } from "@/components/ui/Spinner";
import { api, ApiError } from "@/lib/api";

// The preview follows moved points this long after the last move.
const PREVIEW_DELAY_MS = 400;
const PARTS = ["eyes", "lips", "head"] as const;

function tabStore(): DraftStore | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Step 4: test and publish.
 *
 * The face was found on step 3; here it talks. The preview is the rig
 * Publish would build (preview-rig fits without saving), and the play
 * button reads a sample sentence through it. "Publish" builds and
 * publishes the avatar and opens its page (the wizard goes there by
 * itself once it is built); for a realistic person their own teeth and
 * mouth shapes are made meanwhile, listed with the other stages.
 *
 * The points editor (MarkCanvas) shows only when the face was not found
 * (a template's guess: the owner places the points and says they are
 * right), or on "Fix points". Its preview follows the points.
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
  onBack,
  onFixing,
}: {
  orgId: string;
  creation: WizardCreation;
  busy: string | null;
  run: Run;
  consent: ConsentApi;
  refetch: () => unknown;
  onBack: () => void;
  /** The editor opened or closed (the heading says which). */
  onFixing: (fixing: boolean) => void;
}) {
  const { t } = useTranslation();
  const job = creation.job;
  const seen = useSeenStages(job);
  const building = creation.status === "finishing" || creation.status === "finished";
  const anchors = anchorsCurrent(creation) ? creation.anchors : null;

  if (building || (job?.step === "finish" && isJobActive(job))) {
    const rows = finishRows(job, mouthExpected(creation, consent.aiConsentId), seen);
    const mouth = rows.some((row) => (row.phase === "shapes" || row.phase === "teeth") && row.state !== "skipped");
    return (
      <div className="mx-auto max-w-lg space-y-4 py-2">
        <PublishingPicture creation={creation} />
        {job && isJobActive(job) ? (
          <JobProgress job={job} rows={rows} />
        ) : (
          <p className="flex items-center justify-center gap-2 text-sm">
            <Spinner className="h-4 w-4 text-brand-600" /> {t("createFinished")}
          </p>
        )}
        {mouth && <p className="text-center text-xs text-gray-500 dark:text-gray-400">{t("wzMouthKitNote")}</p>}
      </div>
    );
  }

  if (!anchors) {
    // Nothing to publish from: the picture changed under this tab.
    return (
      <div className="space-y-4">
        <p className="text-sm text-gray-600 dark:text-gray-300">{t("createErr_anchors_stale")}</p>
        <button type="button" className="btn-primary min-h-11" onClick={onBack}>
          <Icon name="back" className="h-4 w-4 rtl:-scale-x-100" />
          {t("wzBack")}
        </button>
      </div>
    );
  }

  return (
    <Editor
      key={anchors.id}
      orgId={orgId}
      creation={creation}
      anchors={anchors}
      busy={busy}
      run={run}
      consent={consent}
      refetch={refetch}
      onBack={onBack}
      onFixing={onFixing}
    />
  );
}

function PublishingPicture({ creation }: { creation: WizardCreation }) {
  const image = currentStep(creation);
  if (!image) return null;
  return (
    <div className={`relative mx-auto aspect-square w-48 overflow-hidden rounded-full border-4 border-white shadow-xl dark:border-raised ${PICTURE_BACKDROP}`}>
      <img src={image.url} alt="" className="absolute inset-0 h-full w-full object-cover object-top" />
      <span aria-hidden="true" className="absolute inset-0 rounded-full ring-2 ring-brand-500/60 motion-safe:animate-glow" />
    </div>
  );
}

function Editor({
  orgId,
  creation,
  anchors,
  busy,
  run,
  consent,
  refetch,
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
  onBack: () => void;
  onFixing: (fixing: boolean) => void;
}) {
  const { t } = useTranslation();
  const ids = useId();
  const base = `/orgs/${orgId}/creations/${creation.id}`;
  const plan = planOf(creation);
  const line = LINES[creation.face_type ?? "human"];
  const found = faceFound(anchors);
  const image = currentStep(creation);
  const [fixing, setFixingState] = useState(!found);
  const [marks, setMarks] = useState<FaceMarks>(anchors.marks);
  const [confirmed, setConfirmed] = useState(false);
  const [reasons, setReasons] = useState<FitReason[]>(anchors.validation.reasons);
  const [rigUrl, setRigUrl] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [engine, setEngine] = useState<AvatarEngine | null>(null);
  const [statementScope, setStatementScope] = useState<FaceStatement | null>(null);
  const [statement, setStatement] = useState(false);
  const latest = useRef(0);
  const edited = JSON.stringify(marks) !== JSON.stringify(anchors.marks);

  const setFixing = (next: boolean) => {
    setFixingState(next);
    onFixing(next);
  };
  useEffect(() => {
    onFixing(!found);
    // Once, for these anchors (the editor is keyed by them).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Blob URLs are a real allocation: each is dropped when replaced.
  useEffect(() => () => {
    if (rigUrl) URL.revokeObjectURL(rigUrl);
  }, [rigUrl]);

  // The rig Publish would build, fitted without saving; only the newest
  // answer lands.
  useEffect(() => {
    const request = ++latest.current;
    const timer = window.setTimeout(async () => {
      try {
        const result = await api.post<PreviewRig>(`${base}/preview-rig`, {
          anchors_id: anchors.id,
          ...(edited ? { marks } : {}),
        });
        if (request !== latest.current) return;
        setRigUrl(URL.createObjectURL(new Blob([JSON.stringify(result.rig)], { type: "application/json" })));
        setReasons(result.reasons);
        setPreviewError(null);
      } catch (err) {
        if (request !== latest.current) return;
        if (err instanceof ApiError && err.code === "anchors_stale") {
          void refetch();
          return;
        }
        setPreviewError(err instanceof ApiError ? errorText(t, err.code, err.detail, err.retryAfter) : t("wzPreviewFailed"));
      }
    }, rigUrl ? PREVIEW_DELAY_MS : 0);
    return () => window.clearTimeout(timer);
    // The preview follows the marks; rigUrl only picks the delay.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marks, anchors.id, base]);

  const blocked = reasons.length > 0;
  const needsConfirm = !found;
  const hold = blocked
    ? "wzHoldFit"
    : needsConfirm && !confirmed
      ? "wzHoldPoints"
      : statementScope && !statement
        ? "wzHoldStatement2"
        : null;
  const failure = creation.job?.step === "finish" ? jobFailure(creation.job) : null;

  const name = defaultName({
    description: plan.description,
    fileName: recallChoices(tabStore(), creation.id)?.fileName ?? null,
    fallback: t(`wzName_${plan.model}_${plan.look}`),
  });

  const publish = async () => {
    // The server keeps a detection it may confirm as found (one click);
    // anything else is the owner's: every point, as it is on screen.
    const oneClick = anchors.detected && line.oneClick && !edited;
    const outcome = await run(
      "finish",
      async () => {
        const consentId = statementScope ? (await consent.record(statementScope, creation.id)).id : undefined;
        return api.post<FinishResult>(`${base}/finish`, {
          name,
          anchors_id: anchors.id,
          ...(consentId ? { consent_id: consentId } : {}),
          ...(oneClick ? {} : { marks: pickMarks(marks, line.marks) }),
        });
      },
      (result) => result.creation
    );
    if (outcome.ok) {
      rememberFinishNotice(tabStore(), outcome.result.avatar_id, outcome.result.warnings ?? []);
      return;
    }
    const problem = consentProblem(outcome.error.code, outcome.error.body);
    if (problem?.kind === "required" && problem.scope !== "third_party_ai") setStatementScope(problem.scope);
    if (outcome.error.code === "fit_invalid" && Array.isArray(outcome.error.body.reasons)) {
      setReasons(outcome.error.body.reasons as FitReason[]);
      setFixing(true);
    }
  };

  const reasonText = (reason: FitReason) => {
    const key = FIT_REASON_LABELS[reason.code];
    return key ? t(key, { count: reason.count ?? 0 }) : reason.detail;
  };

  const texture = image?.url ?? "";
  const preview = (
    <div className={`relative overflow-hidden rounded-3xl border border-gray-200 dark:border-line ${PICTURE_BACKDROP}`}>
      {rigUrl && texture ? (
        <AvatarPreview rigUrl={rigUrl} textureUrl={texture} size={fixing ? 320 : 520} onEngine={setEngine} />
      ) : (
        <div className="grid aspect-square place-items-center p-6 text-center text-sm text-gray-500 dark:text-gray-400">
          {previewError ?? (
            <span className="flex items-center gap-2">
              <Spinner className="h-5 w-5 text-brand-600" /> {t("wzPreviewLoading")}
            </span>
          )}
        </div>
      )}
      {rigUrl && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center bg-gradient-to-t from-black/35 to-transparent p-4 pt-12">
          <SampleSpeech
            engine={engine}
            orgId={orgId}
            text={t("wzSample")}
            labels={{ play: t("wzPlay"), stop: t("wzStop") }}
            className="pointer-events-auto inline-flex min-h-12 items-center gap-2 rounded-full bg-white px-5 text-sm font-semibold text-gray-900 shadow-xl ring-1 ring-black/5 transition hover:scale-[1.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:opacity-60 motion-reduce:hover:scale-100 dark:bg-raised dark:text-white dark:ring-white/10 [&_svg]:text-brand-600"
          />
        </div>
      )}
    </div>
  );

  return (
    <div className="space-y-6">
      {failure && creation.job && (
        <div id="finish-failure" tabIndex={-1} className="outline-none">
          <JobProgress job={creation.job} onRetry={hold ? undefined : () => void publish()} retrying={busy !== null} />
        </div>
      )}

      <div className={`grid gap-6 ${fixing ? "md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]" : "md:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]"}`}>
        <div>
          {fixing && texture ? (
            <>
              {!found && (
                <p className="mb-3 flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/60 dark:text-amber-100">
                  <Icon name="target" className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{t("wzNotFound")}</span>
                </p>
              )}
              <MarkCanvas imageUrl={texture} imageSize={anchors.image_size} marks={marks} onChange={setMarks} />
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  className="btn-secondary min-h-10 px-3 text-xs"
                  onClick={() => setMarks(anchors.marks)}
                  disabled={!edited || busy !== null}
                >
                  <Icon name="undo" className="h-3.5 w-3.5" />
                  {t("wzResetPoints")}
                </button>
                <span className="hidden self-center text-xs text-gray-500 dark:text-gray-400 sm:inline">{t("markFaceKeys")}</span>
              </div>
            </>
          ) : (
            preview
          )}
        </div>

        <div className="flex flex-col gap-5">
          {fixing ? (
            <div className="max-w-xs md:max-w-none">{preview}</div>
          ) : (
            <div>
              <p className="flex items-center gap-2 text-sm font-medium text-emerald-700 dark:text-emerald-400">
                <span className="grid h-6 w-6 place-items-center rounded-full bg-emerald-500 text-white">
                  <Icon name="check" className="h-3.5 w-3.5" strokeWidth={2.6} />
                </span>
                {t("wzFaceFound")}
              </p>
              <ul className="mt-3 flex flex-wrap gap-2" aria-label={t("wzFaceFound")}>
                {PARTS.map((part) => (
                  <li
                    key={part}
                    className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-300"
                  >
                    <Icon name="check" className="h-3 w-3" strokeWidth={2.6} />
                    {t(`wzFound_${part}`)}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {blocked && (
            <div role="alert" className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/60 dark:text-amber-100">
              <p className="font-medium">{t("wzFitProblems")}</p>
              <ul className="mt-1 list-disc ps-5">
                {reasons.map((reason) => (
                  <li key={reason.code}>{reasonText(reason)}</li>
                ))}
              </ul>
            </div>
          )}

          {needsConfirm && (
            <label className="flex cursor-pointer items-start gap-3 text-sm text-gray-800 dark:text-gray-200">
              <input
                type="checkbox"
                className="mt-0.5 h-5 w-5 shrink-0 accent-brand-600"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              <span>{t("wzPointsConfirm")}</span>
            </label>
          )}

          {statementScope && (
            <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-gray-200 p-3 text-sm text-gray-800 dark:border-line dark:text-gray-200">
              <input
                type="checkbox"
                className="mt-0.5 h-5 w-5 shrink-0 accent-brand-600"
                checked={statement}
                onChange={(e) => setStatement(e.target.checked)}
              />
              <span>{t(statementScope === "generated_face" ? "createGeneratedFaceStatement" : "createDepictionStatement")}</span>
            </label>
          )}

          {found && (
            <button
              type="button"
              className="inline-flex min-h-10 items-center gap-2 self-start rounded-lg text-sm font-medium text-brand-700 hover:underline disabled:opacity-50 dark:text-brand-300"
              onClick={() => setFixing(!fixing)}
              disabled={busy !== null}
              aria-expanded={fixing}
            >
              <Icon name={fixing ? "check" : "target"} className="h-4 w-4" />
              {fixing ? t("wzDoneFixing") : t("wzFixPoints")}
            </button>
          )}

          <div className="rounded-xl bg-gray-50 p-3 text-sm dark:bg-white/[0.04]">
            <p className="text-gray-600 dark:text-gray-300">
              {t("wzPublishAs")} <strong className="font-semibold text-gray-900 dark:text-white">{name}</strong>
            </p>
            <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{t("wzPublishHint")}</p>
          </div>

          <div className="mt-auto flex flex-col-reverse gap-3 border-t border-gray-100 pt-5 dark:border-line sm:flex-row sm:items-center sm:justify-between">
            <button type="button" className="btn-secondary min-h-11" onClick={onBack} disabled={busy !== null}>
              <Icon name="back" className="h-4 w-4 rtl:-scale-x-100" />
              {t("wzBack")}
            </button>
            <div className="flex flex-col items-stretch gap-2 sm:items-end">
              <button
                type="button"
                className="btn-primary min-h-12 px-7 text-[15px] shadow-sm shadow-brand-600/20"
                onClick={() => void publish()}
                disabled={Boolean(hold) || busy !== null}
                aria-describedby={hold ? `${ids}-hold` : undefined}
              >
                {busy === "finish" ? <Spinner className="h-4 w-4" /> : <Icon name="bolt" className="h-4 w-4" strokeWidth={1.9} />}
                {t("wzPublish")}
              </button>
              {hold && (
                <p id={`${ids}-hold`} className="text-center text-xs text-gray-500 dark:text-gray-400 sm:text-end">
                  {t(hold)}
                </p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
