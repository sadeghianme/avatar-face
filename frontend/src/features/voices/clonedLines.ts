/**
 * What a cloned voice can say. It plays only the lines rendered in it
 * (backend services/tts/cloned.py): the exact words, in the locale they
 * were rendered in. The speech cache keeps no text, so the lines are the
 * clone jobs' — every line of a finished job, the ones done so far of a job
 * still rendering (or stopped by a failure). Framework-free, so `npm test`
 * checks it.
 */
import type { CloneJob } from "@/features/voices/api";

/** The name of a cloned voice's id ("org:Name"): what its jobs are named. */
export function clonedVoiceName(voiceId: string): string {
  return voiceId.slice(voiceId.indexOf(":") + 1);
}

/** The lines `name` can say in `locale`, newest job first, each once. */
export function renderedLines(jobs: readonly CloneJob[], name: string, locale: string): string[] {
  const lines = jobs
    .filter((job) => job.name === name && job.locale === locale)
    .flatMap((job) => (job.status === "done" ? job.lines : job.lines.slice(0, job.done_lines)));
  return [...new Set(lines)];
}

/**
 * A line the Speak panel sends to the Voices page to be rendered (its
 * "Add it on the Voices page"), as router state: the voice's name and the
 * line, filled into the clone form there. A reference recorded and queued
 * under the same name adds the line to the voice.
 */
export interface RenderLineRequest {
  voice: string;
  line: string;
}

/** The request in a page's router state, or null for anything else. */
export function renderLineRequest(state: unknown): RenderLineRequest | null {
  if (!state || typeof state !== "object") return null;
  const { voice, line } = state as Record<string, unknown>;
  return typeof voice === "string" && typeof line === "string" && line.trim() ? { voice, line: line.trim() } : null;
}
