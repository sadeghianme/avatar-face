import type { SpeechPlayer } from "@liveface/embed";
import type { AvatarMouthConfig } from "@liveface/embed/mouth";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams } from "react-router-dom";

import { CropStudio } from "@/features/avatars/components/CropStudio";
import { Icon } from "@/components/ui/Icon";
import { MarkFacePanel } from "@/features/avatars/components/MarkFacePanel";
import { Avatar3DPreview } from "@/features/avatars/components/Avatar3DPreview";
import { AvatarPreview } from "@/features/avatars/components/AvatarPreview";
import { EmbedSnippet } from "@/features/avatars/components/EmbedSnippet";
import { FinishNotice } from "@/features/avatars/components/FinishNotice";
import { PrepProgress } from "@/features/avatars/components/PrepProgress";
import { PublishBar } from "@/features/avatars/components/PublishBar";
import { SharePanel } from "@/features/avatars/components/SharePanel";
import { SpeakPanel } from "@/features/voices";
import { defaultVoiceSelection, type VoiceSelection } from "@/features/voices";
import { Spinner } from "@/components/ui/Spinner";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { MouthPanel } from "@/features/avatars/components/MouthPanel";
import { TuningPanel } from "@/features/avatars/components/TuningPanel";
import { useAvatarMouth } from "@/features/avatars/hooks/useAvatarMouth";
import {
  draftMouthConfig,
  previewMotion,
  savedMouthKey,
  urlIdentity,
  type MotionChoice,
} from "@/features/avatars/mouth-config";
import { aiEditedLabels, aiEditedModels } from "@/features/avatars/teeth";
import { errorText } from "@/features/avatars/creation";
import { api, ApiError } from "@/lib/api";
import { useOrg } from "@/providers/org";
import type { Avatar } from "@/lib/types";

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
  // The avatar's DRAFT voice. Seeded from the saved value once loaded, and
  // every change is written back — voice is a published property like
  // framing now, so picking one shows the Publish bar and publishing makes
  // embeds and share links speak with it.
  const [voice, setVoice] = useState<VoiceSelection>(defaultVoiceSelection);
  const seededFor = useRef<string | null>(null);
  const [busyBg, setBusyBg] = useState(false);
  // The mouth being previewed: the panel's live state while the owner is
  // choosing or dragging, otherwise whatever the draft has saved.
  const [mouthPreview, setMouthPreview] = useState<AvatarMouthConfig | null | undefined>(undefined);
  // Which mouth shapes the preview plays: the avatar's own, or the standard
  // ones to compare them with. The preview only; nothing is saved.
  const [motion, setMotion] = useState<MotionChoice>("own");
  // Why the rig job could not be run again, in words.
  const [retryError, setRetryError] = useState<string | null>(null);

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

  const saveVoice = async (selection: VoiceSelection) => {
    setVoice(selection);
    await api.patch(`/orgs/${current!.id}/avatars/${avatarId}`, {
      voice: {
        provider: selection.provider,
        voice: selection.voice,
        locale: selection.locale,
      },
    });
    // The PATCH bumps the draft revision; refetch so the Publish bar appears.
    await queryClient.invalidateQueries({ queryKey: ["avatar", current!.id, avatarId] });
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

  // Seed once per avatar: reopening the page must show the saved voice, but
  // a refetch mid-edit must not clobber a selection being made.
  useEffect(() => {
    if (avatar?.voice && seededFor.current !== avatar.id) {
      seededFor.current = avatar.id;
      setVoice(avatar.voice as VoiceSelection);
    }
  }, [avatar]);

  // Saved draft mouth unless the panel is previewing something newer. The
  // preview resets whenever the saved copy changes (save, publish, discard).
  // Only human faces get the photographic mouth, and it carries the avatar's
  // own motion: the preview must show what ships (draftMouthConfig).
  const savedMouth = draftMouthConfig(avatar);
  const savedKey = savedMouthKey(avatar);
  useEffect(() => setMouthPreview(undefined), [savedKey]);
  // New shapes (a kit made, rebased or discarded) are heard as they are.
  const motionIdentity = urlIdentity(avatar?.mouth?.motion_url);
  useEffect(() => setMotion("own"), [motionIdentity]);
  useAvatarMouth(
    avatar?.kind === "model3d" ? null : (engine as Parameters<typeof useAvatarMouth>[0]),
    previewMotion(mouthPreview === undefined ? savedMouth : mouthPreview, motion)
  );

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

  const retry = async () => {
    setRetryError(null);
    try {
      await api.post(`/orgs/${current.id}/avatars/${avatar.id}/retry`);
    } catch (err) {
      setRetryError(err instanceof ApiError ? errorText(t, err.code, err.detail, err.retryAfter) : t("error"));
    }
    await queryClient.invalidateQueries({ queryKey: ["avatar", current.id, avatarId] });
  };
  // The wizard's step 5 is building it: followed there, where its stages
  // are, not here, where there is nothing of it yet to retry.
  const preparing = avatar.preparing_creation_id ?? null;

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
        {/* Both rows wrap: on a phone the title's disclosure and the row of
            tools are each wider than the screen, and one that cannot wrap
            widens the whole page under it. */}
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
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
          {/* The same disclosure visitors get with the published avatar:
              what the AI did to the picture, "AI teeth" when it made the
              teeth photo too, "AI mouth shapes" when it made some of them. */}
          {avatar.ai_edited && (
            <span
              className="inline-flex items-center gap-1 rounded-full bg-brand-50 px-2.5 py-0.5 text-xs font-medium text-brand-700 dark:bg-brand-500/10 dark:text-brand-300"
              title={
                aiEditedModels(avatar.ai_edited).length > 0
                  ? t("aiEditedModel", { model: aiEditedModels(avatar.ai_edited).join(", ") })
                  : undefined
              }
            >
              <Icon name="sparkles" className="h-3.5 w-3.5" />
              {aiEditedLabels(avatar.ai_edited).map((key) => t(key)).join(" · ")}
            </span>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
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
            <span className="font-medium">
              {avatar.published ? t("qualityNoteTitle") : t("qualityNoteFirstTitle")}
            </span>{" "}
            {avatar.quality_note}
          </p>
          {/* "It still works" is about a live avatar; before the first
              publish the note itself says what to do. */}
          {avatar.published && (
            <p className="mt-1 text-[13px] text-gray-500 dark:text-gray-400">
              {t("qualityNoteHint")}
            </p>
          )}
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
          {retryError && (
            <p className="field-error mt-2 text-sm" role="alert">
              {retryError}
            </p>
          )}
        </div>
      )}

      {avatar.status === "ready" && <PublishBar avatar={avatar} orgId={current.id} />}

      {/* Keyed by avatar: a notice read for one avatar is not shown on the
          next one this page opens. */}
      {avatar.status === "ready" && (
        <FinishNotice key={avatar.id} avatar={avatar} aiEnabled={current.third_party_ai_enabled ?? true} />
      )}

      {preparing && (
        <section className="card mb-6" aria-labelledby="preparing-title">
          <h2 id="preparing-title" className="flex items-center gap-2 font-semibold">
            <Spinner className="h-4 w-4 shrink-0 text-brand-600" />
            {t("avatarPreparingTitle")}
          </h2>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">{t("avatarPreparingHint")}</p>
          <Link className="btn-secondary mt-3 min-h-11" to={`/avatars/new/${preparing}`}>
            {t("avatarPreparingFollow")}
          </Link>
        </section>
      )}

      {!preparing && (avatar.status === "pending" || avatar.status === "processing") && (
        <div className="mb-6">
          <PrepProgress avatar={avatar} onRetry={() => void retry()} error={retryError} />
        </div>
      )}

      {adjusting && avatar.status === "ready" && (
        <div className="mb-6">
          <MarkFacePanel avatar={avatar} orgId={current.id} onClose={() => setAdjusting(false)} />
        </div>
      )}

      {avatar.status === "ready" && avatar.rig_url && avatar.thumbnail_url && (
        // One column on a phone, sized to the screen (minmax(0, 1fr)): an
        // implicit column would grow to the embed snippet's longest line.
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
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
              onSelectionChange={(next) => void saveVoice(next)}
            />
            {avatar.kind !== "model3d" && (
              <MouthPanel
                avatar={avatar}
                orgId={current.id}
                onPreview={(renderer, profile) => setMouthPreview(draftMouthConfig(avatar, renderer, profile))}
                motion={motion}
                onMotion={setMotion}
              />
            )}
            <SharePanel avatar={avatar} orgId={current.id} />
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
