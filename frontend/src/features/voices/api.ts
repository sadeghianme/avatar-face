import { BrowserTTS } from "@liveface/embed";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { api, fetchStream } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import type { Provider, Schemas, Synthesis, Voice } from "@/lib/types";

/** The voice choices' provider names (the server's, the browser's, an org's clones). */
export const BROWSER_PROVIDER = "browser";
export const SERVER_PROVIDER = "kokoro";
export const CLONED_PROVIDER = "cloned";

/** A language the server can speak, resolved to its best provider and voice
 * (GET /tts/languages answers dicts: typed here). */
export interface SpeechLanguage {
  locale: string;
  name: string;
  native_name: string;
  sample: string;
  provider: string;
  voice: string;
}

/** A clone job (the clone-jobs routes answer dicts: typed here). */
export interface CloneJob {
  id: string;
  name: string;
  locale: string;
  lines: string[];
  status: "pending" | "processing" | "done" | "failed";
  error: string | null;
  done_lines: number;
}

/** A voice cloned for this organization: rows of its speech cache. */
export type ClonedVoice = Schemas["ClonedVoiceOut"];

// --- Speech -------------------------------------------------------------------------

export function useSpeechLanguages() {
  return useQuery({
    queryKey: queryKeys.ttsLanguages(),
    queryFn: () => api.get<SpeechLanguage[]>("/tts/languages"),
  });
}

/** The server's providers, the browser's own voices first when it has them. */
export function useSpeechProviders() {
  return useQuery({
    queryKey: queryKeys.ttsProviders(),
    queryFn: async () => {
      const server = await api.get<Provider[]>("/tts/providers");
      return BrowserTTS.supported()
        ? [{ name: BROWSER_PROVIDER, display_name: "Browser voice (free)" }, ...server]
        : server;
    },
  });
}

/**
 * One provider's voices: an org's clones from their list, the browser's
 * from speechSynthesis, the rest from the server. Keyed by the clones'
 * count, so a new clone shows.
 */
export function useProviderVoices(provider: string, cloned: readonly ClonedVoice[]) {
  return useQuery({
    queryKey: queryKeys.ttsVoices(provider, cloned.length),
    queryFn: async (): Promise<Voice[]> => {
      if (provider === CLONED_PROVIDER) {
        return cloned.map((c) => ({ id: c.voice, name: c.label, locale: c.locale || "en-US", gender: "neutral" }));
      }
      if (provider === BROWSER_PROVIDER) {
        const list = await BrowserTTS.voices();
        return list.map((v) => ({ id: v.voiceURI, name: v.name, locale: v.lang, gender: "neutral" }));
      }
      return api.get<Voice[]>(`/tts/providers/${provider}/voices`);
    },
    enabled: Boolean(provider),
  });
}

/** Words as they are spoken: the phrase stream the engine plays (streamSpeech). */
export function speechStream(orgId: string, body: Schemas["SynthesizeRequest"]): Promise<Response> {
  return fetchStream(`/tts/orgs/${orgId}/stream`, body);
}

/** One line in a voice, whole (a cloned voice's rendered line: a cache hit). */
export function synthesize(orgId: string, body: Schemas["SynthesizeRequest"]): Promise<Synthesis> {
  return api.post<Synthesis>(`/tts/orgs/${orgId}/synthesize`, body);
}

// --- Cloned voices --------------------------------------------------------------------

export function useClonedVoices(orgId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.clonedVoices(orgId),
    queryFn: () => api.get<ClonedVoice[]>(`/orgs/${orgId}/cloned-voices`),
    enabled: Boolean(orgId),
  });
}

/**
 * The organization's clone jobs, polled every 2s while one renders. A job
 * that finishes adds a voice: the voices list is fetched again then.
 */
export function useCloneJobs(orgId: string | undefined) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: queryKeys.cloneJobs(orgId),
    queryFn: () => api.get<CloneJob[]>(`/orgs/${orgId}/clone-jobs`),
    enabled: Boolean(orgId),
    refetchInterval: (q) =>
      q.state.data?.some((j) => j.status === "pending" || j.status === "processing") ? 2000 : false,
  });
  const doneCount = (query.data ?? []).filter((j) => j.status === "done").length;
  useEffect(() => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.clonedVoices(orgId) });
  }, [doneCount, orgId, queryClient]);
  return query;
}

/** Whether this backend can render a clone on its own hardware (fixed until a restart). */
export function useRenderCapability(orgId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.renderCapability(orgId),
    queryFn: () =>
      api.get<{ available: boolean; reason: string | null }>(`/orgs/${orgId}/clone-jobs/render-capability`),
    enabled: Boolean(orgId),
    staleTime: Infinity,
  });
}

function useCloneJobsMutation<T>(orgId: string | undefined, request: (input: T) => Promise<unknown>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: request,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.cloneJobs(orgId) }),
  });
}

/** Queue a clone: the recorded reference, its name, the lines, the consent. */
export const useSubmitClone = (orgId: string | undefined) =>
  useCloneJobsMutation(orgId, (form: FormData) => api.postForm<CloneJob>(`/orgs/${orgId}/clone-jobs`, form));

/** Render a queued clone here, on this backend's hardware. */
export const useRenderHere = (orgId: string | undefined) =>
  useCloneJobsMutation(orgId, (jobId: string) => api.post(`/orgs/${orgId}/clone-jobs/${jobId}/render`, {}));

export const useRemoveCloneJob = (orgId: string | undefined) =>
  useCloneJobsMutation(orgId, (jobId: string) => api.delete(`/orgs/${orgId}/clone-jobs/${jobId}`));

export function useRemoveClonedVoice(orgId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (label: string) => api.delete(`/orgs/${orgId}/cloned-voices/${label}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.clonedVoices(orgId) }),
  });
}
