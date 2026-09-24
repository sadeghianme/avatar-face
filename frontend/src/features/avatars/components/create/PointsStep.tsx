import type { AvatarEngine } from "@liveface/embed";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { AvatarPreview } from "@/features/avatars/components/AvatarPreview";
import { MarkCanvas } from "@/features/avatars/components/MarkCanvas";
import { JobProgress } from "@/features/avatars/components/create/JobProgress";
import {
  aiEditOf,
  aiPointsOffer,
  anchorsCurrent,
  confirmedParts,
  currentStep,
  errorText,
  forgetDraftMarks,
  isJobActive,
  jobFailure,
  loadDraftMarks,
  marksAreGuessed,
  movedParts,
  pickMarks,
  saveDraftMarks,
  type Creation,
  type CreationAnchors,
  type DraftStore,
  type FinishResult,
  type MarkPart,
  type PreviewRig,
} from "@/features/avatars/creation";
import {
  FIT_REASON_LABELS,
  GROUP_LABELS,
  type FaceMarks,
  type FitReason,
} from "@/features/avatars/face-marks";
import type { ConsentRecord, ConsentScope } from "@/features/avatars/consent";
import { statementNeeded } from "@/features/avatars/creation";
import type { ActionError } from "@/features/avatars/hooks/useCreation";
import type { WithAi } from "@/features/avatars/hooks/useConsent";
import { LINES } from "@/features/avatars/lines";
import { SpeakPanel } from "@/features/voices";
import { Icon } from "@/components/ui/Icon";
import { Spinner } from "@/components/ui/Spinner";
import { api, ApiError } from "@/lib/api";

// The preview follows the marks this long after the last drag or nudge, so
// holding an arrow key sends one request rather than one per pixel.
const LIVE_PREVIEW_DELAY_MS = 450;
const ALL_PARTS: readonly MarkPart[] = [
  "head", "left_eye", "right_eye", "mouth", "mouth_line", "chin", "left_pupil", "right_pupil",
];

/** This tab's storage for marks in progress, or null where it is blocked. */
function tabStore(): DraftStore | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

type Run = <T>(
  label: string,
  request: () => Promise<T>,
  toCreation?: (result: T) => Creation
) => Promise<{ ok: true; result: T } | { ok: false; error: ActionError }>;

/**
 * Step 4: place the points, watch the face talk, finish.
 *
 * Opens by detecting the face on the current image (a job) unless the
 * creation already has marks for it. Then the marks, pre-filled, and a
 * live preview of the rig finish would build from them: preview-rig fits
 * WITHOUT saving, and the reasons it gives are exactly what finish would
 * refuse, so they are listed under the preview and hold the button.
 *
 * "Looks right" finishes on the detected marks in one click when the
 * validator is happy and nothing was moved (a good photo is Upload → Looks
 * right). Marks that opened on the face template are a guess (an animal
 * always, a face the detector missed): the owner moves or ticks every part
 * before Save, and only those parts are sent, so the server can refuse a
 * guess nobody confirmed.
 *
 * Marks placed so far are kept for this tab (creation.DraftMarks) until the
 * avatar is built: stepping back, reloading, or a finish a restart
 * interrupted reopens the editor on them, not on the guess.
 *
 * Where the detector cannot see (an animal; an animation MediaPipe finds
 * nothing on), "Find the points with AI" asks the vision model for them,
 * after the third-party AI statement. Its points are a better guess, not a
 * detection: the owner still confirms every part. An avatar made from a
 * person's photo (on any line: a stylised photo is still that person)
 * needs the uploader's statement ticked before it is built, and one made
 * from words the statement that it is no real person; the server says
 * which (`creation.statement`). It is recorded for this creation at the
 * moment of finishing and sent with it.
 */
export function PointsStep({
  orgId,
  creation,
  busy,
  run,
  refetch,
  withAi,
  recordConsent,
  defaultName,
  onBack,
  onFocusLost,
}: {
  orgId: string;
  creation: Creation;
  busy: string | null;
  run: Run;
  refetch: () => unknown;
  withAi: WithAi;
  recordConsent: (scope: ConsentScope, creationId?: string) => Promise<ConsentRecord>;
  defaultName: string;
  onBack: () => void;
  /** Put focus somewhere sensible (the step heading): the control that had
   * it was replaced. */
  onFocusLost: () => void;
}) {
  const { t } = useTranslation();
  const base = `/orgs/${orgId}/creations/${creation.id}`;
  const job = creation.job;
  const finishing = creation.status === "finishing" || creation.status === "finished";
  const current = anchorsCurrent(creation) ? creation.anchors : null;
  const working = isJobActive(job);
  // Held here, not in the editor: "Detect again" brings new anchors and a
  // fresh editor, and the name typed so far should survive that.
  const [name, setName] = useState(defaultName);

  // Built: the marks in progress have done their job.
  useEffect(() => {
    if (creation.status === "finished") forgetDraftMarks(tabStore(), creation.id);
  }, [creation.status, creation.id]);

  // New anchors ("Detect again", Retry, Find the face) remount the editor,
  // and the button that was pressed goes with it. Focus left on the page's
  // body would send the next Tab back to the top of the page, past every
  // handle, so it goes to the heading, as on a step change. Only when it was
  // lost: someone typing the name while detection runs keeps their place.
  const shownAnchors = useRef(current?.id ?? null);
  useEffect(() => {
    const id = current?.id ?? null;
    if (id === null || id === shownAnchors.current) return;
    shownAnchors.current = id;
    const active = document.activeElement;
    if (!active || active === document.body || !active.isConnected) onFocusLost();
  }, [current?.id, onFocusLost]);

  // Detect once per revision, by itself, when there are no marks for this
  // image. A failed detection is shown with Retry instead of re-sent in a
  // loop; a reload tries again once, which is what a reload is for.
  const asked = useRef(new Set<number>());
  useEffect(() => {
    if (finishing || current || working || creation.status !== "draft") return;
    if (asked.current.has(creation.revision)) return;
    if (job?.step === "detect" && jobFailure(job)) return;
    asked.current.add(creation.revision);
    void run("detect", () => api.post<Creation>(`${base}/detect`));
  }, [finishing, current, working, creation.status, creation.revision, job, run, base]);

  const retry = () => void run("retry", () => api.post<Creation>(`${base}/retry`));

  if (finishing) {
    return (
      <div className="space-y-4">
        {job && isJobActive(job) ? (
          <JobProgress job={job} />
        ) : (
          <p className="flex items-center gap-2 text-sm">
            <Spinner className="h-4 w-4" />
            {creation.status === "finished" ? t("createFinished") : t("createJob_finish")}
          </p>
        )}
        <p className="text-xs text-gray-500 dark:text-gray-400">{t("createFinishingHint")}</p>
      </div>
    );
  }

  if (!current) {
    const shown = job && (isJobActive(job) || jobFailure(job)) ? job : null;
    // Asked, and the request itself was refused (a busy queue): offer the
    // button rather than a spinner that would never end.
    const refused = asked.current.has(creation.revision) && busy === null && !shown;
    return (
      <div className="space-y-4">
        {shown ? (
          <JobProgress job={shown} onRetry={retry} retrying={busy === "retry"} />
        ) : refused ? (
          <button
            type="button"
            className="btn-primary min-h-11"
            onClick={() => void run("detect", () => api.post<Creation>(`${base}/detect`))}
          >
            {t("createDetect")}
          </button>
        ) : (
          <p className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
            <Spinner className="h-4 w-4" /> {t("createJob_detect")}
          </p>
        )}
        <button type="button" className="btn-secondary min-h-11" onClick={onBack} disabled={busy !== null}>
          {t("createBack")}
        </button>
      </div>
    );
  }

  return (
    <PointsEditor
      key={current.id}
      orgId={orgId}
      creation={creation}
      anchors={current}
      busy={busy}
      run={run}
      refetch={refetch}
      withAi={withAi}
      recordConsent={recordConsent}
      name={name}
      onName={setName}
      onBack={onBack}
      onRetry={retry}
    />
  );
}

function PointsEditor({
  orgId,
  creation,
  anchors,
  busy,
  run,
  refetch,
  withAi,
  recordConsent,
  name,
  onName,
  onBack,
  onRetry,
}: {
  orgId: string;
  creation: Creation;
  anchors: CreationAnchors;
  busy: string | null;
  run: Run;
  refetch: () => unknown;
  withAi: WithAi;
  recordConsent: (scope: ConsentScope, creationId?: string) => Promise<ConsentRecord>;
  name: string;
  onName: (name: string) => void;
  onBack: () => void;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  const base = `/orgs/${orgId}/creations/${creation.id}`;
  const line = LINES[creation.face_type ?? "human"];
  const image = currentStep(creation);
  const detected = anchors.marks;

  const [restored] = useState(() => loadDraftMarks(tabStore(), creation.id, anchors.id));
  const [marks, setMarks] = useState<FaceMarks>(() =>
    restored ? { ...detected, ...restored.marks } : detected
  );
  // Parts the owner confirmed as already right without moving them.
  const [ticked, setTicked] = useState<MarkPart[]>(restored?.ticked ?? []);
  const [reasons, setReasons] = useState<FitReason[]>(anchors.validation.reasons);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [engine, setEngine] = useState<AvatarEngine | null>(null);
  const [missing, setMissing] = useState<string[]>([]);
  const latest = useRef(0);

  const moved = movedParts(marks, detected, ALL_PARTS);
  const edited = moved.length > 0;

  // Kept for this tab on every change, forgotten when back to as detected.
  useEffect(() => {
    const draft = edited || ticked.length > 0 ? { marks: pickMarks(marks, moved), ticked } : null;
    saveDraftMarks(tabStore(), creation.id, anchors.id, draft);
    // `moved` and `edited` derive from `marks`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marks, ticked, creation.id, anchors.id]);

  // Blob URLs are a real allocation: drop each one when it is replaced.
  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  // The live preview: the rig finish would build, fitted without saving.
  // Only the newest request may land (answers can arrive out of order).
  useEffect(() => {
    const request = ++latest.current;
    const timer = window.setTimeout(async () => {
      setPreviewing(true);
      try {
        const result = await api.post<PreviewRig>(`${base}/preview-rig`, {
          anchors_id: anchors.id,
          ...(edited ? { marks } : {}),
        });
        if (request !== latest.current) return;
        setPreviewUrl(URL.createObjectURL(new Blob([JSON.stringify(result.rig)], { type: "application/json" })));
        setReasons(result.reasons);
        setPreviewError(null);
      } catch (err) {
        if (request !== latest.current) return;
        if (err instanceof ApiError && err.code === "anchors_stale") {
          void refetch();
          return;
        }
        setPreviewError(
          err instanceof ApiError ? errorText(t, err.code, err.detail, err.retryAfter) : t("error")
        );
      } finally {
        if (request === latest.current) setPreviewing(false);
      }
    }, previewUrl ? LIVE_PREVIEW_DELAY_MS : 0);
    return () => window.clearTimeout(timer);
    // The preview follows the marks; previewUrl only picks the delay.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marks, anchors.id, base]);

  const oneClick = line.oneClick && anchors.validation.one_click && !edited;
  // The uploader's statement, when the server says the face needs one: it
  // refuses finish without it (403 consent_required). It is recorded at the
  // moment of finishing, for this creation, so it names the text that was
  // on screen and the face it was about.
  const statementScope = statementNeeded(creation);
  const needsStatement = statementScope !== null;
  const [statement, setStatement] = useState(false);
  const guessed = marksAreGuessed(anchors, line.oneClick);
  const confirmed = confirmedParts(line.marks, moved, ticked);
  const unplaced = guessed ? line.marks.filter((part) => !confirmed.includes(part)) : [];
  const tick = (part: MarkPart, on: boolean) =>
    setTicked((now) => (on ? [...now.filter((p) => p !== part), part] : now.filter((p) => p !== part)));

  const finish = async () => {
    setMissing([]);
    const outcome = await run(
      "finish",
      async () => {
        // Recorded now, under the words on screen, and only for this
        // finish: a retry after a failure records it again.
        const consentId = statementScope ? (await recordConsent(statementScope, creation.id)).id : undefined;
        return api.post<FinishResult>(`${base}/finish`, {
          name: name.trim(),
          anchors_id: anchors.id,
          ...(consentId ? { consent_id: consentId } : {}),
          // One click sends nothing: the server uses the marks it detected.
          // A guess sends only what the owner placed or ticked (all of it,
          // or the button is held); corrections of a detection send it all.
          ...(oneClick ? {} : { marks: guessed ? pickMarks(marks, confirmed) : marks }),
        });
      },
      (result) => result.creation
    );
    if (outcome.ok) return;
    const body = outcome.error.body;
    if (outcome.error.code === "fit_invalid" && Array.isArray(body.reasons)) {
      setReasons(body.reasons as FitReason[]);
    }
    if (outcome.error.code === "marks_required" && Array.isArray(body.missing)) {
      setMissing(body.missing as string[]);
    }
  };

  const redetect = () => void run("detect", () => api.post<Creation>(`${base}/detect`));
  const aiOffer = aiPointsOffer(creation, anchors);
  const findWithAi = () =>
    void run("detect", () =>
      withAi(t("createAiPoints"), (consentId) =>
        api.post<Creation>(`${base}/detect`, { use_ai: true, consent_id: consentId })
      )
    );
  const aiEdit = aiEditOf(creation);

  const reasonText = (reason: FitReason) => {
    const key = FIT_REASON_LABELS[reason.code];
    return key ? t(key, { count: reason.count ?? 0 }) : reason.detail;
  };
  const partName = (part: string) =>
    part in GROUP_LABELS ? t(GROUP_LABELS[part as keyof typeof GROUP_LABELS]) : part;

  const failure = creation.job?.step === "finish" ? jobFailure(creation.job) : null;
  // A failed finish is retried from what is on screen, not from what the
  // failed attempt was sent: the owner may have renamed it or moved a point
  // since. Every other job retries as it was.
  const retryFailed = failure ? () => void finish() : onRetry;
  // "Detect again" runs while these marks stay on screen; nothing may be
  // finished on marks that are about to be replaced.
  const working = isJobActive(creation.job);
  const blocked = reasons.length > 0;
  const texture = image?.url ?? "";

  return (
    <div className="space-y-5">
      <p className="text-sm text-gray-600 dark:text-gray-300">{t(line.guide)}</p>
      <p className="text-xs text-gray-500 dark:text-gray-400">{t("markFaceKeys")}</p>

      {aiEdit && (
        <p className="flex items-start gap-2 rounded-xl bg-brand-50 p-3 text-sm text-brand-800 dark:bg-brand-500/10 dark:text-brand-200">
          <Icon name="sparkles" className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            {t(aiEdit.mode === "generate" ? "createAiMadeNote" : "createAiEditedNote")}
            {aiEdit.generated_eyes && <> {t("createAiEyesNote")}</>}
          </span>
        </p>
      )}

      {anchors.source === "ai" && (
        <p className="rounded-xl border border-gray-200 p-3 text-sm text-gray-700 dark:border-line dark:text-gray-300">
          {t("createAiPointsPlaced")}
        </p>
      )}

      {aiOffer && (
        <div className="rounded-xl border border-gray-200 p-3 dark:border-line">
          {aiOffer === "offer" ? (
            <>
              <button
                type="button"
                className="btn-secondary min-h-11"
                onClick={findWithAi}
                disabled={busy !== null || working}
                aria-describedby="ai-points-hint"
              >
                {busy === "detect" ? <Spinner className="h-4 w-4" /> : <Icon name="sparkles" className="h-4 w-4" />}
                {t("createAiPoints")}
              </button>
              <p id="ai-points-hint" className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                {edited || ticked.length > 0 ? t("createAiPointsReplaces") : t("createAiPointsHint")}
              </p>
            </>
          ) : (
            <p className="text-xs text-gray-500 dark:text-gray-400">{t("createAiPointsSpent")}</p>
          )}
        </div>
      )}

      {guessed && (
        <fieldset className="rounded-xl border border-gray-200 p-3 dark:border-line">
          <legend className="px-1 text-sm font-medium">{t("createGuessChecklist")}</legend>
          <ul className="mt-1 grid gap-1.5 text-sm sm:grid-cols-2">
            {line.marks.map((part) => {
              const placed = moved.includes(part);
              const hint = `guess-part-${part}`;
              return (
                <li key={part}>
                  <label className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      className="mt-0.5 h-4 w-4 shrink-0 accent-emerald-600"
                      checked={confirmed.includes(part)}
                      // A moved part is placed; unticking cannot unplace it.
                      disabled={placed || busy !== null}
                      onChange={(e) => tick(part, e.target.checked)}
                      aria-describedby={hint}
                    />
                    <span>
                      <span className="font-medium">{partName(part)}</span>
                      {placed && (
                        <span className="ms-1.5 text-xs text-emerald-700 dark:text-emerald-400">
                          {t("createPartPlaced")}
                        </span>
                      )}
                      <span id={hint} className="block text-xs text-gray-500 dark:text-gray-400">
                        {t(`createGuessPart_${part}`)}
                      </span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        </fieldset>
      )}

      {anchors.validation.warnings.length > 0 && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          <p className="font-medium">{t("createDetectWarnings")}</p>
          <ul className="mt-1 list-disc ps-5">
            {anchors.validation.warnings.map((w) => (
              <li key={w.code}>{t(`photoCheck_${w.code}`, { defaultValue: w.detail })}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid gap-5 md:grid-cols-[3fr_2fr]">
        <div>
          {texture && (
            <MarkCanvas
              imageUrl={texture}
              imageSize={anchors.image_size}
              marks={marks}
              onChange={setMarks}
            />
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-secondary px-3 py-1.5 text-xs"
              onClick={() => {
                setMarks(detected);
                setTicked([]);
              }}
              disabled={(!edited && ticked.length === 0) || busy !== null}
            >
              {t("resetDetected")}
            </button>
            <button
              type="button"
              className="btn-secondary px-3 py-1.5 text-xs"
              onClick={redetect}
              disabled={busy !== null || working}
            >
              {busy === "detect" ? <Spinner className="h-3.5 w-3.5" /> : null}
              {t("createDetectAgain")}
            </button>
          </div>
        </div>

        <div>
          <p className="mb-2 text-xs font-medium text-gray-500">
            {t("createPreviewTitle")}
            {previewing && <span className="ms-2 font-normal">{t("markPreviewUpdating")}</span>}
          </p>
          {previewUrl && texture ? (
            <>
              <AvatarPreview rigUrl={previewUrl} textureUrl={texture} size={280} onEngine={setEngine} />
              <div className="mt-3">
                <SpeakPanel engine={engine} orgId={orgId} />
              </div>
            </>
          ) : (
            <div className="grid aspect-square place-items-center rounded-xl border border-dashed border-gray-300 text-xs text-gray-500 dark:border-line">
              {previewError ?? <Spinner className="h-5 w-5" />}
            </div>
          )}
        </div>
      </div>

      {blocked && (
        <div
          className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
          role="alert"
        >
          <p className="font-medium">{t("fitRefusedTitle")}</p>
          <ul className="mt-1 list-disc ps-5">
            {reasons.map((reason) => (
              <li key={reason.code}>{reasonText(reason)}</li>
            ))}
          </ul>
        </div>
      )}
      {missing.length > 0 && (
        <p role="alert" className="field-error text-sm">
          {t("createMarksMissing", { parts: missing.map(partName).join(", ") })}
        </p>
      )}
      {creation.job && (failure || working) && (
        <JobProgress
          job={creation.job}
          onRetry={retryFailed}
          retrying={busy === "retry" || busy === "finish"}
        />
      )}

      <div className="max-w-sm">
        <label className="label" htmlFor="creation-name">
          {t("avatarName")}
        </label>
        <input
          id="creation-name"
          className="input"
          value={name}
          maxLength={128}
          required
          onChange={(e) => onName(e.target.value)}
        />
      </div>

      {unplaced.length > 0 && (
        <p className="text-xs text-gray-500 dark:text-gray-400">
          {t("createGuessUnplaced", { parts: unplaced.map(partName).join(", ") })}
        </p>
      )}

      {needsStatement && (
        <label className="flex max-w-2xl cursor-pointer items-start gap-3 text-sm text-gray-700 dark:text-gray-300">
          <input
            type="checkbox"
            className="mt-0.5 h-5 w-5 shrink-0 accent-brand-600"
            checked={statement}
            onChange={(e) => setStatement(e.target.checked)}
          />
          <span>{t(statementScope === "generated_face" ? "createGeneratedFaceStatement" : "createDepictionStatement")}</span>
        </label>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="btn-secondary min-h-11" onClick={onBack} disabled={busy !== null}>
          {t("createBack")}
        </button>
        <button
          type="button"
          className="btn-primary min-h-11 px-5"
          onClick={() => void finish()}
          disabled={busy !== null || working || blocked || unplaced.length > 0 || !name.trim() || (needsStatement && !statement)}
          aria-describedby="finish-hint"
        >
          {busy === "finish" ? <Spinner className="h-4 w-4" /> : <Icon name="check" className="h-4 w-4" strokeWidth={2} />}
          {oneClick ? t("createLooksRight") : t("createSavePoints")}
        </button>
        <span id="finish-hint" className="text-xs text-gray-500 dark:text-gray-400">
          {blocked
            ? t("createFixFirst")
            : unplaced.length > 0
              ? t("createPlaceFirst")
              : needsStatement && !statement
                ? t("createDepictionFirst")
                : oneClick
                ? t("createLooksRightHint")
                : t("createSaveHint")}
        </span>
      </div>
    </div>
  );
}
