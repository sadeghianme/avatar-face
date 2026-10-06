import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import type { Avatar } from "@/lib/types";

/** Still being built: the rig pipeline is running. */
const building = (status: string | undefined) => status === "pending" || status === "processing";

const avatarPath = (orgId: string, avatarId: string) => `/orgs/${orgId}/avatars/${avatarId}`;

/**
 * The organization's avatars. `poll`: every 2s while one of them is being
 * built (the library, where a card turns ready on its own).
 */
export function useAvatars(orgId: string | undefined, { poll = false }: { poll?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.avatars(orgId),
    queryFn: () => api.get<Avatar[]>(`/orgs/${orgId}/avatars`),
    enabled: Boolean(orgId),
    refetchInterval: poll ? (query) => (query.state.data?.some((a) => building(a.status)) ? 2000 : false) : undefined,
  });
}

/**
 * One avatar, with its signed asset URLs (the list has none). `poll`:
 * every 1.5s while it is being built (its own page).
 */
export function useAvatar(
  orgId: string | undefined,
  avatarId: string | undefined,
  { poll = false, enabled = true, staleTime }: { poll?: boolean; enabled?: boolean; staleTime?: number } = {}
) {
  return useQuery({
    queryKey: queryKeys.avatar(orgId, avatarId),
    queryFn: () => api.get<Avatar>(`/orgs/${orgId}/avatars/${avatarId}`),
    enabled: Boolean(orgId && avatarId) && enabled,
    staleTime,
    refetchInterval: poll ? (query) => (building(query.state.data?.status) ? 1500 : false) : undefined,
  });
}

/**
 * What a change to an avatar refreshes, decided here and nowhere else.
 *
 * - `refresh`: the detail fetched again, and the list (name, status,
 *   thumbnail, live) unless `list: false`. A fetch re-signs every asset
 *   URL, and the preview rebuilds on new URLs: right after a change to a
 *   picture or the rig (re-marking rewrites rig.json under the same key).
 * - `merge`: the server's answer taken as the detail, with no fetch, and
 *   the list refetched. For a setting that touched no asset: a refetch
 *   would restart the face mid-sentence on every slider release.
 */
export function useAvatarCache(orgId: string, avatarId: string) {
  const queryClient = useQueryClient();
  return useMemo(
    () => ({
      refresh: async ({ list = true }: { list?: boolean } = {}) => {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: queryKeys.avatar(orgId, avatarId) }),
          list && queryClient.invalidateQueries({ queryKey: queryKeys.avatars(orgId) }),
        ]);
      },
      merge: (updated: Avatar) => {
        queryClient.setQueryData<Avatar>(queryKeys.avatar(orgId, avatarId), (old) =>
          old ? { ...old, ...updated } : old
        );
        void queryClient.invalidateQueries({ queryKey: queryKeys.avatars(orgId) });
      },
    }),
    [queryClient, orgId, avatarId]
  );
}

/** The draft settings a PATCH takes (each panel sends its own). */
export type AvatarPatch = Partial<Pick<Avatar, "name" | "voice">> & {
  mouth?: unknown;
  scene?: unknown;
  character?: unknown;
};

/**
 * A draft edit. By default the answer is merged (a setting); `refetch`
 * when the edit moved an asset or changed what the list shows: "all"
 * (the name, a character look on the rig), "detail" (the voice: the
 * Publish bar appears).
 */
export function useUpdateAvatar(orgId: string, avatarId: string) {
  const cache = useAvatarCache(orgId, avatarId);
  return useMutation({
    mutationFn: ({ body }: { body: AvatarPatch; refetch?: "all" | "detail" }) =>
      api.patch<Avatar>(avatarPath(orgId, avatarId), body),
    onSuccess: (updated, { refetch }) => (refetch ? cache.refresh({ list: refetch === "all" }) : cache.merge(updated)),
  });
}

/**
 * A one-shot action on the avatar, then its detail fetched again, and the
 * list when the list shows what changed. `settled`: refetched after a
 * refusal too (a retry the server turned down still moved the status).
 */
function useAvatarAction<TInput = void>(
  orgId: string,
  avatarId: string,
  request: (input: TInput) => Promise<unknown>,
  { list, settled = false }: { list: boolean; settled?: boolean }
) {
  const cache = useAvatarCache(orgId, avatarId);
  const refresh = () => cache.refresh({ list });
  return useMutation({
    mutationFn: request,
    onSuccess: settled ? undefined : refresh,
    onSettled: settled ? refresh : undefined,
  });
}

/** Publish the draft: what embeds and share links serve from now on. */
export const usePublishAvatar = (orgId: string, avatarId: string) =>
  useAvatarAction(orgId, avatarId, () => api.post(`${avatarPath(orgId, avatarId)}/publish`, {}), { list: true });

/** Throw the draft away: back to what is published. */
export const useDiscardDraft = (orgId: string, avatarId: string) =>
  useAvatarAction(orgId, avatarId, () => api.post(`${avatarPath(orgId, avatarId)}/discard-draft`, {}), {
    list: true,
  });

/** Step back one edit (a crop, the background, whatever it was). */
export const useUndoAvatarEdit = (orgId: string, avatarId: string) =>
  useAvatarAction(orgId, avatarId, () => api.post(`${avatarPath(orgId, avatarId)}/undo`), { list: true });

/** Cut the subject out (`remove`), or put the original photo back. */
export const useAvatarBackground = (orgId: string, avatarId: string) =>
  useAvatarAction(
    orgId,
    avatarId,
    (remove: boolean) => api.post(`${avatarPath(orgId, avatarId)}/background`, { remove }),
    { list: false }
  );

/** Run the rig job again after it failed. */
export const useRetryAvatar = (orgId: string, avatarId: string) =>
  useAvatarAction(orgId, avatarId, () => api.post(`${avatarPath(orgId, avatarId)}/retry`), {
    list: false,
    settled: true,
  });

/** Crop the picture; the server moves the rig with it. */
export const useCropAvatar = (orgId: string, avatarId: string) =>
  useAvatarAction(
    orgId,
    avatarId,
    (rect: { x: number; y: number; width: number; height: number }) =>
      api.post(`${avatarPath(orgId, avatarId)}/crop`, rect),
    { list: false }
  );

/** The public share link, on or off. */
export const useAvatarSharing = (orgId: string, avatarId: string) =>
  useAvatarAction(
    orgId,
    avatarId,
    (on: boolean) =>
      on ? api.post(`${avatarPath(orgId, avatarId)}/share`, {}) : api.delete(`${avatarPath(orgId, avatarId)}/share`),
    { list: false }
  );

const formWith = (file: File) => {
  const form = new FormData();
  form.append("file", file);
  return form;
};

/** The owner's own teeth photo for the photographic mouth. */
export const useUploadMouthPhoto = (orgId: string, avatarId: string) =>
  useAvatarAction(
    orgId,
    avatarId,
    (file: File) => api.postForm<Avatar>(`${avatarPath(orgId, avatarId)}/mouth-photo`, formWith(file)),
    { list: true }
  );

export const useRemoveMouthPhoto = (orgId: string, avatarId: string) =>
  useAvatarAction(orgId, avatarId, () => api.delete(`${avatarPath(orgId, avatarId)}/mouth-photo`), { list: true });

/** A picture behind a cut-out. */
export const useUploadSceneImage = (orgId: string, avatarId: string) =>
  useAvatarAction(
    orgId,
    avatarId,
    (file: File) => api.postForm<Avatar>(`${avatarPath(orgId, avatarId)}/scene-image`, formWith(file)),
    { list: true }
  );

export const useRemoveSceneImage = (orgId: string, avatarId: string) =>
  useAvatarAction(orgId, avatarId, () => api.delete<Avatar>(`${avatarPath(orgId, avatarId)}/scene-image`), {
    list: true,
  });

/** Delete an avatar for good; the list follows. */
export function useDeleteAvatar(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (avatarId: string) => api.delete(avatarPath(orgId, avatarId)),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.avatars(orgId) }),
  });
}
