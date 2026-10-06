import type { SpeechPlayer } from "@liveface/embed";
import type { AvatarMouthConfig, ClassicMouthConfig } from "@liveface/embed/mouth";
import { type CSSProperties, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router-dom";

import { Button } from "@/components/ui/Button";
import { ButtonLink } from "@/components/ui/ButtonLink";
import { Card } from "@/components/ui/Card";
import { Checkbox } from "@/components/ui/Checkbox";
import { Disclosure, DisclosureGroup } from "@/components/ui/Disclosure";
import { IconButton } from "@/components/ui/IconButton";
import { Spinner } from "@/components/ui/Spinner";
import {
  useAvatar,
  useAvatarBackground,
  useDeleteAvatar,
  useRetryAvatar,
  useUndoAvatarEdit,
  useUpdateAvatar,
} from "@/features/avatars/api";
import { Avatar3DPreview } from "@/features/avatars/components/Avatar3DPreview";
import { AvatarPageHead } from "@/features/avatars/components/AvatarPageHead";
import { AvatarPreview } from "@/features/avatars/components/AvatarPreview";
import { CropStudio } from "@/features/avatars/components/CropStudio";
import { EmbedSnippet } from "@/features/avatars/components/EmbedSnippet";
import { FinishNotice } from "@/features/avatars/components/FinishNotice";
import { FramingScenePanel } from "@/features/avatars/components/FramingScenePanel";
import { MarkFacePanel } from "@/features/avatars/components/MarkFacePanel";
import { MouthPanel } from "@/features/avatars/components/MouthPanel";
import { PrepProgress } from "@/features/avatars/components/PrepProgress";
import { PublishBar } from "@/features/avatars/components/PublishBar";
import { SharePanel } from "@/features/avatars/components/SharePanel";
import { TuningPanel } from "@/features/avatars/components/TuningPanel";
import { errorText } from "@/features/avatars/creation";
import { useAvatarMouth } from "@/features/avatars/hooks/useAvatarMouth";
import { useOpenSections } from "@/features/avatars/hooks/useOpenSections";
import { useStageFullscreen } from "@/features/avatars/hooks/useStageFullscreen";
import {
  draftMouthConfig,
  type MotionChoice,
  previewMotion,
  savedMouthKey,
  urlIdentity,
} from "@/features/avatars/mouth-config";
import { engineScene, type SceneDraft, sceneOf } from "@/features/avatars/scene";
import { SpeakPanel } from "@/features/voices";
import { defaultVoiceSelection, type VoiceSelection } from "@/features/voices";
import { ApiError } from "@/lib/api";
import { cx } from "@/lib/cx";
import { useOrg } from "@/providers/org";

/**
 * The stage, a square. In one column (below lg) it is capped so Speak is
 * not a screen away — 55% of an upright window, the window under the
 * header on a phone on its side — and centred; beside the settings (lg)
 * it sticks under the page head (--head-h), no taller than the window
 * leaves.
 */
const STAGE_SQUARE = cx(
  "aspect-square p-0",
  "max-lg:mx-auto max-lg:portrait:max-h-[55dvh] max-lg:landscape:max-h-[calc(100dvh-3.5rem-env(safe-area-inset-top)-2rem)]",
  "lg:sticky lg:top-[calc(3.5rem+env(safe-area-inset-top)+var(--head-h))]",
  "lg:max-h-[calc(100dvh-3.5rem-env(safe-area-inset-top)-var(--head-h)-1rem)]"
);

/** An iPhone's "fullscreen": the stage covers the window, safe areas padded. */
const STAGE_COVERING = cx(
  "!fixed inset-0 z-[60] !m-0 !aspect-auto !max-h-none bg-white dark:bg-ink",
  "pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)]"
);

/**
 * The avatar's page: the avatar on the left, everything about it on the
 * right (docs/avatar-lines.md, "The avatar page").
 *
 * Three fifths of the width is the stage: the avatar, sized to the window
 * and kept in view (sticky under the page head) while the settings scroll
 * beside it; nothing sits under it. Two fifths is the settings column:
 * the publish state first, then Speak, then the settings in named groups
 * (Disclosure). The page head — back, the name, the status, what the
 * AI did, and the actions on the picture — stays at the top of the window
 * too, so Mark the face, Test and Delete are one click away from anywhere
 * in the column. On a phone it is one column, the stage first.
 */
export function AvatarDetailPage() {
  const { t } = useTranslation();
  const { avatarId } = useParams<{ avatarId: string }>();
  const { current } = useOrg();
  const navigate = useNavigate();
  const [engine, setEngine] = useState<SpeechPlayer | null>(null);
  const [debugMesh, setDebugMesh] = useState(false);
  const [adjusting, setAdjusting] = useState(false);
  const [cropping, setCropping] = useState(false);
  // Delete asks once, in place (ConfirmButton); nothing destructive on one click.
  const [deleting, setDeleting] = useState(false);
  // The settings' folded sections, as the member left them.
  const sections = useOpenSections();
  // The avatar's DRAFT voice. Seeded from the saved value once loaded, and
  // every change is written back — voice is a published property like
  // framing now, so picking one shows the Publish bar and publishing makes
  // embeds and share links speak with it.
  const [voice, setVoice] = useState<VoiceSelection>(defaultVoiceSelection);
  const seededFor = useRef<string | null>(null);
  const [busyBg, setBusyBg] = useState(false);
  // The mouth being previewed: the panel's live state while the owner is
  // choosing or dragging, otherwise whatever the draft has saved.
  const [mouthPreview, setMouthPreview] = useState<AvatarMouthConfig | ClassicMouthConfig | null | undefined>(
    undefined
  );
  // Which mouth shapes the preview plays: the avatar's own, or the standard
  // ones to compare them with. The preview only; nothing is saved.
  const [motion, setMotion] = useState<MotionChoice>("own");
  // Why the rig job could not be run again, in words.
  const [retryError, setRetryError] = useState<string | null>(null);
  // The scene being edited in the Framing & scene panel, shown live on the
  // preview; null means whatever the draft has saved.
  const [scenePreview, setScenePreview] = useState<SceneDraft | null>(null);

  // The page head's height, measured: the stage sticks just under it and
  // is sized to what the window has left, whether the head's row of
  // actions wraps or not.
  const [headHeight, setHeadHeight] = useState(76);
  const headObserver = useRef<ResizeObserver | null>(null);
  const headRef = useCallback((el: HTMLDivElement | null) => {
    headObserver.current?.disconnect();
    headObserver.current = null;
    if (!el) return;
    setHeadHeight(el.offsetHeight);
    headObserver.current = new ResizeObserver(() => setHeadHeight(el.offsetHeight));
    headObserver.current.observe(el);
  }, []);

  // The stage, full screen or covering the window (useStageFullscreen).
  const previewBoxRef = useRef<HTMLDivElement>(null);
  const { expanded, covering, toggle: toggleFullscreen } = useStageFullscreen(previewBoxRef);

  // The page's server calls. The org and the id are known by the time any
  // of them runs (the page renders nothing before the avatar is loaded).
  const orgId = current?.id ?? "";
  const id = avatarId ?? "";
  const update = useUpdateAvatar(orgId, id);
  const background = useAvatarBackground(orgId, id);
  const retryJob = useRetryAvatar(orgId, id);
  const undoEdit = useUndoAvatarEdit(orgId, id);
  const deleteAvatar = useDeleteAvatar(orgId);

  const saveVoice = async (selection: VoiceSelection) => {
    setVoice(selection);
    // The PATCH bumps the draft revision; refetched so the Publish bar appears.
    await update.mutateAsync({
      body: { voice: { provider: selection.provider, voice: selection.voice, locale: selection.locale } },
      refetch: "detail",
    });
  };

  // Polled while the rig pipeline runs.
  const { data: avatar, isError } = useAvatar(current?.id, avatarId, { poll: true });

  // Seed once per avatar: reopening the page must show the saved voice, but
  // a refetch mid-edit must not clobber a selection being made.
  useEffect(() => {
    if (avatar?.voice && seededFor.current !== avatar.id) {
      seededFor.current = avatar.id;
      setVoice(avatar.voice as VoiceSelection);
    }
  }, [avatar]);

  // Another avatar on this page is another page: nothing half-done carries
  // over (the delete question, keyed by avatar, goes by itself).
  useEffect(() => {
    setCropping(false);
    setAdjusting(false);
  }, [avatarId]);

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

  // The scene (zoom, pan, background) is a property of the avatar, not a
  // local view preference: it is what embedding sites render, so editing
  // it in the Framing & scene panel changes what visitors to those sites
  // see, once published. The preview shows the edit as it is made.
  const sceneShown = engineScene(scenePreview ?? sceneOf(avatar), avatar.scene_image_url);

  /** The name, edited in place in the title (InlineName). */
  const rename = async (name: string) => {
    await update.mutateAsync({ body: { name }, refetch: "all" });
  };

  /** Cut the subject out, or put the original photo back. */
  const toggleBackground = async () => {
    setBusyBg(true);
    try {
      // The detail fetched after it re-signs the image URL, so the preview
      // reloads with the new texture rather than the cached one.
      await background.mutateAsync(!avatar.original_image_key);
    } finally {
      setBusyBg(false);
    }
  };

  const retry = async () => {
    setRetryError(null);
    try {
      await retryJob.mutateAsync();
    } catch (err) {
      setRetryError(err instanceof ApiError ? errorText(t, err.code, err.detail, err.retryAfter) : t("error"));
    }
  };
  // The wizard's step 5 is building it: followed there, where its stages
  // are, not here, where there is nothing of it yet to retry.
  const preparing = avatar.preparing_creation_id ?? null;

  /** Step back one edit — crop, background, whatever it was. */
  const undo = async () => {
    await undoEdit.mutateAsync();
  };

  const remove = async () => {
    setDeleting(true);
    try {
      await deleteAvatar.mutateAsync(avatar.id);
      navigate("/app");
    } finally {
      setDeleting(false);
    }
  };

  const photo = avatar.kind === "photo";
  const is3d = avatar.kind === "model3d";
  const ready = avatar.status === "ready";
  const editable = photo && ready;
  const staged = ready && Boolean(avatar.rig_url && avatar.thumbnail_url);
  const human = (avatar.face_type ?? "human") === "human";
  const mouthSummary = human
    ? t(avatar.mouth?.renderer === "continuous" ? "mouthContinuous" : "mouthClassic")
    : t("mouthSummary");

  return (
    <div style={{ "--head-h": `${headHeight}px` } as CSSProperties}>
      {/* The page head (AvatarPageHead). On a wide screen it stays under
          the shell's header while the settings scroll; the stage sticks
          under it (--head-h). */}
      <AvatarPageHead
        ref={headRef}
        avatar={avatar}
        onRename={rename}
        editable={editable}
        adjusting={adjusting}
        onToggleAdjusting={() => setAdjusting((a) => !a)}
        cropping={cropping}
        onToggleCropping={() => setCropping((c) => !c)}
        busyBackground={busyBg}
        onToggleBackground={() => void toggleBackground()}
        onUndo={() => void undo()}
        deleting={deleting}
        onDelete={() => void remove()}
      />

      {avatar.status === "failed" && (
        <Card tone="danger" className="mb-4">
          <p className="field-error">{avatar.error}</p>
          <Button variant="secondary" size="lg" className="mt-3" onClick={() => void retry()}>
            {t("retry")}
          </Button>
          {retryError && (
            <p className="field-error mt-2 text-sm" role="alert">
              {retryError}
            </p>
          )}
        </Card>
      )}

      {preparing && (
        <Card as="section" className="mb-4" aria-labelledby="preparing-title">
          <h2 id="preparing-title" className="flex items-center gap-2 font-semibold">
            <Spinner className="h-4 w-4 shrink-0 text-brand-600" />
            {t("avatarPreparingTitle")}
          </h2>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">{t("avatarPreparingHint")}</p>
          <ButtonLink variant="secondary" size="lg" className="mt-3" to={`/avatars/new/${preparing}`}>
            {t("avatarPreparingFollow")}
          </ButtonLink>
        </Card>
      )}

      {!preparing && (avatar.status === "pending" || avatar.status === "processing") && (
        <div className="mb-4">
          <PrepProgress avatar={avatar} onRetry={() => void retry()} error={retryError} />
        </div>
      )}

      {adjusting && ready && (
        <div className="mb-4">
          <MarkFacePanel avatar={avatar} orgId={current.id} onClose={() => setAdjusting(false)} />
        </div>
      )}

      {staged && (
        // Three fifths the stage, two fifths the settings; one column on a
        // phone, sized to the screen (minmax(0, …)): an implicit column
        // would grow to the embed snippet's longest line.
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          {/* The stage: the avatar, and nothing under it. A square, the
              shape visitors get, as wide as its column; on a wide screen
              no taller than the window leaves under the page head (a wide,
              short window gets a landscape stage with the square inside),
              and stuck there while the settings scroll. In one column (a
              phone, a tablet upright) it is capped too, so Speak is not a
              screen away: at most 55% of an upright window (a 768px tablet
              would otherwise get a 736px square), and the window under the
              header on a phone on its side; the square is then centred
              (max-height carries to the width through the aspect ratio).
              The crop studio takes the room it needs instead. */}
          <Card
            ref={previewBoxRef}
            className={cx(
              "relative overflow-hidden lg:self-start",
              cropping ? "p-3" : STAGE_SQUARE,
              expanded && "preview-fullscreen",
              covering && STAGE_COVERING
            )}
          >
            {!cropping && (
              <IconButton
                variant="overlay"
                tooltip
                label={t(expanded ? "exitFullscreen" : "fullscreen")}
                icon={expanded ? "compress" : "expand"}
                iconClassName="h-4 w-4"
                onClick={toggleFullscreen}
                className={cx(
                  "absolute end-3 z-10 h-10 w-10",
                  covering ? "top-[calc(0.75rem+env(safe-area-inset-top))]" : "top-3"
                )}
              />
            )}
            {cropping ? (
              <CropStudio
                avatar={avatar}
                orgId={current.id}
                onCancel={() => setCropping(false)}
                onDone={() => setCropping(false)}
              />
            ) : is3d && avatar.model_url ? (
              <Avatar3DPreview modelUrl={avatar.model_url} fit="box" onEngine={setEngine} />
            ) : (
              <AvatarPreview
                rigUrl={avatar.rig_url!}
                // Full-resolution texture: the 256px thumbnail looks blurry
                // on a large preview canvas.
                textureUrl={avatar.image_url ?? avatar.thumbnail_url!}
                layerUrls={avatar.layer_urls}
                // The stage is most of a window: a 720-point square (1440
                // device pixels on a 2× screen) keeps the teeth sharp.
                size={720}
                debugMesh={debugMesh}
                scene={sceneShown}
                soft
                fit="box"
                onEngine={setEngine}
              />
            )}
          </Card>

          {/* The settings: the publish state, Speak, then the groups. */}
          <div className="flex min-w-0 flex-col gap-3">
            {avatar.quality_note && (
              <Card tone="warning" padding="sm">
                <p className="text-[13.5px] text-amber-700 dark:text-amber-400">
                  <span className="font-medium">
                    {avatar.published ? t("qualityNoteTitle") : t("qualityNoteFirstTitle")}
                  </span>{" "}
                  {avatar.quality_note}
                </p>
                {/* "It still works" is about a live avatar; before the first
                    publish the note itself says what to do. */}
                {avatar.published && (
                  <p className="mt-1 text-[13px] text-gray-500 dark:text-gray-400">{t("qualityNoteHint")}</p>
                )}
                {photo && !adjusting && (
                  <Button
                    variant="secondary"
                    size="sm"
                    icon="target"
                    className="mt-3"
                    onClick={() => setAdjusting(true)}
                  >
                    {t("markFace")}
                  </Button>
                )}
              </Card>
            )}

            <PublishBar avatar={avatar} orgId={current.id} />

            {/* Keyed by avatar: a notice read for one avatar is not shown on the
                next one this page opens. */}
            <FinishNotice
              key={avatar.id}
              avatar={avatar}
              aiEnabled={current.third_party_ai_enabled ?? true}
              onToMouth={() => sections.reveal("mouth")}
            />

            <SpeakPanel
              engine={engine}
              orgId={current.id}
              selection={voice}
              onSelectionChange={(next) => void saveVoice(next)}
              title={t("speakPanelTitle")}
              hint={t("speakPanelHint")}
            />

            {!is3d && (
              <DisclosureGroup label={t("sectionLook")}>
                {photo && (
                  <Disclosure
                    id="scene"
                    icon="image"
                    title={t("sceneTitle")}
                    summary={t("sceneSummary")}
                    open={sections.open.scene}
                    onToggle={() => sections.toggle("scene")}
                  >
                    <FramingScenePanel
                      avatar={avatar}
                      orgId={current.id}
                      surfaceRef={previewBoxRef}
                      active={!cropping && !adjusting}
                      onPreview={setScenePreview}
                      onRemoveBackground={toggleBackground}
                      busyBackground={busyBg}
                    />
                  </Disclosure>
                )}
                <Disclosure
                  id="mouth"
                  icon="faces"
                  title={t("mouthTitle")}
                  summary={mouthSummary}
                  open={sections.open.mouth}
                  onToggle={() => sections.toggle("mouth")}
                >
                  <MouthPanel
                    avatar={avatar}
                    orgId={current.id}
                    onPreview={(renderer, profile) => setMouthPreview(draftMouthConfig(avatar, renderer, profile))}
                    onPreviewCharacter={(settings) =>
                      setMouthPreview(settings ? draftMouthConfig(avatar, undefined, undefined, settings) : undefined)
                    }
                    motion={motion}
                    onMotion={setMotion}
                  />
                </Disclosure>
              </DisclosureGroup>
            )}

            <DisclosureGroup label={t("sectionPublish")}>
              <Disclosure
                id="share"
                icon="link"
                title={t("shareTitle")}
                summary={avatar.share_token ? t("shareSummaryOn") : t("shareSummaryOff")}
                open={sections.open.share}
                onToggle={() => sections.toggle("share")}
              >
                <SharePanel avatar={avatar} orgId={current.id} />
              </Disclosure>
              <Disclosure
                id="embed"
                icon="code"
                title={t("embedSnippet")}
                summary={t("embedSummary")}
                open={sections.open.embed}
                onToggle={() => sections.toggle("embed")}
              >
                <EmbedSnippet avatarId={avatar.id} voice={voice} />
              </Disclosure>
            </DisclosureGroup>

            <DisclosureGroup label={t("sectionAdvanced")}>
              <Disclosure
                id="tuning"
                icon="sliders"
                title={t("tuning")}
                summary={t("tuningSummary")}
                open={sections.open.tuning}
                onToggle={() => sections.toggle("tuning")}
              >
                <TuningPanel engine={engine} avatarId={avatar.id} is3d={is3d} />
                {photo && (
                  <Checkbox
                    className="mt-4 min-h-11 border-t border-gray-100 pt-4 dark:border-white/[0.07]"
                    label={t("debugMesh")}
                    description={t("debugMeshHint")}
                    checked={debugMesh}
                    onChange={(e) => setDebugMesh(e.target.checked)}
                  />
                )}
              </Disclosure>
            </DisclosureGroup>
          </div>
        </div>
      )}
    </div>
  );
}
