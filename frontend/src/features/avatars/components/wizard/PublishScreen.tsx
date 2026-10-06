import type { AvatarEngine } from "@liveface/embed";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { Icon } from "@/components/ui/Icon";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Spinner } from "@/components/ui/Spinner";
import { creationRequests } from "@/features/avatars/api";
import { AvatarPreview } from "@/features/avatars/components/AvatarPreview";
import { JobProgress, useSeenStages } from "@/features/avatars/components/create/JobProgress";
import { MarkCanvas } from "@/features/avatars/components/MarkCanvas";
import { PICTURE_BACKDROP } from "@/features/avatars/components/wizard/Art";
import { BackButton, PhoneNote, StepFooter } from "@/features/avatars/components/wizard/Footer";
import { consentProblem, type FaceStatement } from "@/features/avatars/consent";
import {
  anchorsCurrent,
  type CreationAnchors,
  currentStep,
  type DraftStore,
  errorText,
  finishRows,
  isJobActive,
  jobFailure,
  mouthExpected,
  pickMarks,
  rememberFinishNotice,
} from "@/features/avatars/creation";
import { type FaceMarks, FIT_REASON_LABELS, type FitReason } from "@/features/avatars/face-marks";
import type { ConsentApi } from "@/features/avatars/hooks/useConsent";
import type { Run } from "@/features/avatars/hooks/useCreation";
import { LINES } from "@/features/avatars/lines";
import {
  avatarName,
  faceFound,
  footerPlan,
  planOf,
  recallChoices,
  statementKey,
  statementToAsk,
  type WizardCreation,
} from "@/features/avatars/wizard";
import { SampleSpeech } from "@/features/voices";
import { ApiError } from "@/lib/api";
import { cx } from "@/lib/cx";

// The preview follows moved points this long after the last move.
const PREVIEW_DELAY_MS = 400;
const PARTS = ["eyes", "lips", "head"] as const;
const PUBLISH_VIEWS = ["points", "preview"] as const;
type PublishView = (typeof PUBLISH_VIEWS)[number];

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
 * The big picture shows the points found, on by default (MarkCanvas, with
 * its 3x zoom in the corner): drag one only if it is off; Publish sends
 * them as "Fix points" did, and a refused fit says why beside them. The
 * talking preview is another canvas, so a toggle above the picture picks
 * Points or Talking preview, and playing the sample switches to it. When
 * the face was not found, the points start from the template's guess, a
 * hint says to place them, and the owner ticks that they are right.
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
      <>
        <p className="text-sm text-gray-600 dark:text-gray-300">{t("createErr_anchors_stale")}</p>
        <StepFooter back={<BackButton onClick={onBack} />} />
      </>
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
      clearError={clearError}
      onBack={onBack}
      onFixing={onFixing}
    />
  );
}

function PublishingPicture({ creation }: { creation: WizardCreation }) {
  const image = currentStep(creation);
  if (!image) return null;
  return (
    <div
      className={cx(
        "relative mx-auto aspect-square w-48 overflow-hidden rounded-full border-4 border-white shadow-xl dark:border-raised",
        PICTURE_BACKDROP
      )}
    >
      <img src={image.url} alt="" className="absolute inset-0 h-full w-full object-cover object-top" />
      <span
        aria-hidden="true"
        className="absolute inset-0 rounded-full ring-2 ring-brand-500/60 motion-safe:animate-glow"
      />
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
  const { t } = useTranslation();
  const ids = useId();
  const requests = useMemo(() => creationRequests(orgId, creation.id), [orgId, creation.id]);
  const plan = planOf(creation);
  const line = LINES[creation.face_type ?? "human"];
  const found = faceFound(anchors);
  const image = currentStep(creation);
  // The big picture shows the points (to drag) or the talking preview: two
  // canvases that cannot be one. Points first; playing the sample switches.
  const [view, setView] = useState<PublishView>("points");
  const [marks, setMarks] = useState<FaceMarks>(anchors.marks);
  const [confirmed, setConfirmed] = useState(false);
  const [reasons, setReasons] = useState<FitReason[]>(anchors.validation.reasons);
  const [rigUrl, setRigUrl] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [engine, setEngine] = useState<AvatarEngine | null>(null);
  // The statement about this face: what the server says finishing needs
  // (unless made with the photo), or what a refusal at Publish asked for.
  // Shown as a box here either way: Publish never fails on a statement it
  // does not let the member make.
  const [refused, setRefused] = useState<FaceStatement | null>(null);
  const statementScope = refused ?? statementToAsk(creation, recallChoices(tabStore(), creation.id)?.statement ?? null);
  const [statement, setStatement] = useState(false);
  const statementBox = useRef<HTMLInputElement>(null);
  const latest = useRef(0);
  const edited = JSON.stringify(marks) !== JSON.stringify(anchors.marks);
  const footer = footerPlan("publish");

  // Whether the page says "fix the points": per anchors (the editor is
  // keyed by them); onFixing is the wizard's state setter.
  useEffect(() => {
    onFixing(!found);
  }, [onFixing, found]);

  // Blob URLs are a real allocation: each is dropped when replaced.
  useEffect(
    () => () => {
      if (rigUrl) URL.revokeObjectURL(rigUrl);
    },
    [rigUrl]
  );

  // What the preview request reads when it goes, not what starts it: whether
  // the marks were moved, how to say an error, and whether a preview is up
  // already (which only picks the delay).
  const previewInputs = useRef({ edited, refetch, t, shown: false });
  previewInputs.current = { edited, refetch, t, shown: rigUrl !== null };

  // The rig Publish would build, fitted without saving; it follows the
  // marks, and only the newest answer lands.
  useEffect(() => {
    const request = ++latest.current;
    const timer = window.setTimeout(
      async () => {
        const { edited, refetch, t } = previewInputs.current;
        try {
          const result = await requests.previewRig({ anchors_id: anchors.id, ...(edited ? { marks } : {}) });
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
          setPreviewError(
            err instanceof ApiError ? errorText(t, err.code, err.detail, err.retryAfter) : t("wzPreviewFailed")
          );
        }
      },
      previewInputs.current.shown ? PREVIEW_DELAY_MS : 0
    );
    return () => window.clearTimeout(timer);
  }, [marks, anchors.id, requests]);

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

  // The server's, decided when the creation was made: the same on every
  // screen and after a reload, and what the finish takes.
  const name = avatarName(creation, t(`wzName_${plan.model}_${plan.look}`));

  const publish = async () => {
    // The server keeps a detection it may confirm as found (one click);
    // anything else is the owner's: every point, as it is on screen.
    const oneClick = anchors.detected && line.oneClick && !edited;
    const outcome = await run(
      "finish",
      async () => {
        const consentId = statementScope ? (await consent.record(statementScope, creation.id)).id : undefined;
        return requests.finish({
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
    if (problem?.kind === "required" && problem.scope !== "third_party_ai") {
      // The box is the next action: no banner beside it, and the focus on it.
      clearError();
      setRefused(problem.scope);
      setStatement(false);
      window.setTimeout(() => statementBox.current?.focus(), 0);
    }
    if (outcome.error.code === "fit_invalid" && Array.isArray(outcome.error.body.reasons)) {
      setReasons(outcome.error.body.reasons as FitReason[]);
      setView("points");
    }
  };

  const reasonText = (reason: FitReason) => {
    const key = FIT_REASON_LABELS[reason.code];
    return key ? t(key, { count: reason.count ?? 0 }) : reason.detail;
  };

  const texture = image?.url ?? "";
  const [imgW, imgH] = anchors.image_size;
  // As large as the viewport allows: the picture's height fits between the
  // bars, its width follows its shape.
  const ratio = imgW / Math.max(1, imgH);
  const fit = { maxWidth: `max(${Math.round(300 * ratio)}px, min(100%, calc((100dvh - 27.5rem) * ${ratio})))` };

  const preview = (
    <div
      className={cx(
        "relative overflow-hidden rounded-3xl border border-gray-200 dark:border-line",
        PICTURE_BACKDROP,
        // The canvas as tall as the screen leaves, its width following.
        "[&_canvas]:block [&_canvas]:max-h-[max(300px,calc(100dvh-27.5rem))] [&_canvas]:max-w-full [&_canvas]:!w-auto"
      )}
    >
      {rigUrl && texture ? (
        <AvatarPreview
          rigUrl={rigUrl}
          textureUrl={texture}
          faceType={creation.face_type}
          size={640}
          soft
          onEngine={setEngine}
        />
      ) : (
        <div className="grid aspect-square place-items-center p-6 text-center text-sm text-gray-500 dark:text-gray-400">
          {previewError ?? (
            <span className="flex items-center gap-2">
              <Spinner className="h-5 w-5 text-brand-600" /> {t("wzPreviewLoading")}
            </span>
          )}
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

      <div className="grid gap-8 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] xl:gap-12">
        {/* The picture, big, with its points on. */}
        <div className="min-w-0">
          <div className="mx-auto" style={fit}>
            <div className="mb-3 flex justify-center">
              <SegmentedControl
                look="raised"
                label={t("wzViewLabel")}
                options={PUBLISH_VIEWS.map((v) => ({
                  value: v,
                  label: (
                    <>
                      <Icon name={v === "points" ? "target" : "speaker"} className="h-4 w-4" />
                      {t(`wzView_${v}`)}
                    </>
                  ),
                }))}
                value={view}
                onChange={setView}
              />
            </div>

            {view === "points" && texture && (
              <>
                <div className="overflow-hidden rounded-3xl border border-gray-200 dark:border-line [&>div]:rounded-none">
                  <MarkCanvas imageUrl={texture} imageSize={anchors.image_size} marks={marks} onChange={setMarks} />
                </div>
              </>
            )}
            {/* Kept running while the points show, so Play needs no wait. */}
            <div className={view === "preview" ? "" : "hidden"}>{preview}</div>
          </div>
        </div>

        {/* What was found, the sample, the name. */}
        <div className="flex flex-col gap-5">
          {found ? (
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
                    className={cx(
                      "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium",
                      "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-300"
                    )}
                  >
                    <Icon name="check" className="h-3 w-3" strokeWidth={2.6} />
                    {t(`wzFound_${part}`)}
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-sm text-gray-600 dark:text-gray-300">{t("wzPointsHint")}</p>
            </div>
          ) : (
            <Banner appearance="soft" tone="warning" icon="target">
              {t("wzNotFound")}
            </Banner>
          )}

          <div>
            {/* Greyed, not faded, while there is nothing to reset. */}
            <Button
              variant="link"
              icon="undo"
              className="min-h-10 gap-2 rounded-lg text-sm disabled:text-gray-400 disabled:opacity-100 coarse:min-h-11 dark:disabled:text-gray-600"
              onClick={() => setMarks(anchors.marks)}
              disabled={!edited || busy !== null}
            >
              {t("wzResetPoints")}
            </Button>
            <details className="group mt-1 hidden text-xs text-gray-500 dark:text-gray-400 sm:block">
              <summary className="inline-flex min-h-8 coarse:min-h-11 cursor-pointer list-none items-center gap-1 font-medium hover:text-gray-700 dark:hover:text-gray-200">
                <Icon
                  name="chevron"
                  className="h-3.5 w-3.5 transition-transform group-open:rotate-90 rtl:-scale-x-100"
                />
                {t("wzKeysTitle")}
              </summary>
              <p className="mt-1 leading-relaxed">{t("markFaceKeys")}</p>
            </details>
          </div>

          {/* Playing the sample shows the talking preview. */}
          <div onClickCapture={() => setView("preview")}>
            <SampleSpeech
              engine={engine}
              orgId={orgId}
              text={t("wzSample")}
              labels={{ play: t("wzPlay"), stop: t("wzStop") }}
            />
            {previewError && <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">{previewError}</p>}
          </div>

          {blocked && (
            <Banner appearance="soft" tone="warning" role="alert">
              <p className="font-medium">{t("wzFitProblems")}</p>
              <ul className="mt-1 list-disc ps-5">
                {reasons.map((reason) => (
                  <li key={reason.code}>{reasonText(reason)}</li>
                ))}
              </ul>
            </Banner>
          )}

          {needsConfirm && (
            <Checkbox
              size="md"
              className="text-gray-800 dark:text-gray-200"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              label={<span>{t("wzPointsConfirm")}</span>}
            />
          )}

          {statementScope && (
            // Worded for the plan: on an "Animal" plan, the detector's person
            // on a photo may be a dog (see wizard.statementKey).
            <Checkbox
              ref={statementBox}
              size="md"
              className="rounded-xl border border-gray-200 p-3 text-gray-800 dark:border-line dark:text-gray-200"
              checked={statement}
              onChange={(e) => setStatement(e.target.checked)}
              label={<span>{t(statementKey(statementScope, plan))}</span>}
            />
          )}

          <div className="rounded-2xl bg-gray-50 p-4 text-sm dark:bg-white/[0.04]">
            <p className="text-gray-600 dark:text-gray-300">
              {t("wzPublishAs")} <strong className="font-semibold text-gray-900 dark:text-white">{name}</strong>
            </p>
            <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{t("wzPublishHint")}</p>
          </div>

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
            onClick={() => void publish()}
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
