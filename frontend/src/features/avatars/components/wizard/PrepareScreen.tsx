import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { BackButton, BarAction, StepFooter } from "@/features/avatars/components/wizard/Footer";
import { Result, Working } from "@/features/avatars/components/wizard/Pictures";
import { VersionStrip } from "@/features/avatars/components/wizard/Versions";
import {
  errorText,
  isJobActive,
  jobFailure,
  type Creation,
  type DraftStore,
} from "@/features/avatars/creation";
import { consentProblem } from "@/features/avatars/consent";
import type { ConsentApi } from "@/features/avatars/hooks/useConsent";
import type { Run } from "@/features/avatars/hooks/useCreation";
import {
  activeChange,
  applyKeys,
  heldStage,
  beforeStep,
  canUseOriginal,
  isPrepareJob,
  MAX_WORDS,
  needsPrepare,
  planOf,
  prepareChecklist,
  preparedStep,
  preparePhase,
  prepareStage,
  recallChoices,
  retryBody,
  triesLeft,
  freeClearsLeft,
  clearBody,
  footerPlan,
  selectedVersion,
  versionsOf,
  type LastPrepare,
  type Version,
  type PrepareBody,
  type PrepareStage,
  type WizardCreation,
} from "@/features/avatars/wizard";
import { Icon } from "@/components/ui/Icon";
import { Spinner } from "@/components/ui/Spinner";
import { api, ApiError } from "@/lib/api";

/** The picture's width for its height to fit between the bars (the
 * header, the progress and the title above, the action bar below). */
function fitPicture(step: { width: number; height: number }): React.CSSProperties {
  const ratio = Math.max(1, step.width) / Math.max(1, step.height);
  return { maxWidth: `max(${Math.round(300 * ratio)}px, min(100%, calc((100dvh - 23.5rem) * ${ratio})))` };
}

function tabStore(): DraftStore | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

// The keys that apply a change, for this platform: read once, not per render.
const APPLY_KEYS = applyKeys(
  typeof navigator === "undefined"
    ? null
    : (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform || navigator.platform
);

/**
 * Step 3: the picture the avatar is made of, made by itself.
 *
 * It starts on arrival: the AI in the chosen look when the owner agreed to
 * it on step 2 (or had before), else, for a realistic upload, the photo
 * itself cut out. While it works, the photo sits under a shimmer with the
 * stages ticked off (Working). Then the result, big, compared with the
 * upload on a slider; Retry, "Describe a change" (the owner's words, on
 * the picture made), and for a realistic upload "Use my original photo".
 * Nothing is lost by any of them: every version is kept, in a strip under
 * the picture, and choosing one makes it the picture used (the server's
 * POST /version, so a reload shows the same).
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
  const { t } = useTranslation();
  const base = `/orgs/${orgId}/creations/${creation.id}`;
  const plan = planOf(creation);
  const choices = recallChoices(tabStore(), creation.id);
  const phase = preparePhase(creation);
  const job = creation.job;
  const result = preparedStep(creation);
  const before = beforeStep(creation);
  const last = (creation.ai?.last_prepare ?? null) as LastPrepare | null;
  const aiOn = consent.aiEnabled && creation.ai?.enabled !== false;
  const consentId = consent.aiConsentId;
  const tries = triesLeft(creation);
  const freeClear = freeClearsLeft(creation) > 0;
  const [change, setChange] = useState("");
  // The owner must agree before the AI is used here (a refused remembered
  // agreement, or a draft whose agreement this tab does not know).
  const [askAi, setAskAi] = useState(false);
  const [agree, setAgree] = useState(false);
  // The version being switched to, while the server does it.
  const [pending, setPending] = useState<string | null>(null);
  const ids = useId();

  const prepare = (body: PrepareBody, agreed?: string) =>
    run(body.mode === "change" ? "change" : "prepare", async () => {
      const id = agreed ?? (typeof consentId === "string" ? consentId : undefined);
      try {
        return await api.post<Creation>(`${base}/prepare`, { ...body, ...(id ? { consent_id: id } : {}) });
      } catch (err) {
        const problem = err instanceof ApiError ? consentProblem(err.code, err.body) : null;
        if (problem?.kind === "required" && problem.scope === "third_party_ai") {
          consent.forgetAi();
          setAskAi(true);
        }
        throw err;
      }
    });

  // Start by itself, once per revision: the intent step 2 recorded, or
  // what the plan and the member's remembered agreement allow.
  const asked = useRef(new Set<number>());
  useEffect(() => {
    if (!needsPrepare(creation) || busy !== null || askAi) return;
    if (consentId === undefined) return; // still loading: decide once known
    if (asked.current.has(creation.revision)) return;
    const original = canUseOriginal(plan);
    const wantsAi = (choices?.intent ?? "ai") === "ai";
    if (wantsAi && aiOn && typeof consentId === "string") {
      asked.current.add(creation.revision);
      // (A character made from words is prepared by its own job; one that
      // reaches here, an old draft, has its picture redrawn in the look.)
      void prepare({ mode: "ai" });
    } else if (original) {
      asked.current.add(creation.revision);
      void prepare({ mode: "original" });
    } else {
      setAskAi(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [creation.revision, creation.job?.state, consentId, busy, askAi]);

  const agreeAndPrepare = async () => {
    try {
      const made = await consent.record("third_party_ai");
      setAskAi(false);
      await prepare({ mode: result && plan.source === "generate" ? "generate" : "ai" }, made.id);
    } catch {
      // the error is shown by the step's runner, or the dialog's words stand
    }
  };

  const retryJob = () =>
    void run("retry", async () => {
      try {
        return await api.post<Creation>(`${base}/retry`, typeof consentId === "string" ? { consent_id: consentId } : {});
      } catch (err) {
        const problem = err instanceof ApiError ? consentProblem(err.code, err.body) : null;
        if (problem?.kind === "required" && problem.scope === "third_party_ai") {
          consent.forgetAi();
          setAskAi(true);
        }
        throw err;
      }
    });

  const working = phase === "working" || (phase === "waiting" && busy === "prepare");
  const stages = prepareChecklist(plan.source, !(last?.mode === "original") && choices?.intent !== "original");
  // Monotonic within a run: see heldStage.
  const shownStage = useRef<PrepareStage | null>(null);
  // A run is over once a picture is shown (or it failed) and nothing is working.
  const idle = (phase === "done" || phase === "failed") && busy === null && !(job && isJobActive(job));
  const stage = idle ? null : heldStage(shownStage.current, prepareStage(job) ?? (busy ? "upload" : null));
  shownStage.current = stage;
  const fraction = job && isJobActive(job) ? job.progress?.fraction ?? null : null;
  const failure = job && isPrepareJob(job) ? jobFailure(job) : null;
  const failureText = failure ? errorText(t, failure.code, failure.detail) : null;
  const canAi = aiOn && tries > 0;
  const originalOffered = canUseOriginal(plan);
  const lastWasOriginal = last?.mode === "original";

  // --- Agreement needed before the AI can run -------------------------------------
  const agreementPanel = (
    <div className="rounded-2xl border border-brand-200 bg-brand-50/60 p-4 dark:border-brand-500/30 dark:bg-brand-500/[0.07]">
      <p className="text-sm font-medium text-gray-900 dark:text-white">{t("wzAiNeeded")}</p>
      {aiOn ? (
        <>
          <label className="mt-3 flex cursor-pointer items-start gap-3 text-sm text-gray-800 dark:text-gray-200">
            <input
              type="checkbox"
              className="mt-0.5 h-5 w-5 shrink-0 accent-brand-600"
              checked={agree}
              onChange={(e) => setAgree(e.target.checked)}
            />
            <span>{t(plan.source === "generate" ? "wzConsentAi_generate" : "wzConsentAi_upload")}</span>
          </label>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-primary min-h-11"
              disabled={!agree || busy !== null}
              onClick={() => void agreeAndPrepare()}
            >
              {busy === "prepare" ? <Spinner className="h-4 w-4" /> : <Icon name="sparkles" className="h-4 w-4" />}
              {t("wzUseAi")}
            </button>
            {originalOffered && (
              <button
                type="button"
                className="btn-secondary min-h-11"
                disabled={busy !== null}
                onClick={() => {
                  setAskAi(false);
                  void prepare({ mode: "original" });
                }}
              >
                {t("wzUseOriginal")}
              </button>
            )}
          </div>
        </>
      ) : (
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">{t("wzHoldAiOff")}</p>
      )}
    </div>
  );

  const footer = footerPlan("prepare", { prepared: Boolean(result) });
  const backButton = <BackButton onClick={onBack} disabled={busy !== null} />;

  if (!result) {
    if (working || (phase === "waiting" && !askAi)) {
      return (
        <>
          <Working
            before={before}
            model={plan.model}
            look={plan.look}
            stages={stages}
            stage={working ? stage : "upload"}
            fraction={fraction}
            hint={t(lastWasOriginal || choices?.intent === "original" ? "wzWorkingHintOriginal" : "wzWorkingHint")}
          />
          <StepFooter back={footer.back && backButton} />
        </>
      );
    }
    // Failed with nothing to show, or waiting for the owner's agreement.
    return (
      <div className="max-w-2xl space-y-5">
        {failureText && phase === "failed" && (
          <div role="alert" className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/60 dark:text-amber-100">
            <p className="flex items-start gap-2">
              <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{failureText}</span>
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {job?.retryable && !askAi && (
                <button type="button" className="btn-primary min-h-11" onClick={retryJob} disabled={busy !== null}>
                  {busy === "retry" ? <Spinner className="h-4 w-4" /> : <Icon name="refresh" className="h-4 w-4" />}
                  {t("wzTryAgain")}
                </button>
              )}
              {originalOffered && job?.step !== "ingest" && (
                <button type="button" className="btn-secondary min-h-11" onClick={() => void prepare({ mode: "original" })} disabled={busy !== null}>
                  {t("wzUseOriginal")}
                </button>
              )}
              <button
                type="button"
                className={`${job?.retryable || originalOffered ? "btn-secondary" : "btn-primary"} min-h-11`}
                onClick={onBack}
                disabled={busy !== null}
              >
                <Icon name="back" className="h-4 w-4 rtl:-scale-x-100" />
                {t(plan.source === "generate" ? "wzEditDescription" : "wzOtherPhoto")}
              </button>
            </div>
          </div>
        )}
        {askAi && agreementPanel}
        <StepFooter back={footer.back && backButton} />
      </div>
    );
  }

  // --- The result ----------------------------------------------------------------
  const applied = activeChange(last);
  const redoing = working || busy === "prepare" || busy === "change" || busy === "retry";
  const switching = busy === "version";
  const note = !last?.cut && last
    ? t("wzKeptBackground")
    : lastWasOriginal
      ? t("wzOriginalNote")
      : t("wzAiMadeNote");
  const applyChange = () => {
    const words = change.trim();
    if (!words || redoing || busy !== null) return;
    void prepare({ mode: "change", instruction: words }).then((outcome) => {
      if (outcome.ok) setChange("");
    });
  };
  const versions = versionsOf(creation);
  const chooseVersion = (version: Version) => {
    if (version.needsPrepare) {
      // The photo as it is, never prepared yet: "use my original photo".
      void prepare({ mode: "original" });
      return;
    }
    setPending(version.id);
    void run("version", () => api.post<Creation>(`${base}/version`, { version: version.id })).finally(() =>
      setPending(null)
    );
  };

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
            busy={redoing || switching}
            busyLabel={switching ? t("wzVersionLoading") : stage ? t(`wzStage_${stage}`) : t("wzStage_create")}
          />
        </div>
      </div>

      <VersionStrip
        versions={versions}
        selected={selectedVersion(creation)}
        pending={pending}
        disabled={redoing || busy !== null}
        onChoose={chooseVersion}
        className="lg:col-start-2 lg:row-start-2 lg:self-start"
      />

      <div className="flex flex-col gap-5 lg:col-start-2 lg:row-start-1">
        <p className="flex items-start gap-2.5 rounded-2xl bg-gray-50 p-4 text-sm text-gray-700 dark:bg-white/[0.04] dark:text-gray-300">
          <Icon name={lastWasOriginal ? "image" : "sparkles"} className="mt-0.5 h-4 w-4 shrink-0 text-brand-600 dark:text-brand-300" />
          <span>
            {note}
            {plan.source === "generate" && plan.description && (
              <span className="mt-1 block text-xs text-gray-500 dark:text-gray-400">
                {t("wzDescribedAs", { description: plan.description })}
              </span>
            )}
            {applied && (
              <span className="mt-1 block text-xs text-gray-500 dark:text-gray-400">
                {t("wzChangeApplied", { change: applied })}
                {aiOn && !askAi && (canAi || freeClear) && (
                  <>
                    {" "}
                    <button
                      type="button"
                      className="inline min-h-6 rounded font-medium text-brand-700 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:opacity-50 dark:text-brand-300"
                      onClick={() => void prepare(clearBody(plan))}
                      disabled={redoing || busy !== null}
                      title={t(freeClear ? "wzChangeClearHint" : "wzChangeClearPaidHint")}
                    >
                      {t(freeClear ? "wzChangeClear" : "wzChangeClearPaid")}
                    </button>
                  </>
                )}
              </span>
            )}
          </span>
        </p>

        {failureText && !redoing && (
          <p role="alert" className="flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/60 dark:text-amber-100">
            <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{failureText}</span>
          </p>
        )}

        {askAi && agreementPanel}

        {canAi && !askAi && (
          <form
            className="space-y-2.5"
            onSubmit={(e) => {
              e.preventDefault();
              applyChange();
            }}
          >
            <label htmlFor={`${ids}-change`} className="label mb-0">
              {t("wzChangeLabel")}
            </label>
            <textarea
              id={`${ids}-change`}
              rows={3}
              className="input min-h-[96px] resize-y text-[15px] leading-relaxed"
              maxLength={MAX_WORDS}
              placeholder={t("wzChangePlaceholder")}
              value={change}
              onChange={(e) => setChange(e.target.value)}
              onKeyDown={(e) => {
                // Cmd/Ctrl+Enter applies; Enter alone is a new line.
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  applyChange();
                }
              }}
              aria-describedby={`${ids}-change-keys`}
              // Read-only, not disabled, while a picture is made: the focus
              // stays in the box (a disabled one drops it to the page).
              readOnly={redoing || busy !== null}
              aria-busy={redoing || busy !== null}
            />
            <div className="flex items-center justify-end gap-3 sm:justify-between">
              <p id={`${ids}-change-keys`} className="hidden text-xs text-gray-500 dark:text-gray-400 sm:block">
                {t("wzChangeShortcut", { keys: APPLY_KEYS })}
              </p>
              <button type="submit" className="btn-secondary min-h-11 shrink-0" disabled={!change.trim() || redoing || busy !== null}>
                {busy === "change" ? <Spinner className="h-4 w-4" /> : <Icon name="pencil" className="h-4 w-4" />}
                {t("wzApply")}
              </button>
            </div>
          </form>
        )}

        {aiOn && (
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {tries > 0 ? t("wzTriesLeft", { count: tries }) : t("wzNoTries")}
          </p>
        )}
      </div>

      <StepFooter back={footer.back && <BackButton onClick={onBack} disabled={busy !== null} compact />}>
        {canAi && !askAi && !lastWasOriginal && (
          <BarAction
            icon="refresh"
            label={t("wzRetry")}
            onClick={() => void prepare(retryBody(plan, last))}
            disabled={redoing || busy !== null}
            busy={busy === "prepare" && redoing}
          />
        )}
        {canAi && !askAi && lastWasOriginal && (
          <BarAction
            icon="sparkles"
            label={t("wzUseAi")}
            onClick={() => (typeof consentId === "string" ? void prepare({ mode: "ai" }) : setAskAi(true))}
            disabled={redoing || busy !== null}
          />
        )}
        {originalOffered && !lastWasOriginal && (
          <BarAction
            icon="image"
            label={t("wzUseOriginal")}
            onClick={() => void prepare({ mode: "original" })}
            disabled={redoing || busy !== null}
          />
        )}
        {footer.primary === "continue" && (
          <button
            type="button"
            className="btn-primary min-h-12 whitespace-nowrap px-5 text-[15px] shadow-sm shadow-brand-600/20 sm:px-6"
            onClick={onContinue}
            disabled={redoing || busy !== null}
          >
            <span className="sm:hidden">{t("wzContinueShort")}</span>
            <span className="hidden sm:inline">{t("wzContinue")}</span>
            <Icon name="arrow" className="h-4 w-4 rtl:-scale-x-100" strokeWidth={2} />
          </button>
        )}
      </StepFooter>
    </div>
  );
}
