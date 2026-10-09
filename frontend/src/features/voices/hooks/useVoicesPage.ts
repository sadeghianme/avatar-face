import { useReducer, useState } from "react";
import { useLocation } from "react-router-dom";

import {
  CLONED_PROVIDER,
  synthesize,
  useClonedVoices,
  useCloneJobs,
  useRemoveClonedVoice,
  useRemoveCloneJob,
  useRenderCapability,
  useRenderHere,
  useSubmitClone,
} from "@/features/voices/api";
import { renderLineRequest } from "@/features/voices/clonedLines";
import { useVoiceRecorder } from "@/features/voices/hooks/useVoiceRecorder";
import { useT } from "@/i18n";
import { ApiError } from "@/lib/api";
import { useOrg } from "@/providers/org";

/** Long enough to carry a voice, short enough to actually get recorded. */
export const MIN_REFERENCE_SECONDS = 6;

/** The clone to queue: its name, the lines it will say, the permission. */
interface CloneForm {
  name: string;
  lines: string;
  consent: boolean;
}

type FormEvent =
  | { type: "name"; name: string }
  | { type: "lines"; lines: string }
  | { type: "consent"; consent: boolean }
  | { type: "sent" };

function cloneForm(state: CloneForm, event: FormEvent): CloneForm {
  switch (event.type) {
    case "name":
      return { ...state, name: event.name };
    case "lines":
      return { ...state, lines: event.lines };
    case "consent":
      return { ...state, consent: event.consent };
    case "sent":
      // Ready for the next voice; the lines stay, they are the same script.
      return { ...state, name: "", consent: false };
  }
}

/**
 * The voices page's state and requests (VoicesPage draws them): the
 * recorder, the clone form and its queueing, the jobs (polled while one
 * renders; rendered here when this server can), the voices made, and a
 * rendered line played through the normal synthesis path (a cache hit).
 * Opened from the Speak panel for a line a cloned voice does not have, the
 * form starts with that voice's name and that line: a reference recorded
 * and queued under the same name adds the line to the voice.
 */
export function useVoicesPage() {
  const { t } = useT();
  const orgId = useOrg().current?.id;
  const requested = renderLineRequest(useLocation().state);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const [form, change] = useReducer(cloneForm, undefined, () => ({
    name: requested?.voice ?? "",
    lines: requested?.line ?? t("voicesDefaultLines"),
    consent: false,
  }));
  const recorder = useVoiceRecorder(() => setError(t("voicesMicDenied")));

  // Can the backend render on its own hardware? Locally yes; on the
  // CPU-only server no — the UI adapts rather than assuming.
  const { data: renderCap } = useRenderCapability(orgId);
  const render = useRenderHere(orgId);
  // Live progress while anything is rendering; a finished job's voice
  // joins the list (useCloneJobs).
  const { data: jobs = [] } = useCloneJobs(orgId);
  const { data: voices = [] } = useClonedVoices(orgId);
  const removeJob = useRemoveCloneJob(orgId);
  const removeVoice = useRemoveClonedVoice(orgId);
  const submit = useSubmitClone(orgId);
  const refusal = (err: unknown) => (err instanceof ApiError ? err.detail : t("error"));

  const renderHere = async (jobId: string) => {
    setError(null);
    try {
      await render.mutateAsync(jobId);
    } catch (err) {
      setError(refusal(err));
    }
  };

  /** Queue the clone: the recording, its name, the lines, the consent. */
  const send = () => {
    const body = new FormData();
    body.append("name", form.name.trim());
    body.append("locale", "en-US");
    body.append(
      "lines",
      JSON.stringify(
        form.lines
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
      )
    );
    body.append("consent", String(form.consent));
    body.append("reference", recorder.reference!.blob, "reference.wav");
    submit.mutate(body, {
      onSuccess: () => {
        recorder.clear();
        change({ type: "sent" });
      },
      onError: (err) => setError(refusal(err)),
    });
  };

  const play = async (voice: string, text: string) => {
    setPlaying(`${voice}:${text}`);
    try {
      const payload = await synthesize(orgId!, { provider: CLONED_PROVIDER, voice, locale: "en-US", text });
      const audio = new Audio(`data:${payload.audio_mime};base64,${payload.audio_b64}`);
      await audio.play();
      audio.onended = () => setPlaying(null);
    } catch (err) {
      setError(refusal(err));
      setPlaying(null);
    }
  };

  const reference = recorder.reference;
  return {
    orgId,
    recorder: {
      ...recorder,
      toggle: () => {
        setError(null);
        void recorder.toggle();
      },
    },
    form,
    setName: (name: string) => change({ type: "name", name }),
    setLines: (lines: string) => change({ type: "lines", lines }),
    setConsent: (consent: boolean) => change({ type: "consent", consent }),
    canSubmit:
      Boolean(reference && reference.seconds >= MIN_REFERENCE_SECONDS) &&
      Boolean(form.name.trim()) &&
      form.consent &&
      !submit.isPending,
    sending: submit.isPending,
    send,
    error,
    jobs,
    voices,
    /** A job waits for the render worker (none renders here). */
    waiting: jobs.some((j) => j.status === "pending"),
    canRenderHere: Boolean(renderCap?.available),
    renderHere: (jobId: string) => void renderHere(jobId),
    removeJob: (jobId: string) => void removeJob.mutateAsync(jobId),
    removeVoice: (label: string) => void removeVoice.mutateAsync(label),
    playing,
    play: (voice: string, text: string) => void play(voice, text),
  };
}

export type VoicesPageState = ReturnType<typeof useVoicesPage>;
