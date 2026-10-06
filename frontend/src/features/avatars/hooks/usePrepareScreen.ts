import { useEffect, useRef, useState } from "react";

import { creationRequests } from "@/features/avatars/api";
import { consentProblem } from "@/features/avatars/consent";
import { type DraftStore, errorText, isJobActive, jobFailure } from "@/features/avatars/creation";
import type { ConsentApi } from "@/features/avatars/hooks/useConsent";
import type { Run } from "@/features/avatars/hooks/useCreation";
import {
  activeChange,
  beforeStep,
  canUseOriginal,
  clearBody,
  freeClearsLeft,
  heldStage,
  isPrepareJob,
  needsPrepare,
  planOf,
  type PrepareBody,
  prepareChecklist,
  preparedStep,
  preparePhase,
  type PrepareStage,
  prepareStage,
  recallChoices,
  retryBody,
  triesLeft,
  type Version,
  type WizardCreation,
} from "@/features/avatars/wizard";
import { useT } from "@/i18n";
import { ApiError } from "@/lib/api";

function tabStore(): DraftStore | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Step 3's state and requests (PrepareScreen draws them). It starts by
 * itself, once per revision: the AI in the chosen look when the owner
 * agreed to it on step 2 (or had before), else, for a realistic upload,
 * the photo itself cut out; otherwise it asks for the agreement. Then:
 * the try again, a change in words, the AI's removal of a change, the
 * original photo, a version chosen, and the job's stage held so the words
 * never go back within a run. A refusal for want of an agreement asks for
 * one here.
 */
export function usePrepareScreen({
  orgId,
  creation,
  busy,
  run,
  consent,
}: {
  orgId: string;
  creation: WizardCreation;
  busy: string | null;
  run: Run;
  consent: ConsentApi;
}) {
  const { t } = useT();
  const requests = creationRequests(orgId, creation.id);
  const plan = planOf(creation);
  const choices = recallChoices(tabStore(), creation.id);
  const phase = preparePhase(creation);
  const job = creation.job;
  const result = preparedStep(creation);
  const last = creation.ai?.last_prepare ?? null;
  const aiOn = consent.aiEnabled && creation.ai?.enabled !== false;
  const consentId = consent.aiConsentId;
  const tries = triesLeft(creation);
  const [change, setChange] = useState("");
  // The owner must agree before the AI is used here (a refused remembered
  // agreement, or a draft whose agreement this tab does not know).
  const [askAi, setAskAi] = useState(false);
  const [agree, setAgree] = useState(false);
  // The version being switched to, while the server does it.
  const [pending, setPending] = useState<string | null>(null);

  /** A refusal for want of the AI agreement: forget the remembered one, ask. */
  const askOnRefusal = (err: unknown) => {
    const problem = err instanceof ApiError ? consentProblem(err.code, err.body) : null;
    if (problem?.kind === "required" && problem.scope === "third_party_ai") {
      consent.forgetAi();
      setAskAi(true);
    }
  };

  const prepare = (body: PrepareBody, agreed?: string) =>
    run(body.mode === "change" ? "change" : "prepare", async () => {
      const id = agreed ?? (typeof consentId === "string" ? consentId : undefined);
      try {
        return await requests.prepare(body, id);
      } catch (err) {
        askOnRefusal(err);
        throw err;
      }
    });

  // Start by itself, once per revision: the intent step 2 recorded, or
  // what the plan and the member's remembered agreement allow. Decided when
  // the revision, the job's state, the agreement or the runner changes,
  // with this render's view of the rest (`auto`).
  const asked = useRef(new Set<number>());
  const auto = useRef({ creation, plan, choices, aiOn, prepare });
  auto.current = { creation, plan, choices, aiOn, prepare };
  useEffect(() => {
    const { creation, plan, choices, aiOn, prepare } = auto.current;
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
        return await requests.retry(typeof consentId === "string" ? consentId : undefined);
      } catch (err) {
        askOnRefusal(err);
        throw err;
      }
    });

  const working = phase === "working" || (phase === "waiting" && busy === "prepare");
  // Monotonic within a run: see heldStage.
  const shownStage = useRef<PrepareStage | null>(null);
  // A run is over once a picture is shown (or it failed) and nothing is working.
  const idle = (phase === "done" || phase === "failed") && busy === null && !(job && isJobActive(job));
  const stage = idle ? null : heldStage(shownStage.current, prepareStage(job) ?? (busy ? "upload" : null));
  shownStage.current = stage;
  const failure = job && isPrepareJob(job) ? jobFailure(job) : null;
  const redoing = working || busy === "prepare" || busy === "change" || busy === "retry";

  const applyChange = () => {
    const words = change.trim();
    if (!words || redoing || busy !== null) return;
    void prepare({ mode: "change", instruction: words }).then((outcome) => {
      if (outcome.ok) setChange("");
    });
  };

  const chooseVersion = (version: Version) => {
    if (version.needsPrepare) {
      // The photo as it is, never prepared yet: "use my original photo".
      void prepare({ mode: "original" });
      return;
    }
    setPending(version.id);
    void run("version", () => requests.version(version.id)).finally(() => setPending(null));
  };

  return {
    plan,
    choices,
    phase,
    job,
    result,
    before: beforeStep(creation),
    last,
    lastWasOriginal: last?.mode === "original",
    aiOn,
    tries,
    freeClear: freeClearsLeft(creation) > 0,
    canAi: aiOn && tries > 0,
    originalOffered: canUseOriginal(plan),
    askAi,
    agree,
    setAgree,
    pending,
    working,
    redoing,
    stage,
    stages: prepareChecklist(plan.source, !(last?.mode === "original") && choices?.intent !== "original"),
    fraction: job && isJobActive(job) ? (job.progress?.fraction ?? null) : null,
    failureText: failure ? errorText(t, failure.code, failure.detail) : null,
    applied: activeChange(last),
    change,
    setChange,
    applyChange,
    chooseVersion,
    agreeAndPrepare: () => void agreeAndPrepare(),
    retryJob,
    /** The photo as it is, without the AI. */
    original: () => void prepare({ mode: "original" }),
    /** The same, from the agreement panel, which it closes. */
    originalInstead: () => {
      setAskAi(false);
      void prepare({ mode: "original" });
    },
    clearChange: () => void prepare(clearBody(plan)),
    retry: () => void prepare(retryBody(plan, last)),
    /** "Use AI" after the original: straight away with the remembered
     *  agreement, else ask for it here. */
    useAi: () => (typeof consentId === "string" ? void prepare({ mode: "ai" }) : setAskAi(true)),
  };
}

export type PrepareScreenState = ReturnType<typeof usePrepareScreen>;
