import { DEFAULT_REFERENCE_PROFILE, normalizeProfile, type ReferenceProfile } from "@liveface/embed/mouth";
import { useEffect, useReducer, useRef, useState } from "react";

import { useRadioGroup } from "@/components/ui/useRadioGroup";
import {
  useAvatarCache,
  usePublishAvatar,
  useRemoveMouthPhoto,
  useUpdateAvatar,
  useUploadMouthPhoto,
} from "@/features/avatars/api";
import { stageCount } from "@/features/avatars/creation";
import { useConsent } from "@/features/avatars/hooks/useConsent";
import { type KitEnding, useMouthKit } from "@/features/avatars/hooks/useMouthKit";
import {
  canCompareShapes,
  droppedText,
  kitFailureText,
  kitTeethReason,
  shapesView,
} from "@/features/avatars/mouth-kit";
import { TEETH_LINE_START, teethLine } from "@/features/avatars/mouth-teeth-line";
import { type MouthAction, mouthErrorKey, teethView } from "@/features/avatars/teeth";
import { useT } from "@/i18n";
import type { MessageKey } from "@/i18n/types";
import { ApiError } from "@/lib/api";
import type { Avatar, MouthRenderer } from "@/lib/types";

/** The photographic mouth paints human teeth; the server refuses it elsewhere. */
const rendererChoices = (avatar: Avatar): MouthRenderer[] =>
  (avatar.face_type ?? "human") === "human" ? ["classic", "continuous"] : ["classic"];

/**
 * The Mouth panel's state and requests (MouthPanel draws them): the draft
 * renderer and profile, previewed live and saved on release; the teeth
 * photo, uploaded or removed; the AI kit, asked for and followed to its
 * end; Publish beside what this visit changed; and every derived line of
 * words the panel shows.
 */
export function useMouthPanel(
  avatar: Avatar,
  orgId: string,
  onPreview: (renderer: MouthRenderer, profile: ReferenceProfile) => void
) {
  const { t } = useT();
  const saved = avatar.mouth ?? null;
  const choices = rendererChoices(avatar);
  const savedRenderer: MouthRenderer = saved && choices.includes(saved.renderer) ? saved.renderer : "classic";
  const [renderer, setRenderer] = useState<MouthRenderer>(savedRenderer);
  const [profile, setProfile] = useState<ReferenceProfile>(() => normalizeProfile(saved?.profile));
  const [line, dispatch] = useReducer(teethLine, TEETH_LINE_START);
  const consent = useConsent(orgId);
  const cache = useAvatarCache(orgId, avatar.id);
  const update = useUpdateAvatar(orgId, avatar.id);
  const uploadPhoto = useUploadMouthPhoto(orgId, avatar.id);
  const removePhoto = useRemoveMouthPhoto(orgId, avatar.id);
  const publishAvatar = usePublishAvatar(orgId, avatar.id);
  const human = (avatar.face_type ?? "human") === "human";
  // A teeth photo request on its way (the avatar is fetched again after it).
  const busy = uploadPhoto.isPending || removePhoto.isPending;

  // Re-seed when the server's copy changes under us (publish, discard):
  // keyed by its content, not by the object a refetch replaces.
  const savedKey = JSON.stringify(saved);
  const seed = useRef({ renderer: savedRenderer, profile: saved?.profile });
  seed.current = { renderer: savedRenderer, profile: saved?.profile };
  useEffect(() => {
    setRenderer(seed.current.renderer);
    setProfile(normalizeProfile(seed.current.profile));
  }, [savedKey]);

  /** A refused mouth request in words: the panel's own for what it knows,
   * the server's sentence otherwise, and how long to wait when it said. */
  const refusal = (err: unknown, action: MouthAction) => {
    if (!(err instanceof ApiError)) return t("error");
    const key = mouthErrorKey(err.code, action);
    const text = key ? t(key) : err.detail || t("error");
    return err.retryAfter ? `${text} ${t("createRetryAfter", { count: err.retryAfter })}` : text;
  };

  /** How the kit job this tab followed ended: made (the avatar is fetched
   * again, and Publish offered beside it), or why not. */
  const ended = (ending: KitEnding) => {
    if (ending.kind === "done") {
      dispatch({ type: "clearError" });
      void cache.refresh().then(() => dispatch({ type: "changed", changed: "kit" }));
      return;
    }
    const failure = ending.kind === "interrupted" ? { code: "interrupted", detail: "" } : ending.error;
    const error = kitFailureText(t, failure, (code) => mouthErrorKey(code, "generate"), ending.lastStage === "teeth");
    dispatch({ type: "failed", error });
    // The switch was turned off meanwhile: the action gives way.
    if (failure.code === "third_party_ai_disabled") consent.refreshAiSwitch();
  };
  const kit = useMouthKit(orgId, avatar.id, avatar.kind === "photo" && human, ended);
  const running = kit.running;

  /** One teeth photo request; true when it went through (else the error
   * is shown). */
  const request = async (work: () => Promise<unknown>, action: MouthAction): Promise<boolean> => {
    dispatch({ type: "clearError" });
    try {
      await work();
      return true;
    } catch (err) {
      dispatch({ type: "failed", error: refusal(err, action) });
      return false;
    }
  };

  /**
   * Settings saves merge the response into the cached avatar instead of
   * refetching (useUpdateAvatar): a refetch re-signs every asset URL and
   * the preview would rebuild, restarting the face mid-sentence, on every
   * slider release. A refusal is the mutation's error (saveError).
   */
  const save = async (nextRenderer: MouthRenderer, nextProfile: ReferenceProfile) => {
    try {
      await update.mutateAsync({ body: { mouth: { renderer: nextRenderer, profile: nextProfile } } });
    } catch {
      // shown from update.error
    }
  };
  const saveError = update.error ? (update.error instanceof ApiError ? update.error.detail : t("error")) : null;

  const choose = (next: MouthRenderer) => {
    setRenderer(next);
    onPreview(next, profile);
    void save(next, profile);
  };
  // Classic or Photographic: one tab stop, the arrows choose.
  const rendererRadio = useRadioGroup(
    choices,
    renderer,
    (next) => {
      if (next !== renderer) choose(next);
    },
    () => busy
  );

  const slide = (key: keyof ReferenceProfile, value: number) => {
    const next = { ...profile, [key]: value };
    setProfile(next);
    onPreview(renderer, next);
  };
  const reset = () => {
    const defaults = { ...DEFAULT_REFERENCE_PROFILE };
    setProfile(defaults);
    onPreview(renderer, defaults);
    void save(renderer, defaults);
  };

  const upload = (file: File | undefined) => {
    if (!file) return;
    void request(() => uploadPhoto.mutateAsync(file), "upload").then((done) => {
      if (done) dispatch({ type: "changed", changed: "upload" });
    });
  };
  const remove = () => void request(() => removePhoto.mutateAsync(), "upload");

  const teeth = teethView(saved);
  const ownTeeth = teeth?.kind === "upload";
  const shapes = shapesView(saved);
  const continuous = renderer === "continuous";
  const actionKey: MessageKey = ownTeeth ? "mouthKitMakeShapes" : "mouthKitMake";

  /**
   * The person's mouth shapes and teeth, made by AI from this avatar's
   * picture, what a new avatar gets when it is built: for one built before,
   * whose mouth could not be made then, or whose picture changed since. A
   * draft edit; the member's remembered consent is used, or asked for once
   * (useConsent.withAi), and "Not now" sends nothing.
   */
  const makeKit = async () => {
    dispatch({ type: "kitAsked" });
    try {
      await consent.withAi(t(actionKey), (consentId) => kit.start(consentId));
    } catch (err) {
      dispatch({ type: "failed", error: refusal(err, "generate") });
    } finally {
      dispatch({ type: "kitAnswered" });
    }
  };

  const publish = async () => {
    dispatch({ type: "clearError" });
    try {
      await publishAvatar.mutateAsync();
      dispatch({ type: "changed", changed: null });
    } catch (err) {
      dispatch({ type: "failed", error: err instanceof ApiError ? err.detail : t("error") });
    }
  };

  // Where the running job is, in words: queued, its stage (the shapes
  // counted), or nothing known beyond that it runs.
  const stage = kit.stage;
  const count = stage === "shapes" ? stageCount(running) : null;
  // The shapes come with the teeth photo, unless the owner's own is kept.
  const stageKey: MessageKey | null =
    stage === "shapes" && !ownTeeth ? "mouthKitStage_shapesTeeth" : stage ? `mouthKitStage_${stage}` : null;
  const progressText = !running
    ? ""
    : running.state === "queued"
      ? t("createJobQueued")
      : stageKey
        ? t(stageKey)
        : t("mouthKitWorking");
  const progressSpoken = count
    ? `${progressText} ${t("mouthShapesCount", { done: count.done, total: count.total })}`
    : progressText;
  // Until the draft with the new mouth is live.
  const promptPublish = line.changed !== null && (avatar.unpublished === true || !avatar.published);
  const madeText =
    line.changed === "upload"
      ? t("mouthTeethMade")
      : saved?.kit?.state === "made"
        ? t(saved.kit.teeth?.used ? "mouthKitMadeTeeth" : "mouthKitMade")
        : t("mouthTeethMade");

  return {
    human,
    choices,
    renderer,
    rendererRadio,
    continuous,
    profile,
    slide,
    /** Saved on release, not per tick: each save is a draft edit. */
    release: () => void save(renderer, profile),
    reset,
    saveError,
    busy,
    shapes: shapes && {
      view: shapes,
      standard: shapes.kind !== "own" ? shapes.standard : [],
      dropped: droppedText(t, shapes),
      compare: canCompareShapes(saved),
    },
    teeth: {
      view: teeth,
      hasPhoto: Boolean(saved?.has_oral_photo),
      own: ownTeeth,
      note: teeth?.kind === "generic" ? teeth.note : null,
      kitReason: kitTeethReason(saved, teeth),
    },
    kit: {
      // Offered while the organization allows third-party AI; the server
      // refuses otherwise anyway (and says so). Over the owner's own teeth
      // photo too: it is kept, and only the shapes are made.
      offered: consent.aiEnabled && continuous && human,
      actionKey,
      asking: line.starting,
      running,
      count,
      progressText,
      make: () => void makeKit(),
    },
    upload,
    remove,
    error: line.error,
    publishPrompt: promptPublish ? madeText : null,
    publishing: publishAvatar.isPending,
    publish: () => void publish(),
    /** One region, always mounted, says what happens to the mouth: a
     *  region mounted with its text is not reliably read out. */
    spoken: running ? progressSpoken : promptPublish ? madeText : "",
    consentDialog: consent.dialog,
  };
}

export type MouthPanelState = ReturnType<typeof useMouthPanel>;
