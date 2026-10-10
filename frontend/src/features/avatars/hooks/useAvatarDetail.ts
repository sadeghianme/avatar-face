import type { SpeechPlayer } from "@liveface/embed";
import type { AvatarMouthConfig, ClassicMouthConfig } from "@liveface/embed/mouth";
import { useEffect, useReducer, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import {
  useAvatar,
  useAvatarBackground,
  useDeleteAvatar,
  useExpressions,
  useRetryAvatar,
  useUndoAvatarEdit,
  useUpdateAvatar,
} from "@/features/avatars/api";
import { errorText } from "@/features/avatars/creation";
import { useAvatarMouth } from "@/features/avatars/hooks/useAvatarMouth";
import { useExpressionPictures } from "@/features/avatars/hooks/useExpressionPictures";
import {
  draftMouthConfig,
  type MotionChoice,
  previewMotion,
  savedMouthKey,
  urlIdentity,
} from "@/features/avatars/mouth-config";
import type { SceneDraft } from "@/features/avatars/scene";
import { defaultVoiceSelection, type VoiceSelection } from "@/features/voices";
import { useT } from "@/i18n";
import { ApiError } from "@/lib/api";
import { useOrg } from "@/providers/org";

type MouthPreview = AvatarMouthConfig | ClassicMouthConfig | null | undefined;

/**
 * What the stage shows beyond the saved draft. `mouth`: the Mouth panel's
 * live state while the owner chooses or drags (undefined: the draft's
 * saved mouth). `motion`: the avatar's own mouth shapes or the standard
 * ones, to compare them (the preview only; nothing is saved). `scene`: the
 * scene being edited in Framing & scene (null: the saved one). `debugMesh`:
 * the rig's mesh drawn over the face.
 */
interface Stage {
  mouth: MouthPreview;
  motion: MotionChoice;
  scene: SceneDraft | null;
  debugMesh: boolean;
}

type StageEvent =
  | { type: "mouth"; mouth: MouthPreview }
  | { type: "motion"; motion: MotionChoice }
  | { type: "scene"; scene: SceneDraft | null }
  | { type: "debugMesh"; on: boolean };

function stage(state: Stage, event: StageEvent): Stage {
  switch (event.type) {
    case "mouth":
      return { ...state, mouth: event.mouth };
    case "motion":
      return { ...state, motion: event.motion };
    case "scene":
      return { ...state, scene: event.scene };
    case "debugMesh":
      return { ...state, debugMesh: event.on };
  }
}

/** The tools open on the picture: marking the face, cropping it. */
interface Tools {
  adjusting: boolean;
  cropping: boolean;
}

type ToolsEvent =
  | { type: "toggle"; tool: keyof Tools }
  | { type: "close"; tool: keyof Tools }
  | { type: "open"; tool: keyof Tools }
  | { type: "closeAll" };

function tools(state: Tools, event: ToolsEvent): Tools {
  switch (event.type) {
    case "toggle":
      return { ...state, [event.tool]: !state[event.tool] };
    case "open":
      return { ...state, [event.tool]: true };
    case "close":
      return { ...state, [event.tool]: false };
    case "closeAll":
      return { adjusting: false, cropping: false };
  }
}

/**
 * The avatar page's state and requests (AvatarDetailPage draws them): the
 * avatar, polled while its rig is built; the draft voice, seeded once per
 * avatar from the saved one and written back on every change (voice is a
 * published property, like framing: picking one shows the Publish bar);
 * what the stage previews; the tools open; and the page's actions
 * (rename, the background, retry, undo, delete).
 */
export function useAvatarDetail() {
  const { t } = useT();
  const { avatarId } = useParams<{ avatarId: string }>();
  const { current } = useOrg();
  const navigate = useNavigate();
  const [engine, setEngine] = useState<SpeechPlayer | null>(null);
  const [voice, setVoice] = useState<VoiceSelection>(defaultVoiceSelection);
  const seededFor = useRef<string | null>(null);
  const [preview, show] = useReducer(stage, { mouth: undefined, motion: "own", scene: null, debugMesh: false });
  const [open, tool] = useReducer(tools, { adjusting: false, cropping: false });

  // The page's server calls. The org and the id are known by the time any
  // of them runs (the page renders nothing before the avatar is loaded).
  const orgId = current?.id ?? "";
  const id = avatarId ?? "";
  const update = useUpdateAvatar(orgId, id);
  const background = useAvatarBackground(orgId, id);
  const retryJob = useRetryAvatar(orgId, id);
  const undoEdit = useUndoAvatarEdit(orgId, id);
  const deleteAvatar = useDeleteAvatar(orgId);

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
  useEffect(() => tool({ type: "closeAll" }), [avatarId]);

  // Saved draft mouth unless the panel is previewing something newer. The
  // preview resets whenever the saved copy changes (save, publish, discard).
  // Only human faces get the photographic mouth, and it carries the avatar's
  // own motion: the preview must show what ships (draftMouthConfig).
  const savedMouth = draftMouthConfig(avatar);
  const savedKey = savedMouthKey(avatar);
  useEffect(() => show({ type: "mouth", mouth: undefined }), [savedKey]);
  // New shapes (a kit made, rebased or discarded) are heard as they are.
  const motionIdentity = urlIdentity(avatar?.mouth?.motion_url);
  useEffect(() => show({ type: "motion", motion: "own" }), [motionIdentity]);
  useAvatarMouth(
    avatar?.kind === "model3d" ? null : (engine as Parameters<typeof useAvatarMouth>[0]),
    previewMotion(preview.mouth === undefined ? savedMouth : preview.mouth, preview.motion)
  );
  // The draft's AI expression pictures, on while the owner has chosen them.
  const expressions = useExpressions(orgId, id, Boolean(orgId && id && avatar?.kind === "photo"));
  const pictures = expressions.data?.ai ? expressions.data : null;
  useExpressionPictures(
    avatar?.kind === "model3d" ? null : (engine as Parameters<typeof useExpressionPictures>[0]),
    pictures?.manifest_url,
    pictures?.picture_urls
  );

  const saveVoice = async (selection: VoiceSelection) => {
    setVoice(selection);
    // The PATCH bumps the draft revision; refetched so the Publish bar appears.
    await update.mutateAsync({
      body: { voice: { provider: selection.provider, voice: selection.voice, locale: selection.locale } },
      refetch: "detail",
    });
  };

  /** Cut the subject out, or put the original photo back. The detail
   * fetched after it re-signs the image URL, so the preview reloads with
   * the new texture rather than the cached one. */
  const toggleBackground = async () => {
    if (avatar) await background.mutateAsync(!avatar.original_image_key);
  };

  const retry = async () => {
    try {
      await retryJob.mutateAsync();
    } catch {
      // said from retryJob.error
    }
  };
  const retryError = retryJob.error
    ? retryJob.error instanceof ApiError
      ? errorText(t, retryJob.error.code, retryJob.error.detail, retryJob.error.retryAfter)
      : t("error")
    : null;

  const remove = async () => {
    if (!avatar) return;
    await deleteAvatar.mutateAsync(avatar.id);
    navigate("/app");
  };

  return {
    org: current,
    avatar,
    isError,
    engine,
    setEngine,
    voice,
    saveVoice: (next: VoiceSelection) => void saveVoice(next),
    preview,
    /** The Mouth panel's live state; undefined puts the saved mouth back. */
    previewMouth: (mouth: MouthPreview) => show({ type: "mouth", mouth }),
    setMotion: (motion: MotionChoice) => show({ type: "motion", motion }),
    previewScene: (scene: SceneDraft | null) => show({ type: "scene", scene }),
    setDebugMesh: (on: boolean) => show({ type: "debugMesh", on }),
    adjusting: open.adjusting,
    cropping: open.cropping,
    toggleTool: (which: keyof Tools) => tool({ type: "toggle", tool: which }),
    openTool: (which: keyof Tools) => tool({ type: "open", tool: which }),
    closeTool: (which: keyof Tools) => tool({ type: "close", tool: which }),
    /** The name, edited in place in the title (InlineName). */
    rename: async (name: string) => {
      await update.mutateAsync({ body: { name }, refetch: "all" });
    },
    toggleBackground,
    busyBackground: background.isPending,
    retry: () => void retry(),
    retryError,
    /** Step back one edit: crop, background, whatever it was. */
    undo: () => void undoEdit.mutateAsync(),
    remove: () => void remove(),
    deleting: deleteAvatar.isPending,
  };
}

export type AvatarDetailState = ReturnType<typeof useAvatarDetail>;
