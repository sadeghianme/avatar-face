import type { SpeechPlayer } from "@liveface/embed";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router-dom";

import { MarkFacePanel } from "../components/MarkFacePanel";
import { Avatar3DPreview } from "../components/Avatar3DPreview";
import { AvatarPreview } from "../components/AvatarPreview";
import { EmbedSnippet } from "../components/EmbedSnippet";
import { PrepProgress } from "../components/PrepProgress";
import { SpeakPanel } from "../components/SpeakPanel";
import { StatusBadge } from "../components/StatusBadge";
import { TuningPanel } from "../components/TuningPanel";
import { api } from "../lib/api";
import { useOrg } from "../lib/org";
import type { Avatar } from "../lib/types";

export function AvatarDetailPage() {
  const { t } = useTranslation();
  const { avatarId } = useParams<{ avatarId: string }>();
  const { current } = useOrg();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [engine, setEngine] = useState<SpeechPlayer | null>(null);
  const [debugMesh, setDebugMesh] = useState(false);
  const [fullPhoto, setFullPhoto] = useState(false);
  const [adjusting, setAdjusting] = useState(false);

  const { data: avatar, isError } = useQuery({
    queryKey: ["avatar", current?.id, avatarId],
    queryFn: () => api.get<Avatar>(`/orgs/${current!.id}/avatars/${avatarId}`),
    enabled: Boolean(current && avatarId),
    // Live status polling while the rig pipeline runs.
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "pending" || status === "processing" ? 1500 : false;
    },
  });

  if (isError) {
    return <p className="field-error">{t("error")} — avatar not found in this organization.</p>;
  }
  if (!avatar || !current) {
    return <p className="text-gray-500">{t("loading")}</p>;
  }

  const generate3d = async () => {
    const created = await api.post<Avatar>(
      `/orgs/${current.id}/avatars/${avatar.id}/generate-3d`
    );
    await queryClient.invalidateQueries({ queryKey: ["avatars", current.id] });
    navigate(`/avatars/${created.id}`);
  };

  const retry = async () => {
    await api.post(`/orgs/${current.id}/avatars/${avatar.id}/retry`);
    await queryClient.invalidateQueries({ queryKey: ["avatar", current.id, avatarId] });
  };

  const remove = async () => {
    await api.delete(`/orgs/${current.id}/avatars/${avatar.id}`);
    await queryClient.invalidateQueries({ queryKey: ["avatars", current.id] });
    navigate("/app");
  };

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold">{avatar.name}</h1>
          <StatusBadge status={avatar.status} />
        </div>
        <div className="flex gap-2">
          {avatar.kind === "photo" && (
          <div className="flex overflow-hidden rounded-lg border border-gray-300 dark:border-line">
            <button
              className={`px-3 py-2 text-sm font-medium ${!fullPhoto ? "bg-brand-600 text-white" : "bg-white text-gray-600 dark:bg-panel dark:text-gray-300"}`}
              onClick={() => setFullPhoto(false)}
            >
              {t("viewFace")}
            </button>
            <button
              className={`px-3 py-2 text-sm font-medium ${fullPhoto ? "bg-brand-600 text-white" : "bg-white text-gray-600 dark:bg-panel dark:text-gray-300"}`}
              onClick={() => setFullPhoto(true)}
            >
              {t("viewFull")}
            </button>
          </div>
          )}
          {avatar.kind === "photo" && (
          <label className="btn-secondary cursor-pointer select-none">
            <input
              type="checkbox"
              className="me-1"
              checked={debugMesh}
              onChange={(e) => setDebugMesh(e.target.checked)}
            />
            mesh
          </label>
          )}
          {avatar.kind === "photo" && avatar.status === "ready" && (
            <>
              <button className="btn-secondary" onClick={() => setAdjusting((a) => !a)}>
                🎯 {t("markFace")}
              </button>
              <button className="btn-secondary" onClick={() => void generate3d()}>
                ✨ {t("generate3d")}
              </button>
            </>
          )}
          <button className="btn-danger" onClick={() => void remove()}>
            {t("delete")}
          </button>
        </div>
      </div>

      {avatar.status === "failed" && (
        <div className="card mb-6 border-red-200 dark:border-red-900">
          <p className="field-error">{avatar.error}</p>
          <button className="btn-secondary mt-3" onClick={() => void retry()}>
            {t("retry")}
          </button>
        </div>
      )}

      {(avatar.status === "pending" || avatar.status === "processing") && (
        <div className="mb-6">
          <PrepProgress avatar={avatar} onRetry={() => void retry()} />
        </div>
      )}

      {adjusting && avatar.status === "ready" && (
        <div className="mb-6">
          <MarkFacePanel avatar={avatar} orgId={current.id} onClose={() => setAdjusting(false)} />
        </div>
      )}

      {avatar.status === "ready" && avatar.rig_url && avatar.thumbnail_url && (
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="card">
            {avatar.kind === "model3d" && avatar.model_url ? (
              <Avatar3DPreview modelUrl={avatar.model_url} onEngine={setEngine} />
            ) : (
              <AvatarPreview
                rigUrl={avatar.rig_url}
                // Full-resolution texture: the 256px thumbnail looks blurry
                // on a large preview canvas.
                textureUrl={avatar.image_url ?? avatar.thumbnail_url}
                debugMesh={debugMesh}
                fullPhoto={fullPhoto}
                onEngine={setEngine}
              />
            )}
          </div>
          <div className="flex flex-col gap-6">
            <SpeakPanel engine={engine} orgId={current.id} />
            <TuningPanel
              engine={engine}
              avatarId={avatar.id}
              is3d={avatar.kind === "model3d"}
            />
            <EmbedSnippet avatarId={avatar.id} />
          </div>
        </div>
      )}
    </div>
  );
}
