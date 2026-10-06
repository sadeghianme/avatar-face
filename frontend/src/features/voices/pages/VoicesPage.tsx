import { useEffect, useRef, useState } from "react";

import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import { Checkbox } from "@/components/ui/Checkbox";
import { CodeBlock } from "@/components/ui/CodeBlock";
import { Field } from "@/components/ui/Field";
import { FieldError } from "@/components/ui/FieldError";
import { IconButton } from "@/components/ui/IconButton";
import { Input } from "@/components/ui/Input";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { Textarea } from "@/components/ui/Textarea";
import {
  CLONED_PROVIDER,
  type CloneJob,
  synthesize,
  useClonedVoices,
  useCloneJobs,
  useRemoveClonedVoice,
  useRemoveCloneJob,
  useRenderCapability,
  useRenderHere,
  useSubmitClone,
} from "@/features/voices/api";
import { useT } from "@/i18n";
import { ApiError } from "@/lib/api";
import { cx } from "@/lib/cx";
import { MicRecorder, type Recording } from "@/lib/recorder";
import { useOrg } from "@/providers/org";

/** Long enough to carry a voice, short enough to actually get recorded. */
const MIN_REFERENCE_SECONDS = 6;

/**
 * Record a voice, queue the clone, watch it render, play the result.
 *
 * The rendering itself happens on the operator's own hardware (see
 * scripts/clone_worker.py) because the server has no GPU — this page is the
 * whole human side of that: everything from microphone to playback, no
 * terminal anywhere.
 */
export function VoicesPage() {
  const { t } = useT();
  const { current } = useOrg();
  const orgId = current?.id;

  // --- recorder state
  const recorderRef = useRef<MicRecorder | null>(null);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [reference, setReference] = useState<Recording | null>(null);
  const [name, setName] = useState("");
  const [lines, setLines] = useState(() => t("voicesDefaultLines"));
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!recording) return;
    const started = Date.now();
    const timer = setInterval(() => setElapsed((Date.now() - started) / 1000), 200);
    return () => clearInterval(timer);
  }, [recording]);
  // Object URLs are real allocations; drop the old one on replace/unmount.
  useEffect(
    () => () => {
      if (reference) URL.revokeObjectURL(reference.url);
    },
    [reference]
  );

  // Can the backend render on its own hardware? Locally yes; on the
  // CPU-only server no — the UI adapts rather than assuming.
  const { data: renderCap } = useRenderCapability(orgId);
  const render = useRenderHere(orgId);

  const renderHere = async (jobId: string) => {
    setError(null);
    try {
      await render.mutateAsync(jobId);
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : t("error"));
    }
  };

  // Live progress while anything is rendering; a finished job's voice
  // joins the list (useCloneJobs).
  const { data: jobs = [] } = useCloneJobs(orgId);
  const { data: voices = [] } = useClonedVoices(orgId);
  const removeJobRequest = useRemoveCloneJob(orgId);
  const removeVoiceRequest = useRemoveClonedVoice(orgId);
  const submit = useSubmitClone(orgId);

  const toggleRecording = async () => {
    setError(null);
    if (recording) {
      const result = await recorderRef.current!.stop();
      setRecording(false);
      setReference(result);
      return;
    }
    try {
      recorderRef.current = new MicRecorder();
      await recorderRef.current.start();
      setElapsed(0);
      setRecording(true);
    } catch {
      setError(t("voicesMicDenied"));
    }
  };

  /** Queue the clone: the recording, its name, the lines, the consent. */
  const send = () => {
    const form = new FormData();
    form.append("name", name.trim());
    form.append("locale", "en-US");
    form.append(
      "lines",
      JSON.stringify(
        lines
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
      )
    );
    form.append("consent", String(consent));
    form.append("reference", reference!.blob, "reference.wav");
    submit.mutate(form, {
      onSuccess: () => {
        setReference(null);
        setName("");
        setConsent(false);
      },
      onError: (err) => setError(err instanceof ApiError ? err.detail : t("error")),
    });
  };

  const removeJob = async (id: string) => {
    await removeJobRequest.mutateAsync(id);
  };
  const removeVoice = async (label: string) => {
    await removeVoiceRequest.mutateAsync(label);
  };

  // Play one rendered line through the normal synthesis path (cache hit).
  const [playing, setPlaying] = useState<string | null>(null);
  const play = async (voice: string, text: string) => {
    const key = `${voice}:${text}`;
    setPlaying(key);
    try {
      const payload = await synthesize(orgId!, { provider: CLONED_PROVIDER, voice, locale: "en-US", text });
      const audio = new Audio(`data:${payload.audio_mime};base64,${payload.audio_b64}`);
      await audio.play();
      audio.onended = () => setPlaying(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : t("error"));
      setPlaying(null);
    }
  };

  const canSubmit =
    Boolean(reference && reference.seconds >= MIN_REFERENCE_SECONDS) &&
    Boolean(name.trim()) &&
    consent &&
    !submit.isPending;
  const waiting = jobs.some((j) => j.status === "pending");

  return (
    <div>
      <h1 className="text-2xl font-semibold">{t("voicesTitle")}</h1>
      <p className="mb-6 mt-1 text-[13px] max-lg:text-sm text-gray-500 dark:text-gray-400">{t("voicesSubtitle")}</p>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* ------------------------------------------------ record & submit */}
        <Card as="section">
          <CardHeader
            className="mb-3"
            title={t("voicesRecordTitle")}
            description={t("voicesRecordHint", { seconds: MIN_REFERENCE_SECONDS })}
          />
          {/* Something to read: covers varied phonemes without feeling like a test. */}
          <blockquote className="mb-4 rounded-lg border-s-4 border-brand-300 bg-gray-50 p-3 text-sm italic dark:border-brand-500/40 dark:bg-white/5">
            {t("voicesPassage")}
          </blockquote>

          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant={recording ? "danger" : "primary"}
              icon={recording ? "stop" : "mic"}
              onClick={() => void toggleRecording()}
            >
              {recording ? t("voicesStop") : t("voicesRecord")}
            </Button>
            {recording && <span className="text-sm tabular-nums text-gray-500">{elapsed.toFixed(0)}s</span>}
            {reference && !recording && (
              <>
                {/* eslint-disable-next-line jsx-a11y/media-has-caption -- the member's own voice, just recorded: there is no text to caption */}
                <audio controls src={reference.url} className="h-9 max-w-52" />
                <span
                  className={cx(
                    "text-xs",
                    reference.seconds < MIN_REFERENCE_SECONDS ? "text-amber-600" : "text-gray-500"
                  )}
                >
                  {reference.seconds.toFixed(1)}s
                  {reference.seconds < MIN_REFERENCE_SECONDS && ` — ${t("voicesTooShort")}`}
                </span>
              </>
            )}
          </div>

          <Field id="voice-name" label={t("voicesName")} className="mt-5">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="my-voice" />
          </Field>

          <Field id="voice-lines" label={t("voicesLines")} hint={t("voicesLinesHint")} className="mt-4">
            <Textarea
              className="min-h-28 font-mono text-xs coarse:text-base"
              value={lines}
              onChange={(e) => setLines(e.target.value)}
            />
          </Field>

          <Checkbox
            className="mt-4 gap-2 text-[13px] max-lg:text-sm"
            checked={consent}
            onChange={(e) => setConsent(e.target.checked)}
            label={t("voicesConsent")}
          />

          <Button className="mt-4" icon="plus" loading={submit.isPending} disabled={!canSubmit} onClick={send}>
            {t("voicesSubmit")}
          </Button>
          {error && <FieldError className="mt-2">{error}</FieldError>}
        </Card>

        {/* ------------------------------------------------ jobs & voices */}
        <div className="flex flex-col gap-6">
          {waiting && !renderCap?.available && (
            <Card tone="warning">
              <p className="text-[13px] text-amber-700 max-lg:text-sm dark:text-amber-400">{t("voicesWorkerHint")}</p>
              <CodeBlock
                className="mt-2"
                preClassName="text-[11px] text-gray-100"
                copy={{ label: t("copy"), copiedLabel: t("copied") }}
                code={`python -m scripts.clone_worker \\
  --api ${window.location.origin}/api \\
  --email you@example.com \\
  --org ${orgId}`}
              />
            </Card>
          )}

          {jobs.length > 0 && (
            <Card as="section">
              <CardHeader className="mb-3" title={t("voicesJobs")} />
              <div className="flex flex-col gap-3">
                {jobs.map((job) => (
                  <div key={job.id} className="rounded-lg border border-gray-200 p-3 dark:border-line">
                    <div className="flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate font-medium">{job.name}</span>
                      <div className="flex items-center gap-2">
                        {renderCap?.available && (job.status === "pending" || job.status === "failed") && (
                          <Button size="xs" onClick={() => void renderHere(job.id)}>
                            {t("voicesRenderHere")}
                          </Button>
                        )}
                        <JobStatus job={job} />
                        <IconButton
                          variant="danger"
                          label={t("delete")}
                          icon="trash"
                          iconClassName="h-4 w-4"
                          className="coarse:-me-2"
                          onClick={() => void removeJob(job.id)}
                        />
                      </div>
                    </div>
                    {job.status === "processing" && (
                      <ProgressBar
                        value={(job.done_lines / job.lines.length) * 100}
                        label={job.name}
                        className="mt-2 h-1.5 rounded"
                      />
                    )}
                    {job.error && (
                      <FieldError live={false} className="mt-2">
                        {job.error}
                      </FieldError>
                    )}
                    {job.status === "done" && (
                      <ul className="mt-2 flex flex-col gap-1">
                        {job.lines.map((line) => {
                          const voiceId = `${orgId}:${job.name}`;
                          const key = `${voiceId}:${line}`;
                          return (
                            <li key={line} className="flex items-center gap-2 text-[13px] max-lg:text-sm">
                              <Button
                                variant="secondary"
                                className="px-2 py-1 coarse:min-w-11"
                                icon="speaker"
                                iconClassName="h-3.5 w-3.5"
                                loading={playing === key}
                                onClick={() => void play(voiceId, line)}
                                aria-label={t("speak")}
                              />
                              <span className="truncate">{line}</span>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
            </Card>
          )}

          {voices.length > 0 && (
            <Card as="section">
              <CardHeader className="mb-3" title={t("voicesYours")} />
              <div className="flex flex-col gap-2">
                {voices.map((voice) => (
                  <div key={voice.voice} className="flex items-center justify-between gap-2 text-sm">
                    <span className="min-w-0 truncate font-medium">{voice.label}</span>
                    <span className="text-xs text-gray-500">
                      {t("voicesStats", {
                        lines: voice.lines,
                        seconds: Math.round(voice.total_ms / 1000),
                      })}
                    </span>
                    <IconButton
                      variant="danger"
                      label={t("delete")}
                      icon="trash"
                      iconClassName="h-4 w-4"
                      className="coarse:-me-2"
                      onClick={() => void removeVoice(voice.label)}
                    />
                  </div>
                ))}
              </div>
              <p className="mt-3 text-xs text-gray-500">{t("voicesUseHint")}</p>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

const JOB_TONE: Record<CloneJob["status"], BadgeTone> = {
  pending: "neutral",
  processing: "brand",
  done: "success",
  failed: "danger",
};

function JobStatus({ job }: { job: CloneJob }) {
  const { t } = useT();
  return (
    <Badge tone={JOB_TONE[job.status]}>
      {t(`voicesStatus_${job.status}`)}
      {job.status === "processing" && ` ${job.done_lines}/${job.lines.length}`}
    </Badge>
  );
}
