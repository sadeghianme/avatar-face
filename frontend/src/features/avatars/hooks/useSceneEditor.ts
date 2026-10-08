import { useEffect, useRef, useState } from "react";

import { useRemoveSceneImage, useUpdateAvatar, useUploadSceneImage } from "@/features/avatars/api";
import {
  type BackgroundKind,
  clampScene,
  DEFAULT_COLOR,
  isCutOut,
  panStepped,
  sameScene,
  type SceneDraft,
  sceneErrorKey,
  sceneOf,
  ZOOM_FACE,
  zoomPreset,
  zoomText,
} from "@/features/avatars/scene";
import { useT } from "@/i18n";
import { ApiError } from "@/lib/api";
import type { Avatar } from "@/lib/types";

/** How long after the last change a save goes out: a drag or a slider
 *  sends many changes a second, the server needs the last one. */
const SAVE_AFTER_MS = 350;

/**
 * The framing and the scene being edited (FramingScenePanel draws them):
 * the draft, shown at once on the page's preview (`onPreview`) and saved
 * once the changes stop, as a DRAFT edit; re-seeded when the server's copy
 * changes under it; the background picture's upload and removal; and
 * whether the last save went through.
 */
export function useSceneEditor(avatar: Avatar, orgId: string, onPreview: (scene: SceneDraft | null) => void) {
  const { t } = useT();
  const update = useUpdateAvatar(orgId, avatar.id);
  const uploadImage = useUploadSceneImage(orgId, avatar.id);
  const deleteImage = useRemoveSceneImage(orgId, avatar.id);
  const saved = sceneOf(avatar);
  const savedKey = JSON.stringify([avatar.scene ?? null, avatar.framing ?? null]);
  const [draft, setDraft] = useState<SceneDraft>(saved);
  const draftRef = useRef(draft);
  const timer = useRef<number | null>(null);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const hasImage = Boolean(avatar.scene?.background.has_image);

  // The latest avatar and callback, for an effect that runs on something
  // narrower than every render (the saved scene).
  const latest = useRef({ avatar, onPreview });
  latest.current = { avatar, onPreview };

  // Re-seed when the server's copy changes under us (publish, discard, an
  // upload), unless a save of a newer draft is still on its way. Keyed by
  // the saved scene alone: a refetch that changes nothing else must not
  // throw away the draft being dragged.
  useEffect(() => {
    if (timer.current !== null) return;
    const next = sceneOf(latest.current.avatar);
    draftRef.current = next;
    setDraft(next);
    latest.current.onPreview(null);
  }, [savedKey]);

  /** The scene in words a request refused with. */
  const refusal = (err: unknown): string => {
    if (!(err instanceof ApiError)) return t("error");
    const key = sceneErrorKey(err.code);
    return key ? t(key) : err.detail || t("error");
  };

  /** Save the draft: the response replaces the cached avatar's settings
   *  (no refetch: that re-signs every asset URL and rebuilds the preview
   *  mid-sentence). */
  const save = async (scene: SceneDraft) => {
    setStatus("saving");
    setError(null);
    try {
      await update.mutateAsync({
        body: {
          scene: {
            zoom: scene.zoom,
            pan: scene.pan,
            background:
              scene.background.kind === "color"
                ? { kind: "color", color: scene.background.color ?? DEFAULT_COLOR }
                : { kind: scene.background.kind },
          },
        },
      });
      setStatus("saved");
    } catch (err) {
      setError(refusal(err));
      setStatus("error");
    }
  };

  /** Show a change now; save it once the changes stop. */
  const change = (next: SceneDraft) => {
    const clean = clampScene(next);
    draftRef.current = clean;
    setDraft(clean);
    onPreview(clean);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      void save(draftRef.current);
    }, SAVE_AFTER_MS);
  };
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    []
  );

  /** A change to the background picture, then the avatar fetched again: the
   *  detail carries its presigned URL, which the preview draws from. */
  const picture = async (request: () => Promise<unknown>) => {
    setError(null);
    try {
      await request();
      setStatus("saved");
    } catch (err) {
      setError(refusal(err));
      setStatus("error");
    }
  };

  const words = zoomText(draft.zoom);
  return {
    draft,
    /** The scene as it is now, between renders (a drag reads it). */
    draftRef,
    change,
    status,
    error,
    hasImage,
    cutOut: isCutOut(avatar),
    zoomWords: t(words.key, { percent: words.percent }),
    preset: zoomPreset(draft.zoom),
    dirty: !sameScene(draft, saved),
    setZoom: (zoom: number) => change({ ...draft, zoom }),
    reset: () => change({ ...draft, zoom: ZOOM_FACE, pan: { x: 0, y: 0 } }),
    /** An arrow key on the position pad (Shift: further); false for any other key. */
    panKey: (key: string, fast: boolean): boolean => {
      const next = panStepped(draft.pan, key, fast);
      if (next) change({ ...draft, pan: next });
      return next !== null;
    },
    fileRef,
    chooseKind: (kind: BackgroundKind) => {
      if (kind === "image" && !hasImage) {
        fileRef.current?.click();
        return;
      }
      change({
        ...draft,
        background: kind === "color" ? { kind, color: draft.background.color ?? DEFAULT_COLOR } : { kind },
      });
    },
    chooseColor: (color: string) => change({ ...draft, background: { kind: "color", color } }),
    busyImage: uploadImage.isPending || deleteImage.isPending,
    upload: (file: File | undefined) => {
      if (file) void picture(() => uploadImage.mutateAsync(file));
    },
    removeImage: () => void picture(() => deleteImage.mutateAsync()),
  };
}

export type SceneEditor = ReturnType<typeof useSceneEditor>;
