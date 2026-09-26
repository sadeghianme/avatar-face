import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { AiConsentCheckbox } from "@/features/avatars/components/create/AiConsentDialog";
import { CHECKER } from "@/features/avatars/components/create/checker";
import { JobProgress } from "@/features/avatars/components/create/JobProgress";
import {
  ADJUST_STYLES,
  adjustModes,
  aiEditOf,
  autoAdjustKey,
  autoAdjustToStart,
  currentStep,
  aiResultInUse,
  candidateReasonText,
  choosable,
  DRAWN_REASONS,
  inUse,
  isJobActive,
  isTransparent,
  jobFailure,
  keepChoice,
  preselectedMode,
  recommendationOf,
  roundResults,
  roundSource,
  type AdjustMode,
  type AdjustStyle,
  type Creation,
  type CreationStep,
  type Recommendation,
  type StepId,
  type Translate,
} from "@/features/avatars/creation";
import { consentProblem } from "@/features/avatars/consent";
import type { ConsentApi } from "@/features/avatars/hooks/useConsent";
import type { Run } from "@/features/avatars/hooks/useCreation";
import { Icon } from "@/components/ui/Icon";
import { Spinner } from "@/components/ui/Spinner";
import { api, ApiError } from "@/lib/api";
import type { FaceType } from "@/lib/types";

// Failures of a touch-up that a regenerated picture does not have: the
// head is turned, or the face could not be measured closely enough to
// paste eyes and lips back. Offered as the next thing to try.
const TRY_REGENERATE = new Set(["face_turned", "no_face_for_touchup", "landmarks_unavailable"]);

/** A recommendation reason in plain words ("Your eyes are closed"). An
 * animal or a drawing is not "you": its two reasons have their own words. */
export function reasonText(t: Translate, line: FaceType, code: string): string {
  if (line !== "human" && DRAWN_REASONS.has(code)) return t(`adjustWhyDrawn_${code}`);
  return t(`adjustWhy_${code}`, { defaultValue: code });
}

/**
 * Step 3: AI adjust.
 *
 * The current image (after step 2, a cut-out when the background was
 * removed) has been checked locally, for free, and `analysis.recommendation`
 * says what, if anything, needs fixing:
 *
 * - A fix is recommended: it is PRE-SELECTED, with its reasons in plain
 *   words ("Your eyes are closed", "Your head is turned"), and "Fix it with
 *   AI" runs it. Touch up eyes & lips, or Regenerate in the best position.
 * - Nothing needs fixing: "Your photo is ready — no AI needed", Continue.
 *   "Improve with AI anyway" opens the same options with nothing selected:
 *   nothing paid is ever chosen for the owner on a photo that is fine.
 *
 * Stylise (a person redrawn as an animation) is always among the options
 * for a person. The third-party AI statement is inline: a checkbox, shown
 * until the member has agreed once under this wording (the server
 * remembers, GET /consents/mine), and recorded right before the call.
 *
 * The round runs as a job and its versions come back beside the "before":
 * "Use this" takes one and moves on, "Keep my photo" keeps the picture it
 * was made from. Rejected versions are shown with the reason and cannot be
 * taken; invented eyes are labelled on the picture. Taking an opaque
 * version when the background was removed cuts it out as well (a job),
 * so the step waits for that before moving on.
 *
 * With third-party AI switched off, the step says so and Continue is the
 * only way on: every line still works by hand.
 */
export function AdjustStep({
  orgId,
  creation,
  busy,
  run,
  consent,
  onRetry,
  onContinue,
  onBack,
  onStartOver,
}: {
  orgId: string;
  creation: Creation;
  busy: string | null;
  run: Run;
  consent: ConsentApi;
  onRetry: () => void;
  onContinue: () => void;
  onBack: () => void;
  onStartOver: () => void;
}) {
  const { t } = useTranslation();
  const base = `/orgs/${orgId}/creations/${creation.id}`;
  const line: FaceType = creation.face_type ?? "human";
  const modes = adjustModes(creation);
  const ai = creation.ai;
  const recommendation = recommendationOf(creation);
  const preselected = preselectedMode(creation);
  const source = roundSource(creation);
  const results = roundResults(creation);
  const hasRound = source !== null && results.length > 0;
  const roundsLeft = ai?.adjust_rounds_left ?? 0;
  const enabled = Boolean(ai?.enabled) && modes.length > 0;

  // Options open by themselves only when a fix is recommended, one is left,
  // and no round is on screen to compare yet.
  const opensByItself = enabled && preselected !== null && roundsLeft > 0 && !hasRound;
  const [open, setOpen] = useState(opensByItself);
  const [choice, setChoice] = useState<AdjustMode | null>(preselected);
  const [style, setStyle] = useState<AdjustStyle | null>(null);
  const [agreed, setAgreed] = useState(false);
  // Until the owner picks or opens anything, the pre-selection follows the
  // recommendation: it can arrive after the step (a cut-out finishing, a
  // refetch), and must not be stuck on what an older response said.
  const touched = useRef(false);
  useEffect(() => {
    if (touched.current) return;
    setChoice(preselected);
    setOpen(opensByItself);
  }, [preselected, opensByItself]);
  const pick = (mode: AdjustMode) => {
    touched.current = true;
    setChoice(mode);
  };
  const openOptions = () => {
    touched.current = true;
    setOpen(true);
  };

  const job = creation.job;
  const working = isJobActive(job);
  const locked = working || busy !== null;
  const adjustJob = job?.step === "adjust" && (isJobActive(job) || jobFailure(job)) ? job : null;
  // A background job here is the cut-out of a version just taken.
  const cutJob = job?.step === "background" && (isJobActive(job) || jobFailure(job)) ? job : null;
  const failure = adjustJob ? jobFailure(adjustJob) : null;
  const aiInUse = aiResultInUse(creation);

  const modeName = (mode: AdjustMode, withStyle: AdjustStyle | null = null) =>
    mode === "stylise" && withStyle
      ? t("adjustModeStyled", { mode: t("adjustMode_stylise"), style: t(`genStyle_${withStyle}`) })
      : t(`adjustMode_${mode}`);

  const needsConsent = consent.aiConsentId === null;
  const consentUnknown = consent.aiConsentId === undefined;
  const canFix =
    choice !== null &&
    roundsLeft > 0 &&
    !locked &&
    !consentUnknown &&
    (!needsConsent || agreed) &&
    (choice !== "stylise" || style !== null);

  const fix = async () => {
    if (!canFix || choice === null) return;
    touched.current = true;
    const mode = choice;
    const outcome = await run("adjust", async () => {
      // Recorded right before the call it allows, and remembered: the
      // member is not asked again under this wording.
      const consentId = consent.aiConsentId ?? (await consent.record("third_party_ai")).id;
      try {
        return await api.post<Creation>(`${base}/adjust`, {
          mode,
          ...(mode === "stylise" ? { style } : {}),
          consent_id: consentId,
          count: 2,
        });
      } catch (err) {
        const problem = err instanceof ApiError ? consentProblem(err.code, err.body) : null;
        // The remembered consent no longer counts (the wording changed):
        // the checkbox comes back, unticked.
        if (problem?.kind === "required") {
          consent.forgetAi();
          setAgreed(false);
        }
        if (problem?.kind === "disabled") consent.refreshAiSwitch();
        throw err;
      }
    });
    if (outcome.ok) setOpen(false);
  };

  // Parted lips over the teeth: the server offers a touch-up that closes
  // them (ai.auto_adjust; it fixes the eyes too when the check found them
  // wanting), and it starts here without a press when the member has
  // already agreed to send photos to Google. Never asked for on their
  // behalf, once per image; the result waits beside the photo for the
  // owner to choose, like any round. What it was started for is kept, to
  // say it.
  const autoStarted = useRef(new Set<string>());
  const [autoRan, setAutoRan] = useState<readonly string[] | null>(null);
  useEffect(() => {
    const offer = autoAdjustToStart(creation, consent.aiConsentId, autoStarted.current);
    const consentId = consent.aiConsentId;
    if (!offer || !consentId || busy !== null) return;
    autoStarted.current.add(autoAdjustKey(creation, offer));
    touched.current = true;
    setChoice(offer.mode);
    // The options would offer to start what is already running: the round's
    // progress, then its versions beside the photo, take their place.
    setOpen(false);
    setAutoRan(offer.reasons);
    void run("adjust", async () => {
      try {
        return await api.post<Creation>(`${base}/adjust`, {
          mode: offer.mode,
          consent_id: consentId,
          count: 2,
          auto: true,
        });
      } catch (err) {
        // The offer went (another tab took it, the image changed): nothing
        // to report, the step is as it was.
        if (err instanceof ApiError && err.code === "auto_adjust_not_applicable") {
          setAutoRan(null);
          return undefined;
        }
        if (err instanceof ApiError && consentProblem(err.code, err.body)?.kind === "required") {
          consent.forgetAi();
        }
        throw err;
      }
    }).then((outcome) => {
      // Refused (the monthly limit, AI switched off meanwhile): the wizard
      // shows why, and the step goes back to offering the fix by hand.
      if (!outcome.ok) {
        setAutoRan(null);
        setOpen(true);
      }
    });
    // `creation` changes identity on every poll; the offer and the job are
    // what decide.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [creation.ai?.auto_adjust?.image, creation.job?.state, creation.status, consent.aiConsentId, busy]);

  // Why a round is on screen that nobody pressed for: while it runs, and
  // once its versions wait beside the photo. A failed round speaks for
  // itself (JobProgress).
  const autoEyes = Boolean(autoRan?.some((reason) => reason !== "teeth_showing"));
  const autoNote = !autoRan
    ? null
    : adjustJob && isJobActive(adjustJob)
      ? autoEyes ? "adjustAutoStartedEyes" : "adjustAutoStarted"
      : hasRound && !failure
        ? autoEyes ? "adjustAutoReadyEyes" : "adjustAutoReady"
        : null;

  // "Use this": taken, and on to the points, unless it is being cut out
  // (the background was removed), which the step waits for.
  const use = async (id: StepId) => {
    const outcome = await run("choose", () => api.post<Creation>(`${base}/choose`, { choice: id }));
    if (!outcome.ok) return;
    const next = outcome.result;
    if (!(next && isJobActive(next.job))) onContinue();
  };

  // "Keep my photo": the picture the round was made from, then on. After a
  // stylised version was taken, keeping the photo also puts the creation
  // back on the line it was on (a person's photo is not rigged as a
  // drawing), and cuts it out again when the background was removed: the
  // step waits for that, as for a version taken.
  const keep = async () => {
    const target = keepChoice(creation);
    if (target) {
      const outcome = await run("choose", () => api.post<Creation>(`${base}/choose`, { choice: target }));
      if (!outcome.ok) return;
      if (outcome.result && isJobActive(outcome.result.job)) return;
    }
    onContinue();
  };

  const tryRegenerate = () => {
    pick("regenerate");
    openOptions();
  };

  const back = (
    <button type="button" className="btn-secondary min-h-11" onClick={onBack} disabled={busy !== null}>
      {t("createBack")}
    </button>
  );

  if (!enabled) {
    return (
      <div className="space-y-5">
        <p className="rounded-xl bg-gray-50 p-4 text-sm text-gray-600 dark:bg-white/[0.04] dark:text-gray-300">
          {ai?.enabled ? t("adjustNoModes") : t("adjustOff")}
        </p>
        <Findings recommendation={recommendation} line={line} aiInUse={aiInUse !== null} withFix={false} />
        <div className="flex flex-wrap items-center gap-3">
          {back}
          <button type="button" className="btn-primary min-h-11 px-5" onClick={onContinue} disabled={locked}>
            {t("createContinue")}
          </button>
        </div>
      </div>
    );
  }

  const fixButton = (
    <button type="button" className="btn-primary min-h-11 px-5" onClick={() => void fix()} disabled={!canFix}>
      {busy === "adjust" ? <Spinner className="h-4 w-4" /> : <Icon name="sparkles" className="h-4 w-4" />}
      {t("adjustFix")}
    </button>
  );

  let actions: React.ReactNode;
  if (open) {
    actions = (
      <>
        {fixButton}
        <button type="button" className="btn-secondary min-h-11" onClick={() => void keep()} disabled={locked}>
          {hasRound ? t("adjustKeepMine") : t("adjustSkip")}
        </button>
      </>
    );
  } else if (hasRound) {
    // The versions carry their own buttons; Continue is for coming back to
    // a choice already made.
    actions = (
      <>
        {aiInUse && (
          <button type="button" className="btn-primary min-h-11 px-5" onClick={onContinue} disabled={locked}>
            {t("createContinue")}
          </button>
        )}
        {roundsLeft > 0 && (
          <button type="button" className="btn-secondary min-h-11" onClick={openOptions} disabled={locked}>
            {t("adjustTryAnother")}
          </button>
        )}
      </>
    );
  } else {
    actions = (
      <>
        <button type="button" className="btn-primary min-h-11 px-5" onClick={onContinue} disabled={locked}>
          {t("createContinue")}
        </button>
        {roundsLeft > 0 && (
          <button type="button" className="btn-secondary min-h-11" onClick={openOptions} disabled={locked}>
            <Icon name="sparkles" className="h-4 w-4" />
            {t("adjustImproveAnyway")}
          </button>
        )}
      </>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        {/* The picture the findings are about; a round's before/after shows
            it below instead. */}
        {!hasRound && <Picture step={currentStep(creation)} />}
        <div className="min-w-0 flex-1">
          <Findings
            recommendation={recommendation}
            line={line}
            aiInUse={aiInUse !== null}
            withFix={preselected !== null && roundsLeft > 0}
            onStartOver={busy === null ? onStartOver : undefined}
          />
        </div>
      </div>

      {autoNote && (
        <p className="flex items-start gap-2 rounded-xl bg-brand-500/10 p-3 text-sm text-gray-700 dark:text-gray-200">
          <Icon name="sparkles" className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" />
          {/* Its progress is announced by the wizard's live region; this
              says why it started without a press, and that the owner still
              chooses. */}
          <span>{t(autoNote)}</span>
        </p>
      )}

      {adjustJob && (
        <JobProgress job={adjustJob} onRetry={onRetry} retrying={busy === "retry"}>
          {failure && TRY_REGENERATE.has(failure.code) && modes.includes("regenerate") && roundsLeft > 0 && (
            <button type="button" className="btn-secondary" onClick={tryRegenerate}>
              {t("adjustTryRegenerate")}
            </button>
          )}
        </JobProgress>
      )}

      {hasRound && source && (
        <Results
          creation={creation}
          source={source}
          results={results}
          locked={locked}
          busy={busy}
          onUse={(id) => void use(id)}
          onKeep={() => void keep()}
          modeName={modeName}
        />
      )}

      {cutJob && <JobProgress job={cutJob} onRetry={onRetry} retrying={busy === "retry"} />}

      {open && (
        <fieldset disabled={locked} className="space-y-4" aria-describedby="adjust-allowance">
          <legend className="mb-2 text-base font-semibold">{t("adjustQuestion")}</legend>
          <div className="grid gap-2">
            {modes.map((mode) => (
              <Option
                key={mode}
                name="adjust-mode"
                value={mode}
                checked={choice === mode}
                onSelect={() => pick(mode)}
                title={t(`adjustMode_${mode}`)}
                hint={mode === "regenerate" ? t(`adjustModeHint_regenerate_${line}`) : t(`adjustModeHint_${mode}`)}
                badge={mode === preselected ? t("adjustRecommended") : null}
              >
                {mode === "stylise" && choice === "stylise" && (
                  <fieldset className="mt-3">
                    <legend className="sr-only">{t("genStyle")}</legend>
                    <div className="flex flex-wrap gap-2">
                      {ADJUST_STYLES.map((s) => (
                        <label
                          key={s}
                          className={`inline-flex min-h-11 cursor-pointer items-center rounded-full border px-3.5 text-[13px] font-medium
                            focus-within:ring-2 focus-within:ring-brand-500 ${
                              style === s
                                ? "border-gray-900 bg-gray-900 text-white dark:border-white dark:bg-white dark:text-gray-900"
                                : "border-black/10 text-gray-600 hover:bg-black/5 dark:border-white/15 dark:text-gray-300 dark:hover:bg-white/10"
                            }`}
                        >
                          <input
                            type="radio"
                            name="adjust-style"
                            value={s}
                            className="sr-only"
                            checked={style === s}
                            onChange={() => setStyle(s)}
                          />
                          {t(`genStyle_${s}`)}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                )}
              </Option>
            ))}
          </div>
          <p id="adjust-allowance" className="text-xs text-gray-500 dark:text-gray-400">
            {roundsLeft > 0 ? t("adjustRoundsLeft", { count: roundsLeft }) : t("adjustNoRoundsLeft")}
          </p>
          {needsConsent && (
            <AiConsentCheckbox providers={consent.providers} checked={agreed} onChange={setAgreed} />
          )}
        </fieldset>
      )}

      {ai.last_round?.limit_reached && (
        <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
          {t("adjustLimitReached")}
        </p>
      )}
      {!open && roundsLeft === 0 && (
        <p className="text-xs text-gray-500 dark:text-gray-400">{t("adjustNoRoundsLeft")}</p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        {back}
        {actions}
        {open && !canFix && !locked && (
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {choice === null
              ? t("adjustPickOne")
              : choice === "stylise" && style === null
                ? t("adjustPickStyle")
                : needsConsent && !agreed
                  ? t("adjustAgreeFirst")
                  : null}
          </span>
        )}
      </div>
    </div>
  );
}

/** The image the step is about, small: the findings name what is in it. */
function Picture({ step }: { step: CreationStep | null }) {
  const { t } = useTranslation();
  if (!step) return null;
  return (
    <div
      className={`mx-auto grid aspect-square w-40 shrink-0 place-items-center overflow-hidden rounded-xl sm:mx-0 ${
        isTransparent(step) ? CHECKER : "bg-gray-50 dark:bg-white/[0.03]"
      }`}
    >
      <img src={step.url} alt={t("adjustCurrentAlt")} className="max-h-full max-w-full object-contain" />
    </div>
  );
}

/** What the free check found on the image on screen, in plain words. */
function Findings({
  recommendation,
  line,
  aiInUse,
  withFix,
  onStartOver,
}: {
  recommendation: Recommendation | null;
  line: FaceType;
  /** The image on screen is an AI version the owner took. */
  aiInUse: boolean;
  /** A fix is on offer (AI on, a try left): say so. */
  withFix: boolean;
  onStartOver?: () => void;
}) {
  const { t } = useTranslation();
  if (!recommendation) {
    return <p className="text-sm text-gray-600 dark:text-gray-300">{t("adjustNoCheck")}</p>;
  }
  if (recommendation.mode === "none" || recommendation.reasons.length === 0) {
    return (
      <p
        role="status"
        className="flex items-start gap-2 rounded-xl bg-emerald-50 p-4 text-sm font-medium text-emerald-900 dark:bg-emerald-500/10 dark:text-emerald-200"
      >
        <Icon name="check" className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={2} />
        {aiInUse ? t("adjustReadyAi") : t("adjustReady")}
      </p>
    );
  }
  const eyesClosed = recommendation.reasons.includes("eyes_closed");
  return (
    <section
      aria-labelledby="adjust-findings-heading"
      className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100"
    >
      <h3 id="adjust-findings-heading" className="font-semibold">
        {withFix ? t(`adjustRecommend_${recommendation.mode}`) : t("adjustFindingsTitle")}
      </h3>
      <ul className="mt-2 list-disc space-y-1 ps-5">
        {recommendation.reasons.map((code) => (
          <li key={code}>{reasonText(t, line, code)}</li>
        ))}
      </ul>
      {eyesClosed && onStartOver && (
        <p className="mt-3 text-[13px]">
          {t("adjustEyesClosedOther")}{" "}
          <button type="button" className="font-medium underline underline-offset-2" onClick={onStartOver}>
            {t("createUseAnother")}
          </button>
        </p>
      )}
    </section>
  );
}

/** One answer to "what should the AI do?": a radio with its explanation,
 * the whole card being the click target. */
function Option({
  name,
  value,
  checked,
  onSelect,
  title,
  hint,
  badge = null,
  children,
}: {
  name: string;
  value: string;
  checked: boolean;
  onSelect: () => void;
  title: string;
  hint: string;
  badge?: string | null;
  children?: React.ReactNode;
}) {
  const hintId = `${name}-${value}-hint`;
  return (
    <div
      className={`rounded-xl border-2 p-3 transition-colors ${
        checked ? "border-brand-500" : "border-gray-200 dark:border-line"
      }`}
    >
      <label className="flex cursor-pointer items-start gap-3">
        <input
          type="radio"
          name={name}
          value={value}
          checked={checked}
          onChange={onSelect}
          aria-describedby={hintId}
          className="mt-1 h-4 w-4 shrink-0 accent-brand-600"
        />
        <span className="min-w-0">
          <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
            {title}
            {badge && (
              <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300">
                {badge}
              </span>
            )}
          </span>
          <span id={hintId} className="mt-0.5 block text-xs text-gray-500 dark:text-gray-400">
            {hint}
          </span>
        </span>
      </label>
      {children && <div className="ps-7">{children}</div>}
    </div>
  );
}

/** Before and after: the picture the round was made from, and each version. */
function Results({
  creation,
  source,
  results,
  locked,
  busy,
  onUse,
  onKeep,
  modeName,
}: {
  creation: Creation;
  source: CreationStep;
  results: ReturnType<typeof roundResults>;
  locked: boolean;
  busy: string | null;
  onUse: (id: StepId) => void;
  onKeep: () => void;
  modeName: (mode: AdjustMode, style?: AdjustStyle | null) => string;
}) {
  const { t } = useTranslation();
  const sourceIsAi = aiEditOf(creation, source.id) !== null;
  const beforeInUse = keepChoice(creation) === null;
  const pictures = results.filter((r) => r.step !== null);
  // Versions that never became a picture (a refusal, a provider error):
  // listed with why, under the ones that did.
  const imageless = results
    .map((r, i) => ({ ...r, n: i + 1 }))
    .filter((r) => r.step === null && r.candidate.reason);

  return (
    <section aria-labelledby="adjust-results-heading">
      <h3 id="adjust-results-heading" className="mb-1 text-base font-semibold">
        {t("adjustResultsTitle")}
      </h3>
      <p className="mb-3 text-[13px] text-gray-500 dark:text-gray-400">{t("adjustResultsHint")}</p>
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4">
        <Card
          step={source}
          id="before"
          title={t("adjustBefore")}
          subtitle={sourceIsAi ? t("adjustBeforeAi") : t("adjustBeforeMine")}
          inUse={beforeInUse}
        >
          <button
            type="button"
            className="btn-secondary mt-auto min-h-11 text-xs"
            onClick={onKeep}
            disabled={locked}
            aria-describedby="result-before-title"
          >
            {busy === "choose" && !beforeInUse ? <Spinner className="h-4 w-4" /> : null}
            {sourceIsAi ? t("adjustKeepPrevious") : t("adjustKeepMine")}
          </button>
        </Card>
        {pictures.map(({ candidate, step }) => {
          const n = results.findIndex((r) => r.candidate === candidate) + 1;
          const adjust = step!.adjust ?? null;
          const title = t("adjustVersion", { n });
          const subtitle = adjust ? modeName(adjust.mode, adjust.style) : "";
          const chosen = inUse(creation, step!.id);
          // Either says so: the owner must be told whenever these eyes are
          // shown as a choice.
          const generatedEyes = candidate.generated_eyes || Boolean(adjust?.generated_eyes);
          return (
            <Card
              key={step!.id}
              step={step!}
              id={step!.id}
              title={title}
              subtitle={subtitle}
              inUse={chosen}
              generatedEyes={generatedEyes}
            >
              <Checks step={step!} generatedEyes={generatedEyes} />
              {choosable(step!) && candidate.ok !== false && !chosen && (
                <button
                  type="button"
                  className="btn-primary mt-auto min-h-11 text-xs"
                  onClick={() => onUse(step!.id)}
                  disabled={locked}
                  aria-describedby={`result-${step!.id.replace(":", "-")}-title`}
                >
                  {t("adjustUseThis")}
                </button>
              )}
            </Card>
          );
        })}
      </ul>
      {imageless.length > 0 && (
        <ul className="mt-3 list-disc space-y-1 ps-5 text-sm text-gray-600 dark:text-gray-300">
          {imageless.map((r) => (
            <li key={r.n}>{t("adjustNoImage", { n: r.n, reason: candidateReasonText(t, r.candidate.reason!) })}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Card({
  step,
  id,
  title,
  subtitle,
  inUse: chosen,
  generatedEyes = Boolean(step.adjust?.generated_eyes),
  children,
}: {
  step: CreationStep;
  id: string;
  title: string;
  subtitle: string;
  inUse: boolean;
  generatedEyes?: boolean;
  children?: React.ReactNode;
}) {
  const { t } = useTranslation();
  const rejected = step.adjust?.rejected ?? null;
  const titleId = `result-${id.replace(":", "-")}-title`;
  return (
    <li
      aria-labelledby={titleId}
      className={`flex min-w-0 flex-col overflow-hidden rounded-2xl border-2 ${
        chosen ? "border-brand-500" : "border-gray-200 dark:border-line"
      }`}
    >
      <div
        className={`relative grid aspect-square w-full place-items-center overflow-hidden ${
          isTransparent(step) ? CHECKER : "bg-gray-50 dark:bg-white/[0.03]"
        }`}
      >
        <img
          src={step.url}
          alt={`${title}${subtitle ? `, ${subtitle}` : ""}`}
          className={`max-h-full max-w-full object-contain ${rejected ? "opacity-60" : ""}`}
        />
        {generatedEyes && (
          <span className="absolute start-1.5 top-1.5 inline-flex items-center gap-1 rounded-md bg-black/75 px-1.5 py-0.5 text-[11px] font-medium text-white">
            <Icon name="eye" className="h-3.5 w-3.5" />
            {t("adjustGeneratedEyes")}
          </span>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-1.5 p-2.5 sm:p-3">
        <p id={titleId} className="text-[13px] font-medium leading-snug">
          {title}
          {chosen && (
            <span className="ms-1.5 whitespace-nowrap rounded-full bg-brand-600 px-2 py-0.5 text-[11px] font-medium text-white">
              {t("adjustInUse")}
            </span>
          )}
        </p>
        {subtitle && <p className="text-[11px] text-gray-500 dark:text-gray-400">{subtitle}</p>}
        {children}
      </div>
    </li>
  );
}

/** What the checks found on one version, or why it was turned down. */
function Checks({ step, generatedEyes }: { step: CreationStep; generatedEyes: boolean }) {
  const { t, i18n } = useTranslation();
  const adjust = step.adjust ?? null;
  if (!adjust) return null;
  if (adjust.rejected) {
    return (
      <p className="text-xs text-amber-800 dark:text-amber-300">
        <span className="font-medium">{t("adjustRejected")}</span> {candidateReasonText(t, adjust.rejected)}
      </p>
    );
  }
  const checks = adjust.checks ?? {};
  const notes: string[] = [];
  if (checks.detected !== undefined) notes.push(t(checks.detected ? "adjustCheckFace" : "adjustCheckNoFace"));
  if (checks.fit_ok !== undefined) notes.push(t(checks.fit_ok ? "adjustCheckFit" : "adjustCheckNoFit"));
  if (typeof checks.skin_delta_e === "number") {
    const value = new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 }).format(checks.skin_delta_e);
    notes.push(t("adjustCheckSkin", { value }));
  }
  return (
    <>
      {notes.length > 0 && <p className="text-xs text-gray-600 dark:text-gray-300">{notes.join(" · ")}</p>}
      {generatedEyes && <p className="text-xs text-gray-600 dark:text-gray-300">{t("adjustGeneratedEyesHint")}</p>}
      {adjust.mode === "stylise" && <p className="text-xs text-gray-500 dark:text-gray-400">{t("adjustStyliseNote")}</p>}
      <p className="text-[11px] text-gray-500 dark:text-gray-400">{t("adjustMadeBy", { model: adjust.model })}</p>
    </>
  );
}
