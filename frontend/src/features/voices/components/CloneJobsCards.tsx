import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import { CodeBlock } from "@/components/ui/CodeBlock";
import { FieldError } from "@/components/ui/FieldError";
import { IconButton } from "@/components/ui/IconButton";
import { ProgressBar } from "@/components/ui/ProgressBar";
import type { CloneJob } from "@/features/voices/api";
import type { VoicesPageState } from "@/features/voices/hooks/useVoicesPage";
import { useT } from "@/i18n";

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

/**
 * The clone jobs: while one waits and this server cannot render, the render
 * worker's command to run on the machine that can; then each job with its
 * state, its progress, its error, and once done its lines to play.
 */
export function CloneJobsCards({ page }: { page: VoicesPageState }) {
  const { t } = useT();
  return (
    <>
      {page.waiting && !page.canRenderHere && (
        <Card tone="warning">
          <p className="text-[13px] text-amber-700 max-lg:text-sm dark:text-amber-400">{t("voicesWorkerHint")}</p>
          <CodeBlock
            className="mt-2"
            preClassName="text-[11px] text-gray-100"
            copy={{ label: t("copy"), copiedLabel: t("copied") }}
            code={`python -m scripts.clone_worker \\
  --api ${window.location.origin}/api \\
  --email you@example.com \\
  --org ${page.orgId}`}
          />
        </Card>
      )}

      {page.jobs.length > 0 && (
        <Card as="section">
          <CardHeader className="mb-3" title={t("voicesJobs")} />
          <div className="flex flex-col gap-3">
            {page.jobs.map((job) => (
              <div key={job.id} className="rounded-lg border border-gray-200 p-3 dark:border-line">
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate font-medium">{job.name}</span>
                  <div className="flex items-center gap-2">
                    {page.canRenderHere && (job.status === "pending" || job.status === "failed") && (
                      <Button size="xs" onClick={() => page.renderHere(job.id)}>
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
                      onClick={() => page.removeJob(job.id)}
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
                      const voiceId = `${page.orgId}:${job.name}`;
                      return (
                        <li key={line} className="flex items-center gap-2 text-[13px] max-lg:text-sm">
                          <Button
                            variant="secondary"
                            className="px-2 py-1 coarse:min-w-11"
                            icon="speaker"
                            iconClassName="h-3.5 w-3.5"
                            loading={page.playing === `${voiceId}:${line}`}
                            onClick={() => page.play(voiceId, line)}
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

      {page.voices.length > 0 && (
        <Card as="section">
          <CardHeader className="mb-3" title={t("voicesYours")} />
          <div className="flex flex-col gap-2">
            {page.voices.map((voice) => (
              <div key={voice.voice} className="flex items-center justify-between gap-2 text-sm">
                <span className="min-w-0 truncate font-medium">{voice.label}</span>
                <span className="text-xs text-gray-500">
                  {t("voicesStats", { lines: voice.lines, seconds: Math.round(voice.total_ms / 1000) })}
                </span>
                <IconButton
                  variant="danger"
                  label={t("delete")}
                  icon="trash"
                  iconClassName="h-4 w-4"
                  className="coarse:-me-2"
                  onClick={() => page.removeVoice(voice.label)}
                />
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs text-gray-500">{t("voicesUseHint")}</p>
        </Card>
      )}
    </>
  );
}
