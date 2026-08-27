import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "../components/Icon";
import { Spinner } from "../components/Spinner";
import { api, ApiError } from "../lib/api";
import { MicRecorder, type Recording } from "../lib/recorder";
import { useOrg } from "../lib/org";

interface CloneJob {
  id: string;
  name: string;
  locale: string;
  lines: string[];
  status: "pending" | "processing" | "done" | "failed";
  error: string | null;
  done_lines: number;
}

interface ClonedVoice {
  voice: string;
  label: string;
  lines: number;
  total_ms: number;
}

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
  const { t } = useTranslation();
  const { current } = useOrg();
  const queryClient = useQueryClient();
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
  useEffect(() => () => { if (reference) URL.revokeObjectURL(reference.url); }, [reference]);

  // Can the backend render on its own hardware? Locally yes; on the
  // CPU-only server no — the UI adapts rather than assuming.
  const { data: renderCap } = useQuery({
    queryKey: ["render-capability", orgId],
    queryFn: () => api.get<{ available: boolean; reason: string | null }>(
      `/orgs/${orgId}/clone-jobs/render-capability`
    ),
    enabled: Boolean(orgId),
    staleTime: Infinity, // cannot change without a backend restart
  });

  const renderHere = async (jobId: string) => {
    setError(null);
    try {
      await api.post(`/orgs/${orgId}/clone-jobs/${jobId}/render`, {});
      void queryClient.invalidateQueries({ queryKey: ["clone-jobs", orgId] });
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : t("error"));
    }
  };

  const { data: jobs = [] } = useQuery({
    queryKey: ["clone-jobs", orgId],
    queryFn: () => api.get<CloneJob[]>(`/orgs/${orgId}/clone-jobs`),
    enabled: Boolean(orgId),
    // Live progress while anything is rendering.
    refetchInterval: (query) =>
      query.state.data?.some((j) => j.status === "pending" || j.status === "processing")
        ? 2000
        : false,
  });
  const { data: voices = [] } = useQuery({
    queryKey: ["cloned-voices", orgId],
    queryFn: () => api.get<ClonedVoice[]>(`/orgs/${orgId}/cloned-voices`),
    enabled: Boolean(orgId),
  });
  // A finishing job changes the voices list too.
  const doneCount = jobs.filter((j) => j.status === "done").length;
  useEffect(() => {
    void queryClient.invalidateQueries({ queryKey: ["cloned-voices", orgId] });
  }, [doneCount, orgId, queryClient]);

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

  const submit = useMutation({
    mutationFn: async () => {
      const form = new FormData();
      form.append("name", name.trim());
      form.append("locale", "en-US");
      form.append(
        "lines",
        JSON.stringify(lines.split("\n").map((l) => l.trim()).filter(Boolean))
      );
      form.append("consent", String(consent));
      form.append("reference", reference!.blob, "reference.wav");
      return api.postForm<CloneJob>(`/orgs/${orgId}/clone-jobs`, form);
    },
    onSuccess: () => {
      setReference(null);
      setName("");
      setConsent(false);
      void queryClient.invalidateQueries({ queryKey: ["clone-jobs", orgId] });
    },
    onError: (err) => setError(err instanceof ApiError ? err.detail : t("error")),
  });

  const removeJob = async (id: string) => {
    await api.delete(`/orgs/${orgId}/clone-jobs/${id}`);
    void queryClient.invalidateQueries({ queryKey: ["clone-jobs", orgId] });
  };
  const removeVoice = async (label: string) => {
    await api.delete(`/orgs/${orgId}/cloned-voices/${label}`);
    void queryClient.invalidateQueries({ queryKey: ["cloned-voices", orgId] });
  };

  // Play one rendered line through the normal synthesis path (cache hit).
  const [playing, setPlaying] = useState<string | null>(null);
  const play = async (voice: string, text: string) => {
    const key = `${voice}:${text}`;
    setPlaying(key);
    try {
      const payload = await api.post<{ audio_b64: string; audio_mime: string }>(
        `/tts/orgs/${orgId}/synthesize`,
        { provider: "cloned", voice, locale: "en-US", text }
      );
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
      <p className="mb-6 mt-1 text-[13px] text-gray-500 dark:text-gray-400">
        {t("voicesSubtitle")}
      </p>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* ------------------------------------------------ record & submit */}
        <section className="card">
          <h2 className="mb-1 font-medium">{t("voicesRecordTitle")}</h2>
          <p className="mb-3 text-[13px] text-gray-500 dark:text-gray-400">
            {t("voicesRecordHint", { seconds: MIN_REFERENCE_SECONDS })}
          </p>
          {/* Something to read: covers varied phonemes without feeling like a test. */}
          <blockquote className="mb-4 rounded-lg border-s-4 border-brand-300 bg-gray-50 p-3 text-sm italic dark:border-brand-500/40 dark:bg-white/5">
            {t("voicesPassage")}
          </blockquote>

          <div className="flex items-center gap-3">
            <button
              className={recording ? "btn-danger" : "btn-primary"}
              onClick={() => void toggleRecording()}
            >
              <Icon name={recording ? "stop" : "mic"} className="h-4 w-4" />
              {recording ? t("voicesStop") : t("voicesRecord")}
            </button>
            {recording && (
              <span className="text-sm tabular-nums text-gray-500">{elapsed.toFixed(0)}s</span>
            )}
            {reference && !recording && (
              <>
                <audio controls src={reference.url} className="h-9 max-w-52" />
                <span
                  className={`text-xs ${reference.seconds < MIN_REFERENCE_SECONDS ? "text-amber-600" : "text-gray-500"}`}
                >
                  {reference.seconds.toFixed(1)}s
                  {reference.seconds < MIN_REFERENCE_SECONDS && ` — ${t("voicesTooShort")}`}
                </span>
              </>
            )}
          </div>

          <label className="label mt-5" htmlFor="voice-name">{t("voicesName")}</label>
          <input
            id="voice-name"
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="my-voice"
          />

          <label className="label mt-4" htmlFor="voice-lines">{t("voicesLines")}</label>
          <textarea
            id="voice-lines"
            className="input min-h-28 font-mono text-xs"
            value={lines}
            onChange={(e) => setLines(e.target.value)}
          />
          <p className="mt-1 text-xs text-gray-500">{t("voicesLinesHint")}</p>

          <label className="mt-4 flex items-start gap-2 text-[13px]">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
            />
            {t("voicesConsent")}
          </label>

          <button
            className="btn-primary mt-4"
            disabled={!canSubmit}
            onClick={() => submit.mutate()}
          >
            {submit.isPending ? <Spinner className="h-4 w-4" /> : <Icon name="plus" className="h-4 w-4" />}
            {t("voicesSubmit")}
          </button>
          {error && <p className="field-error mt-2">{error}</p>}
        </section>

        {/* ------------------------------------------------ jobs & voices */}
        <div className="flex flex-col gap-6">
          {waiting && !renderCap?.available && (
            <div className="card border-amber-300/60 dark:border-amber-500/30">
              <p className="text-[13px] text-amber-700 dark:text-amber-400">
                {t("voicesWorkerHint")}
              </p>
              <pre className="mt-2 overflow-x-auto rounded-lg bg-gray-900 p-3 text-[11px] text-gray-100">
{`python -m scripts.clone_worker \\
  --api ${window.location.origin}/api \\
  --email you@example.com \\
  --org ${orgId}`}
              </pre>
            </div>
          )}

          {jobs.length > 0 && (
            <section className="card">
              <h2 className="mb-3 font-medium">{t("voicesJobs")}</h2>
              <div className="flex flex-col gap-3">
                {jobs.map((job) => (
                  <div key={job.id} className="rounded-lg border border-gray-200 p-3 dark:border-line">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">{job.name}</span>
                      <div className="flex items-center gap-2">
                        {renderCap?.available &&
                          (job.status === "pending" || job.status === "failed") && (
                          <button
                            className="btn-primary px-3 py-1 text-xs"
                            onClick={() => void renderHere(job.id)}
                          >
                            {t("voicesRenderHere")}
                          </button>
                        )}
                        <JobStatus job={job} />
                        <button
                          className="text-gray-400 hover:text-red-600"
                          aria-label={t("delete")}
                          onClick={() => void removeJob(job.id)}
                        >
                          <Icon name="trash" className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                    {job.status === "processing" && (
                      <div className="mt-2 h-1.5 overflow-hidden rounded bg-gray-200 dark:bg-gray-700">
                        <div
                          className="h-full bg-brand-600 transition-all"
                          style={{ width: `${(job.done_lines / job.lines.length) * 100}%` }}
                        />
                      </div>
                    )}
                    {job.error && <p className="field-error mt-2">{job.error}</p>}
                    {job.status === "done" && (
                      <ul className="mt-2 flex flex-col gap-1">
                        {job.lines.map((line) => {
                          const voiceId = `${orgId}:${job.name}`;
                          const key = `${voiceId}:${line}`;
                          return (
                            <li key={line} className="flex items-center gap-2 text-[13px]">
                              <button
                                className="btn-secondary px-2 py-1"
                                onClick={() => void play(voiceId, line)}
                                disabled={playing === key}
                                aria-label={t("speak")}
                              >
                                {playing === key
                                  ? <Spinner className="h-3.5 w-3.5" />
                                  : <Icon name="speaker" className="h-3.5 w-3.5" />}
                              </button>
                              <span className="truncate">{line}</span>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}

          {voices.length > 0 && (
            <section className="card">
              <h2 className="mb-3 font-medium">{t("voicesYours")}</h2>
              <div className="flex flex-col gap-2">
                {voices.map((voice) => (
                  <div key={voice.voice} className="flex items-center justify-between gap-2 text-sm">
                    <span className="font-medium">{voice.label}</span>
                    <span className="text-xs text-gray-500">
                      {t("voicesStats", {
                        lines: voice.lines,
                        seconds: Math.round(voice.total_ms / 1000),
                      })}
                    </span>
                    <button
                      className="text-gray-400 hover:text-red-600"
                      aria-label={t("delete")}
                      onClick={() => void removeVoice(voice.label)}
                    >
                      <Icon name="trash" className="h-4 w-4" />
                    </button>
                  </div>
                ))}
              </div>
              <p className="mt-3 text-xs text-gray-500">{t("voicesUseHint")}</p>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

function JobStatus({ job }: { job: CloneJob }) {
  const { t } = useTranslation();
  const palette: Record<CloneJob["status"], string> = {
    pending: "bg-gray-500/10 text-gray-600 dark:text-gray-300",
    processing: "bg-brand-600/10 text-brand-700 dark:text-brand-400",
    done: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
    failed: "bg-red-500/10 text-red-700 dark:text-red-400",
  };
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${palette[job.status]}`}>
      {t(`voicesStatus_${job.status}`)}
      {job.status === "processing" && ` ${job.done_lines}/${job.lines.length}`}
    </span>
  );
}
