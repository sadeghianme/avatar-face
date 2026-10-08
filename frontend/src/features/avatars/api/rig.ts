import { useMutation, useQuery } from "@tanstack/react-query";

import { useAvatarCache } from "@/features/avatars/api/avatars";
import type { FaceMarks, FitReason } from "@/features/avatars/face-marks";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import type { Avatar, Refine, Schemas } from "@/lib/types";

/** Where the fit put the face's points, and the picture they are on. */
/** GET …/rig-anchors answers a dict (no response model yet): typed here. */
export interface AnchorsResponse {
  anchors: FaceMarks;
  image_size: [number, number];
}

export type FitResponse = Refine<Schemas["RigFitResult"], { reasons: FitReason[] }>;

const rigPath = (orgId: string, avatarId: string) => `/orgs/${orgId}/avatars/${avatarId}`;

/**
 * The points the face panel opens with. Keyed by the rig too, and never
 * stale: a re-marked rig has new ones.
 */
export function useRigAnchors(orgId: string, avatar: Pick<Avatar, "id" | "rig_url">) {
  return useQuery({
    queryKey: queryKeys.rigAnchors(avatar.id, avatar.rig_url),
    queryFn: () => api.get<AnchorsResponse>(`${rigPath(orgId, avatar.id)}/rig-anchors`),
    enabled: Boolean(avatar.rig_url),
    staleTime: 0,
  });
}

/** The rig these marks would make, fitted and NOT saved (the live preview). */
export function previewRigFit(orgId: string, avatarId: string, marks: FaceMarks): Promise<FitResponse> {
  return api.post<FitResponse>(`${rigPath(orgId, avatarId)}/rig-fit`, { ...marks, persist: false });
}

/** Save the marks: the rig is fitted again and the avatar fetched again. */
export function useSaveRigFit(orgId: string, avatarId: string) {
  const cache = useAvatarCache(orgId, avatarId);
  return useMutation({
    mutationFn: (marks: FaceMarks) =>
      api.post<FitResponse>(`${rigPath(orgId, avatarId)}/rig-fit`, { ...marks, persist: true }),
    onSuccess: () => cache.refresh({ list: false }),
  });
}

/** Throw the marking away and detect the face again from the original photo. */
export function useResetRig(orgId: string, avatarId: string) {
  const cache = useAvatarCache(orgId, avatarId);
  return useMutation({
    mutationFn: () => api.post(`${rigPath(orgId, avatarId)}/rig-reset`, {}),
    onSuccess: () => cache.refresh({ list: false }),
  });
}
