import type { AvatarEngine } from "@liveface/embed";
import { useEffect, useMemo, useReducer, useRef, useState } from "react";

import { creationRequests } from "@/features/avatars/api";
import { consentProblem, type FaceStatement } from "@/features/avatars/consent";
import {
  type CreationAnchors,
  errorText,
  jobFailure,
  pickMarks,
  rememberFinishNotice,
  tabStore,
} from "@/features/avatars/creation";
import type { FaceMarks, FitReason } from "@/features/avatars/face-marks";
import type { ConsentApi } from "@/features/avatars/hooks/useConsent";
import type { Run } from "@/features/avatars/hooks/useCreation";
import { LINES } from "@/features/avatars/lines";
import {
  avatarName,
  faceFound,
  planOf,
  recallChoices,
  statementToAsk,
  type WizardCreation,
} from "@/features/avatars/wizard";
import { useT } from "@/i18n";
import type { MessageKey } from "@/i18n/types";
import { ApiError } from "@/lib/api";

// The preview follows moved points this long after the last move.
const PREVIEW_DELAY_MS = 400;

export const PUBLISH_VIEWS = ["points", "preview"] as const;
export type PublishView = (typeof PUBLISH_VIEWS)[number];

/** The fit Publish would build: its rig (a blob URL, null until the first
 *  answer), what it refuses, and why the last preview failed. */
interface Fit {
  rigUrl: string | null;
  reasons: FitReason[];
  previewError: string | null;
}

type FitEvent =
  | { type: "previewed"; rigUrl: string; reasons: FitReason[] }
  | { type: "previewFailed"; error: string }
  | { type: "refused"; reasons: FitReason[] };

function fit(state: Fit, event: FitEvent): Fit {
  switch (event.type) {
    case "previewed":
      return { rigUrl: event.rigUrl, reasons: event.reasons, previewError: null };
    case "previewFailed":
      return { ...state, previewError: event.error };
    case "refused":
      return { ...state, reasons: event.reasons };
  }
}

/**
 * What the member says before Publish: that points placed by hand sit
 * right (`confirmed`), and the statement about this face (`statement`).
 * `refused`: the statement a refusal at Publish asked for, shown as a box
 * here either way (Publish never fails on a statement it does not let the
 * member make).
 */
interface Answers {
  confirmed: boolean;
  statement: boolean;
  refused: FaceStatement | null;
}

type AnswerEvent =
  | { type: "confirmed"; value: boolean }
  | { type: "statement"; value: boolean }
  | { type: "statementAsked"; scope: FaceStatement };

function answers(state: Answers, event: AnswerEvent): Answers {
  switch (event.type) {
    case "confirmed":
      return { ...state, confirmed: event.value };
    case "statement":
      return { ...state, statement: event.value };
    case "statementAsked":
      return { ...state, refused: event.scope, statement: false };
  }
}

/**
 * Step 4's editor state and requests (PublishScreen draws them): the points
 * (as found, or moved), the rig Publish would build fitted without saving
 * and following the points (only the newest answer lands), what holds
 * Publish, and Publish itself: the statement recorded when one is asked,
 * the creation finished on the server's detection (one click) or on every
 * point as it is on screen, and a refusal answered in place (the statement
 * box focused, the stretched points listed).
 */
export function usePublishEditor({
  orgId,
  creation,
  anchors,
  run,
  consent,
  refetch,
  clearError,
  onFixing,
}: {
  orgId: string;
  creation: WizardCreation;
  anchors: CreationAnchors;
  run: Run;
  consent: ConsentApi;
  refetch: () => unknown;
  clearError: () => void;
  onFixing: (fixing: boolean) => void;
}) {
  const { t } = useT();
  const requests = useMemo(() => creationRequests(orgId, creation.id), [orgId, creation.id]);
  const plan = planOf(creation);
  const line = LINES[creation.face_type ?? "human"];
  const found = faceFound(anchors);
  // The big picture shows the points (to drag) or the talking preview: two
  // canvases that cannot be one. Points first; playing the sample switches.
  const [view, setView] = useState<PublishView>("points");
  const [marks, setMarks] = useState<FaceMarks>(anchors.marks);
  const [engine, setEngine] = useState<AvatarEngine | null>(null);
  const [rig, fitted] = useReducer(fit, { rigUrl: null, reasons: anchors.validation.reasons, previewError: null });
  const [said, answer] = useReducer(answers, { confirmed: false, statement: false, refused: null });
  const statementScope =
    said.refused ?? statementToAsk(creation, recallChoices(tabStore(), creation.id)?.statement ?? null);
  const statementBox = useRef<HTMLInputElement>(null);
  const latest = useRef(0);
  const edited = JSON.stringify(marks) !== JSON.stringify(anchors.marks);

  // Whether the page says "fix the points": per anchors (the editor is
  // keyed by them); onFixing is the wizard's state setter.
  useEffect(() => {
    onFixing(!found);
  }, [onFixing, found]);

  // Blob URLs are a real allocation: each is dropped when replaced.
  useEffect(
    () => () => {
      if (rig.rigUrl) URL.revokeObjectURL(rig.rigUrl);
    },
    [rig.rigUrl]
  );

  // What the preview request reads when it goes, not what starts it: whether
  // the marks were moved, how to say an error, and whether a preview is up
  // already (which only picks the delay).
  const previewInputs = useRef({ edited, refetch, t, shown: false });
  previewInputs.current = { edited, refetch, t, shown: rig.rigUrl !== null };

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
          const rigUrl = URL.createObjectURL(new Blob([JSON.stringify(result.rig)], { type: "application/json" }));
          fitted({ type: "previewed", rigUrl, reasons: result.reasons });
        } catch (err) {
          if (request !== latest.current) return;
          if (err instanceof ApiError && err.code === "anchors_stale") {
            void refetch();
            return;
          }
          fitted({
            type: "previewFailed",
            error: err instanceof ApiError ? errorText(t, err.code, err.detail, err.retryAfter) : t("wzPreviewFailed"),
          });
        }
      },
      previewInputs.current.shown ? PREVIEW_DELAY_MS : 0
    );
    return () => window.clearTimeout(timer);
  }, [marks, anchors.id, requests]);

  const blocked = rig.reasons.length > 0;
  const needsConfirm = !found;
  const hold: MessageKey | null = blocked
    ? "wzHoldFit"
    : needsConfirm && !said.confirmed
      ? "wzHoldPoints"
      : statementScope && !said.statement
        ? "wzHoldStatement2"
        : null;

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
      answer({ type: "statementAsked", scope: problem.scope });
      window.setTimeout(() => statementBox.current?.focus(), 0);
    }
    if (outcome.error.code === "fit_invalid" && Array.isArray(outcome.error.body.reasons)) {
      fitted({ type: "refused", reasons: outcome.error.body.reasons as FitReason[] });
      setView("points");
    }
  };

  return {
    plan,
    found,
    view,
    setView,
    marks,
    setMarks,
    edited,
    resetMarks: () => setMarks(anchors.marks),
    engine,
    setEngine,
    rigUrl: rig.rigUrl,
    previewError: rig.previewError,
    reasons: rig.reasons,
    needsConfirm,
    confirmed: said.confirmed,
    confirm: (value: boolean) => answer({ type: "confirmed", value }),
    statementScope,
    statement: said.statement,
    agreeStatement: (value: boolean) => answer({ type: "statement", value }),
    statementBox,
    hold,
    failure: creation.job?.step === "finish" ? jobFailure(creation.job) : null,
    name,
    publish: () => void publish(),
  };
}

export type PublishEditorState = ReturnType<typeof usePublishEditor>;
