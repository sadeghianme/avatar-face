import { useEffect, useReducer } from "react";

import { useRadioGroup } from "@/components/ui/useRadioGroup";
import { startCreation } from "@/features/avatars/api";
import { consentProblem, type FaceStatement, providerLabel } from "@/features/avatars/consent";
import { checkFile, type Creation, errorText, tabStore } from "@/features/avatars/creation";
import type { ConsentApi } from "@/features/avatars/hooks/useConsent";
import {
  aiRequired,
  type AvatarModel,
  type Choices,
  intentFor,
  type Look,
  LOOKS,
  photoBlocker,
  type PhotoSource,
  rememberChoices,
  SOURCES,
  statementFor,
} from "@/features/avatars/wizard";
import { useT } from "@/i18n";
import { ApiError } from "@/lib/api";

/** What step 2 has been given: how to start, the look, the words or the
 * photo (with its preview's object URL), and the two agreements. */
interface PhotoForm {
  source: PhotoSource;
  look: Look;
  description: string;
  file: File | null;
  preview: string | null;
  fileError: string | null;
  aiAgreed: boolean;
  statementAgreed: boolean;
}

type FormEvent =
  | { type: "source"; source: PhotoSource }
  | { type: "look"; look: Look }
  | { type: "describe"; description: string }
  /** A file picked or dropped: taken, refused (`error`), or none. */
  | { type: "picked"; file: File; preview: string }
  | { type: "fileError"; error: string | null }
  | { type: "fileCleared" }
  | { type: "aiAgreed"; agreed: boolean }
  | { type: "statementAgreed"; agreed: boolean };

function photoForm(state: PhotoForm, event: FormEvent): PhotoForm {
  switch (event.type) {
    case "source":
      return { ...state, source: event.source };
    case "look":
      return { ...state, look: event.look };
    case "describe":
      return { ...state, description: event.description };
    case "picked":
      return { ...state, file: event.file, preview: event.preview, fileError: null };
    case "fileError":
      return { ...state, fileError: event.error };
    case "fileCleared":
      return { ...state, file: null, preview: null };
    case "aiAgreed":
      return { ...state, aiAgreed: event.agreed };
    case "statementAgreed":
      return { ...state, statementAgreed: event.agreed };
  }
}

/** "Create my avatar" on its way: the upload's progress (0..1, null when
 *  there is none), and why the last try failed. */
interface Sending {
  busy: boolean;
  progress: number | null;
  error: string | null;
}

type SendEvent = { type: "started" } | { type: "progress"; fraction: number } | { type: "failed"; error: string };

function sending(state: Sending, event: SendEvent): Sending {
  switch (event.type) {
    case "started":
      return { ...state, busy: true, error: null };
    case "progress":
      return { ...state, progress: event.fraction };
    case "failed":
      return { busy: false, progress: null, error: event.error };
  }
}

/**
 * Step 2's state and its one request (PhotoStep draws them): the choices,
 * what holds "Create my avatar" (`blocker`), and the creation itself:
 * the AI agreement recorded (unless the member already agreed to the words
 * in force), the photo or the description sent, and the statement
 * recorded for the creation that came back, so publishing asks nothing
 * again. A remembered agreement the server no longer takes is agreed again
 * here, where its box is ticked, and the request sent once more.
 */
export function usePhotoStep({
  orgId,
  model,
  consent,
  initial,
  onCreated,
}: {
  orgId: string;
  model: AvatarModel;
  consent: ConsentApi;
  initial: Choices | null;
  onCreated: (creation: Creation) => void;
}) {
  const { t } = useT();
  const aiEnabled = consent.aiEnabled;
  const remembered = typeof consent.aiConsentId === "string";
  const [form, change] = useReducer(photoForm, undefined, () => ({
    source: initial?.source ?? (aiEnabled ? "generate" : "upload"),
    look: initial?.look ?? "realistic",
    description: initial?.description ?? "",
    file: null,
    preview: null,
    fileError: null,
    aiAgreed: remembered,
    statementAgreed: false,
  }));
  const [send, sent] = useReducer(sending, { busy: false, progress: null, error: null });
  const { source, look, description, file, aiAgreed, statementAgreed } = form;

  // A remembered agreement arrives after the first render: shown ticked.
  useEffect(() => {
    if (remembered) change({ type: "aiAgreed", agreed: true });
  }, [remembered]);

  // The object URL is a real allocation: dropped when replaced.
  useEffect(
    () => () => {
      if (form.preview) URL.revokeObjectURL(form.preview);
    },
    [form.preview]
  );

  // Without the AI, a character cannot be generated.
  useEffect(() => {
    if (!aiEnabled && source === "generate") change({ type: "source", source: "upload" });
  }, [aiEnabled, source]);

  const statement = statementFor(model, source);
  const blocker = photoBlocker({
    model,
    source,
    look,
    description,
    hasFile: Boolean(file),
    aiAgreed,
    statementAgreed,
    aiEnabled,
  });

  const pick = (next: File | undefined) => {
    change({ type: "fileError", error: null });
    if (!next) return;
    const problem = checkFile(next);
    if (problem) {
      change({ type: "fileError", error: errorText(t, problem, "") });
      return;
    }
    change({ type: "picked", file: next, preview: URL.createObjectURL(next) });
  };

  const agreement = async (): Promise<string | undefined> => {
    if (!aiAgreed || !aiEnabled) return undefined;
    if (typeof consent.aiConsentId === "string") return consent.aiConsentId;
    return (await consent.record("third_party_ai")).id;
  };

  const request = async (consentId: string | undefined): Promise<Creation> => {
    if (source === "upload" && file) {
      const body = new FormData();
      body.append("file", file);
      body.append("model", model);
      body.append("look", look);
      sent({ type: "progress", fraction: 0 });
      return startCreation.upload(orgId, body, (fraction) => sent({ type: "progress", fraction }));
    }
    return startCreation.generate(orgId, {
      model,
      look,
      prompt: description.trim(),
      ...(consentId ? { consent_id: consentId } : {}),
    });
  };

  const create = async () => {
    if (blocker || send.busy) return;
    sent({ type: "started" });
    try {
      let consentId = await agreement();
      let created: Creation;
      try {
        created = await request(consentId);
      } catch (err) {
        // A remembered agreement the server no longer takes (withdrawn,
        // or the words changed since): agreed again on this screen, where
        // the box is ticked, and sent once more.
        const problem = err instanceof ApiError ? consentProblem(err.code, err.body) : null;
        if (problem?.kind !== "required" || problem.scope !== "third_party_ai" || !consentId) throw err;
        consent.forgetAi();
        consentId = (await consent.record("third_party_ai")).id;
        created = await request(consentId);
      }
      let made: FaceStatement | null = null;
      if (statement) {
        try {
          await consent.record(statement, created.id);
          made = statement;
        } catch {
          // Publish asks again when it finds none; nothing is lost here.
        }
      }
      rememberChoices(tabStore(), created.id, {
        model,
        source,
        look,
        description,
        intent: intentFor({ source, look, aiAgreed, aiEnabled }),
        statement: made,
      });
      onCreated(created);
    } catch (err) {
      sent({
        type: "failed",
        error: err instanceof ApiError ? errorText(t, err.code, err.detail, err.retryAfter) : t("error"),
      });
    }
  };

  const lookDisabled = (l: Look) => !aiEnabled && aiRequired(source, l);
  return {
    form,
    aiEnabled,
    statement,
    needsAi: aiRequired(source, look),
    blocker,
    providers: consent.providers.map(providerLabel).join(", "),
    sourceRadio: useRadioGroup(
      SOURCES,
      source,
      (next) => change({ type: "source", source: next }),
      (s) => s === "generate" && !aiEnabled
    ),
    lookRadio: useRadioGroup(LOOKS, look, (next) => change({ type: "look", look: next }), lookDisabled),
    lookDisabled,
    describe: (text: string) => change({ type: "describe", description: text }),
    pick,
    clearFile: () => change({ type: "fileCleared" }),
    agreeAi: (agreed: boolean) => change({ type: "aiAgreed", agreed }),
    agreeStatement: (agreed: boolean) => change({ type: "statementAgreed", agreed }),
    ...send,
    create: () => void create(),
  };
}

export type PhotoStepState = ReturnType<typeof usePhotoStep>;
