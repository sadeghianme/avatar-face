import type { SpeechPlayer } from "@liveface/embed";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams } from "react-router-dom";

import { CropStudio } from "../components/CropStudio";
import { Icon } from "../components/Icon";
import { MarkFacePanel } from "../components/MarkFacePanel";
import { Avatar3DPreview } from "../components/Avatar3DPreview";
import { AvatarPreview } from "../components/AvatarPreview";
import { EmbedSnippet } from "../components/EmbedSnippet";
import { PrepProgress } from "../components/PrepProgress";
import { SpeakPanel } from "../components/SpeakPanel";
import { defaultVoiceSelection, type VoiceSelection } from "../components/VoicePicker";
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
  const [adjusting, setAdjusting] = useState(false);
  const [cropping, setCropping] = useState(false);
  // Owned here so the embed snippet reproduces the voice that was just
  // tested — otherwise the copied snippet speaks en-US whatever was picked.
  const [voice, setVoice] = useState<VoiceSelection>(defaultVoiceSelection);
  const [busyBg, setBusyBg] = useState(false);

  // Native fullscreen on the preview card. The `fullscreen` state exists so
  // the toggle icon flips even when the user leaves with Esc, which never
  // passes through our button.
  const previewBoxRef = useRef<HTMLDivElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    const onChange = () =>
      setFullscreen(document.fullscreenElement === previewBoxRef.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);
  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void previewBoxRef.current?.requestFullscreen();
  };

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

  // Framing is a property of the avatar, not a local view preference: it is
  // what embedding sites render, so switching it here changes what visitors
  // to those sites see.
  const fullPhoto = avatar.framing === "full";
  const setFraming = async (framing: "face" | "full") => {
    await api.patch(`/orgs/${current!.id}/avatars/${avatar!.id}`, { framing });
    await queryClient.invalidateQueries({ queryKey: ["avatar", current!.id, avatar!.id] });
  };

  /** Cut the subject out, or put the original photo back. */
  const toggleBackground = async () => {
    setBusyBg(true);
    try {
      await api.post(`/orgs/${current!.id}/avatars/${avatar!.id}/background`, {
        remove: !avatar!.original_image_key,
      });
      // A fresh detail fetch re-signs the image URL, so the preview reloads
      // with the new texture rather than the cached one.
      await queryClient.invalidateQueries({ queryKey: ["avatar", current!.id, avatar!.id] });
    } finally {
      setBusyBg(false);
    }
  };

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

  /** Step back one edit — crop, background, whatever it was. */
  const undo = async () => {
    await api.post(`/orgs/${current!.id}/avatars/${avatar!.id}/undo`);
    await queryClient.invalidateQueries({ queryKey: ["avatar", current!.id, avatar!.id] });
    await queryClient.invalidateQueries({ queryKey: ["avatars", current!.id] });
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
          {/* Back before the title, not buried in the sidebar: a detail page
              reached from a list needs a way out of it that is where the eye
              already is. */}
          <Link
            to="/app"
            aria-label={t("avatars")}
            title={t("avatars")}
            className="-ms-1 rounded-lg p-1.5 text-gray-500 transition-colors hover:bg-black/5 hover:text-gray-900 dark:hover:bg-white/10 dark:hover:text-white"
          >
            <Icon name="back" className="h-5 w-5" />
          </Link>
          <h1 className="text-2xl font-semibold">{avatar.name}</h1>
          <StatusBadge status={avatar.status} />
        </div>
        <div className="flex gap-2">
          {avatar.kind === "photo" && (
          <div className="flex overflow-hidden rounded-lg border border-gray-300 dark:border-line">
            <button
              className={`px-3 py-2 text-sm font-medium ${!fullPhoto ? "bg-brand-600 text-white" : "bg-white text-gray-600 dark:bg-panel dark:text-gray-300"}`}
              onClick={() => void setFraming("face")}
            >
              {t("viewFace")}
            </button>
            <button
              className={`px-3 py-2 text-sm font-medium ${fullPhoto ? "bg-brand-600 text-white" : "bg-white text-gray-600 dark:bg-panel dark:text-gray-300"}`}
              onClick={() => void setFraming("full")}
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
                <Icon name="target" className="me-1.5 inline h-4 w-4" />
                {t("markFace")}
              </button>
              <button className="btn-secondary" onClick={() => setCropping((c) => !c)}>
                <Icon name="crop" className="me-1.5 inline h-4 w-4" />
                {t("crop")}
              </button>
              <button
                className="btn-secondary"
                onClick={() => void toggleBackground()}
                disabled={busyBg}
                title={t("removeBgHint")}
              >
                <Icon name="eraser" className="me-1.5 inline h-4 w-4" />
                {busyBg
                  ? t("loading")
                  : avatar.original_image_key
                    ? t("restoreBg")
                    : t("removeBg")}
              </button>
              <Link className="btn-secondary" to={`/simulator?avatar=${avatar.id}`}>
                <Icon name="play" className="me-1.5 inline h-4 w-4" />
                {t("testInSimulator")}
              </Link>
              <button className="btn-secondary" onClick={() => void generate3d()}>
                <Icon name="cube" className="me-1.5 inline h-4 w-4" />
                {t("generate3d")}
              </button>
            </>
          )}
          {avatar.undo_label && (
            <button
              className="btn-secondary"
              onClick={() => void undo()}
              title={t("undoWhat", { what: avatar.undo_label })}
            >
              <Icon name="undo" className="me-1.5 inline h-4 w-4" />
              {t("undoWhat", { what: avatar.undo_label })}
            </button>
          )}
          <button className="btn-danger" onClick={() => void remove()}>
            {t("delete")}
          </button>
        </div>
      </div>

      {avatar.quality_note && avatar.status === "ready" && (
        <div className="card mb-6 border-amber-300/60 dark:border-amber-500/30">
          <p className="text-[13.5px] text-amber-700 dark:text-amber-400">
            <span className="font-medium">{t("qualityNoteTitle")}</span> {avatar.quality_note}
          </p>
          <p className="mt-1 text-[13px] text-gray-500 dark:text-gray-400">
            {t("qualityNoteHint")}
          </p>
          {avatar.kind === "photo" && !adjusting && (
            <button
              className="btn-secondary mt-3 px-3 py-1.5 text-xs"
              onClick={() => setAdjusting(true)}
            >
              <Icon name="target" className="h-4 w-4" />
              {t("markFace")}
            </button>
          )}
        </div>
      )}

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
          <div
            ref={previewBoxRef}
            className={`card relative ${fullscreen ? "preview-fullscreen" : ""}`}
          >
            {!cropping && (
              <button
                type="button"
                onClick={toggleFullscreen}
                aria-label={t(fullscreen ? "exitFullscreen" : "fullscreen")}
                title={t(fullscreen ? "exitFullscreen" : "fullscreen")}
                className="absolute end-3 top-3 z-10 rounded-lg bg-black/40 p-2 text-white/90 backdrop-blur transition-colors hover:bg-black/60 hover:text-white"
              >
                <Icon name={fullscreen ? "compress" : "expand"} className="h-4 w-4" />
              </button>
            )}
            {cropping ? (
              <CropStudio
                avatar={avatar}
                orgId={current.id}
                onCancel={() => setCropping(false)}
                onDone={() => {
                  setCropping(false);
                  void queryClient.invalidateQueries({
                    queryKey: ["avatar", current.id, avatar.id],
                  });
                }}
              />
            ) : avatar.kind === "model3d" && avatar.model_url ? (
              <Avatar3DPreview modelUrl={avatar.model_url} onEngine={setEngine} />
            ) : (
              <AvatarPreview
                rigUrl={avatar.rig_url}
                // Full-resolution texture: the 256px thumbnail looks blurry
                // on a large preview canvas.
                textureUrl={avatar.image_url ?? avatar.thumbnail_url}
                layerUrls={avatar.layer_urls}
                debugMesh={debugMesh}
                fullPhoto={fullPhoto}
                onEngine={setEngine}
              />
            )}
          </div>
          <div className="flex flex-col gap-6">
            <SpeakPanel
              engine={engine}
              orgId={current.id}
              selection={voice}
              onSelectionChange={setVoice}
            />
            <TuningPanel
              engine={engine}
              avatarId={avatar.id}
              is3d={avatar.kind === "model3d"}
            />
            <EmbedSnippet avatarId={avatar.id} voice={voice} />
          </div>
        </div>
      )}
    </div>
  );
}
