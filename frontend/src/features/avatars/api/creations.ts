import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import type { Creation, FinishResult, PreviewRig } from "@/features/avatars/creation";
import type { FaceMarks } from "@/features/avatars/face-marks";
import type { PrepareBody } from "@/features/avatars/wizard";
import { api, postFormWithProgress } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";

/**
 * The creation wizard's requests. One creation is read and kept current by
 * useCreation (hooks/useCreation.ts); the requests a step sends answer with
 * the creation, and go through the wizard's runner (useCreationActions),
 * which puts that answer in the cache: so these are plain functions, and
 * the cache work is there and in useCreationCache below.
 */

/** "Continue your avatar": the organization's unfinished creations. */
export function useDrafts(orgId: string) {
  return useQuery({
    queryKey: queryKeys.drafts(orgId),
    queryFn: () => api.get<Creation[]>(`/orgs/${orgId}/creations?status=draft`),
    staleTime: 10_000,
  });
}

/** Delete a creation; the drafts list follows, refused or not. */
export function useDeleteCreation(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (creationId: string) => api.delete(`/orgs/${orgId}/creations/${creationId}`),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.drafts(orgId) }),
  });
}

/** Step 2 starts one: from a photo (its upload's progress told), or from words. */
export const startCreation = {
  upload: (orgId: string, form: FormData, onProgress: (fraction: number) => void) =>
    postFormWithProgress<Creation>(`/orgs/${orgId}/creations`, form, onProgress),
  generate: (
    orgId: string,
    body: { model: string; look: string; prompt: string; consent_id?: string }
  ): Promise<Creation> => api.post<Creation>(`/orgs/${orgId}/creations/generate`, body),
};

/** The requests on one creation, steps 3 to 5. */
export function creationRequests(orgId: string, creationId: string) {
  const base = `/orgs/${orgId}/creations/${creationId}`;
  const withConsent = (consentId: string | undefined) => (consentId ? { consent_id: consentId } : {});
  return {
    prepare: (body: PrepareBody, consentId?: string) =>
      api.post<Creation>(`${base}/prepare`, { ...body, ...withConsent(consentId) }),
    /** The failed job again. */
    retry: (consentId?: string) => api.post<Creation>(`${base}/retry`, withConsent(consentId)),
    /** Back to an earlier picture. */
    version: (versionId: string) => api.post<Creation>(`${base}/version`, { version: versionId }),
    /** The rig the finish would build, fitted and not saved. */
    previewRig: (body: { anchors_id: string; marks?: FaceMarks }) => api.post<PreviewRig>(`${base}/preview-rig`, body),
    finish: (body: { name: string; anchors_id: string; consent_id?: string; marks?: unknown }) =>
      api.post<FinishResult>(`${base}/finish`, body),
  };
}

/**
 * The wizard's moves that the cache must follow: a creation made (it is
 * known at once, and the drafts list has it), and one finished (its avatar
 * is in the list, the draft gone).
 */
export function useCreationCache(orgId: string) {
  const queryClient = useQueryClient();
  return useMemo(
    () => ({
      created: (creation: Creation) => {
        queryClient.setQueryData(queryKeys.creation(orgId, creation.id), creation);
        void queryClient.invalidateQueries({ queryKey: queryKeys.drafts(orgId) });
      },
      finished: () => {
        void queryClient.invalidateQueries({ queryKey: queryKeys.avatars(orgId) });
        void queryClient.invalidateQueries({ queryKey: queryKeys.drafts(orgId) });
      },
    }),
    [queryClient, orgId]
  );
}
