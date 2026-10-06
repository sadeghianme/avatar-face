import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api, uploadWithProgress } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import type { Avatar, Schemas, StockAvatar, WithDefaults } from "@/lib/types";

/** The ready-made avatars anyone can start from. */
export function useStockAvatars() {
  return useQuery({
    queryKey: queryKeys.stockAvatars(),
    queryFn: () => api.get<StockAvatar[]>("/stock-avatars"),
  });
}

/** A .glb's MIME type: often empty on the File, and the presigned PUT signs it. */
const GLB = "model/gltf-binary";

/**
 * The ways in that are not the wizard: a stock avatar, a 3D model from a
 * URL (Avaturn's export is one) or a .glb file. Each answers with the new
 * avatar, once the list knows it.
 */
export function useImportAvatar(orgId: string) {
  const queryClient = useQueryClient();
  const onSuccess = () => queryClient.invalidateQueries({ queryKey: queryKeys.avatars(orgId) });
  const fromStock = useMutation({
    mutationFn: ({ stockId, name }: { stockId: string; name: string }) =>
      api.post<Avatar>(`/orgs/${orgId}/avatars/from-stock`, {
        stock_id: stockId,
        name,
      } satisfies Schemas["FromStockRequest"]),
    onSuccess,
  });
  const fromUrl = useMutation({
    mutationFn: ({ url, name }: { url: string; name: string }) =>
      api.post<Avatar>(`/orgs/${orgId}/avatars/from-url`, { url, name } satisfies Schemas["AvatarFromUrl"]),
    onSuccess,
  });
  /** The record first, then the file straight to storage, then "uploaded". */
  const fromFile = useMutation({
    mutationFn: async ({ file, name, onProgress }: { file: File; name: string; onProgress: (f: number) => void }) => {
      const made = await api.post<Schemas["AvatarCreated"]>(`/orgs/${orgId}/avatars`, {
        name,
        content_type: GLB,
      } satisfies WithDefaults<Schemas["AvatarCreate"], "face_type">);
      onProgress(0);
      await uploadWithProgress(made.upload_url, file, onProgress, GLB);
      await api.post(`/orgs/${orgId}/avatars/${made.avatar.id}/uploaded`);
      return made.avatar as Avatar;
    },
    onSuccess,
  });
  return { fromStock, fromUrl, fromFile };
}

/** A session in Avaturn's 3D editor: the URL its iframe opens. */
export function useAvaturnSession(orgId: string) {
  return useMutation({
    mutationFn: async () => (await api.post<{ url: string }>(`/orgs/${orgId}/avatars/avaturn-session`, {})).url,
  });
}
