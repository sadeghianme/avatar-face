import { useQueryClient } from "@tanstack/react-query";
import { type RefObject, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/Button";
import { ColorInput } from "@/components/ui/ColorInput";
import { ColorSwatch } from "@/components/ui/ColorSwatch";
import { FileInput } from "@/components/ui/FileInput";
import { type Segment, SegmentedControl } from "@/components/ui/SegmentedControl";
import { Slider } from "@/components/ui/Slider";
import { PanPad } from "@/features/avatars/components/PanPad";
import {
  type BackgroundKind,
  clampScene,
  DEFAULT_COLOR,
  isCutOut,
  panned,
  panStepped,
  sameScene,
  type SceneDraft,
  sceneErrorKey,
  sceneOf,
  SWATCHES,
  ZOOM_FACE,
  ZOOM_FULL,
  ZOOM_MAX,
  ZOOM_STEP,
  zoomPreset,
  zoomText,
} from "@/features/avatars/scene";
import { api, ApiError } from "@/lib/api";
import type { Avatar } from "@/lib/types";
import { TOUCH_ONE_COLUMN, useMediaQuery } from "@/lib/useMediaQuery";

/** How long after the last change a save goes out: a drag or a slider
 *  sends many changes a second, the server needs the last one. */
const SAVE_AFTER_MS = 350;

/**
 * The framing editor and the scene: how close the avatar is shown, where
 * the picture sits, and what is behind a cut-out. Every change previews
 * live on the page's own preview (`onPreview`) and is saved as a DRAFT
 * edit, like the mouth or the voice: visitors see it once published, from
 * the widget, the share page and every preview alike.
 *
 * Panning is by dragging the preview (`surfaceRef`: the page's preview
 * box) or with the arrow keys on the position pad; the zoom is a range
 * input with its value in words. A background shows only behind a
 * cut-out: for a photo that kept its own background the panel says so and
 * offers the existing removal rather than hiding the option.
 */
export function FramingScenePanel({
  avatar,
  orgId,
  surfaceRef,
  onPreview,
  onRemoveBackground,
  busyBackground = false,
  active = true,
}: {
  avatar: Avatar;
  orgId: string;
  /** The element the avatar is previewed in: dragging it pans. */
  surfaceRef: RefObject<HTMLElement | null>;
  /** False while the preview box shows something else (the crop studio,
   *  the face marks): dragging there must not pan. */
  active?: boolean;
  /** The scene being edited, for the page's preview; null once saved. */
  onPreview: (scene: SceneDraft | null) => void;
  /** The page's own background removal, offered for an opaque photo. */
  onRemoveBackground: () => Promise<void>;
  busyBackground?: boolean;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const base = `/orgs/${orgId}/avatars/${avatar.id}`;
  const saved = sceneOf(avatar);
  const savedKey = JSON.stringify([avatar.scene ?? null, avatar.framing ?? null]);
  const [draft, setDraft] = useState<SceneDraft>(saved);
  const draftRef = useRef(draft);
  const timer = useRef<number | null>(null);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [busyImage, setBusyImage] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const hasImage = Boolean(avatar.scene?.background.has_image);
  const cutOut = isCutOut(avatar);
  // On a phone or an upright tablet the preview is most of the screen and
  // above this panel, not beside it: a swipe on it scrolls the page (it
  // used to pan the picture, a draft change made by trying to scroll).
  // The position pad moves it there; a drag still pans beside the panel.
  const touchColumn = useMediaQuery(TOUCH_ONE_COLUMN);
  const dragPans = active && !touchColumn;

  // The latest avatar and callback, for effects that run on something
  // narrower than every render (the saved scene, the drag surface).
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
      const updated = await api.patch<Avatar>(base, {
        scene: {
          zoom: scene.zoom,
          pan: scene.pan,
          background:
            scene.background.kind === "color"
              ? { kind: "color", color: scene.background.color ?? DEFAULT_COLOR }
              : { kind: scene.background.kind },
        },
      });
      queryClient.setQueryData<Avatar>(["avatar", orgId, avatar.id], (old) => (old ? { ...old, ...updated } : old));
      void queryClient.invalidateQueries({ queryKey: ["avatars", orgId] });
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
  const changeRef = useRef(change);
  changeRef.current = change;
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    []
  );

  // Dragging the preview pans. Pointer events, captured, so a drag that
  // leaves the box still ends cleanly; a frame at a time, so a fast drag
  // does not rebuild the viewport more often than it can be drawn. The
  // surface is read at render, so a remounted preview box gets the
  // listeners again.
  const surface = surfaceRef.current;
  useEffect(() => {
    const el = surface;
    if (!el || !dragPans) return;
    const change = (next: SceneDraft) => changeRef.current(next);
    let drag: { x: number; y: number; pan: { x: number; y: number } } | null = null;
    let frame = 0;
    const down = (e: PointerEvent) => {
      if (e.button !== 0) return;
      drag = { x: e.clientX, y: e.clientY, pan: draftRef.current.pan };
      el.setPointerCapture(e.pointerId);
      e.preventDefault();
    };
    const move = (e: PointerEvent) => {
      if (!drag) return;
      const { x, y, pan } = drag;
      const rect = el.getBoundingClientRect();
      const next = panned(pan, e.clientX - x, e.clientY - y, rect.width, rect.height);
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        const current = draftRef.current;
        if (current.pan.x !== next.x || current.pan.y !== next.y) change({ ...current, pan: next });
      });
    };
    const up = (e: PointerEvent) => {
      if (!drag) return;
      drag = null;
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        /* already released */
      }
    };
    el.style.cursor = "grab";
    el.style.touchAction = "none";
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    return () => {
      el.style.cursor = "";
      el.style.touchAction = "";
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [surface, dragPans]);

  const onPadKey = (e: React.KeyboardEvent) => {
    const next = panStepped(draft.pan, e.key, e.shiftKey);
    if (!next) return;
    e.preventDefault();
    change({ ...draft, pan: next });
  };
  const nudge = (key: string) => {
    const next = panStepped(draft.pan, key, false);
    if (next) change({ ...draft, pan: next });
  };

  const setZoom = (zoom: number) => change({ ...draft, zoom });
  const reset = () => change({ ...draft, zoom: ZOOM_FACE, pan: { x: 0, y: 0 } });

  const chooseKind = (kind: BackgroundKind) => {
    if (kind === "image" && !hasImage) {
      fileRef.current?.click();
      return;
    }
    change({
      ...draft,
      background: kind === "color" ? { kind, color: draft.background.color ?? DEFAULT_COLOR } : { kind },
    });
  };
  const chooseColor = (color: string) => change({ ...draft, background: { kind: "color", color } });

  /** The avatar fetched again after a picture changed: the detail carries
   *  its presigned URL, which the preview draws from. */
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["avatar", orgId, avatar.id] }),
      queryClient.invalidateQueries({ queryKey: ["avatars", orgId] }),
    ]);

  const upload = async (file: File | undefined) => {
    if (!file) return;
    const form = new FormData();
    form.append("file", file);
    setBusyImage(true);
    setError(null);
    try {
      await api.postForm<Avatar>(`${base}/scene-image`, form);
      await refresh();
      setStatus("saved");
    } catch (err) {
      setError(refusal(err));
      setStatus("error");
    } finally {
      setBusyImage(false);
    }
  };
  const removeImage = async () => {
    setBusyImage(true);
    setError(null);
    try {
      await api.delete<Avatar>(`${base}/scene-image`);
      await refresh();
      setStatus("saved");
    } catch (err) {
      setError(refusal(err));
      setStatus("error");
    } finally {
      setBusyImage(false);
    }
  };

  const words = zoomText(draft.zoom);
  const zoomWords = t(words.key, { percent: words.percent });
  const preset = zoomPreset(draft.zoom);
  const dirty = !sameScene(draft, saved);
  const kinds: Segment<BackgroundKind>[] = [
    { value: "transparent", label: t("sceneBgTransparent") },
    { value: "color", label: t("sceneBgColor") },
    { value: "image", label: t("sceneBgImage") },
  ];
  return (
    <section aria-label={t("sceneTitle")}>
      <p className="mb-4 text-xs leading-relaxed text-gray-500 dark:text-gray-400">{t("sceneIntro")}</p>

      <div className="mb-4">
        <Slider
          id="scene-zoom"
          label={t("sceneZoom")}
          readout={zoomWords}
          readoutClassName="font-normal tabular-nums text-gray-500 dark:text-gray-400"
          min={ZOOM_FULL}
          max={ZOOM_MAX}
          step={ZOOM_STEP}
          value={draft.zoom}
          aria-valuetext={zoomWords}
          onChange={setZoom}
        />
        <div className="mt-2 flex flex-wrap gap-2">
          <Button variant="secondary" size="lg" aria-pressed={preset === "face"} onClick={() => setZoom(ZOOM_FACE)}>
            {t("sceneZoomFace")}
          </Button>
          <Button variant="secondary" size="lg" aria-pressed={preset === "full"} onClick={() => setZoom(ZOOM_FULL)}>
            {t("sceneZoomFull")}
          </Button>
          <Button
            variant="secondary"
            size="lg"
            icon="undo"
            onClick={reset}
            disabled={!dirty && preset === "face" && draft.pan.x === 0 && draft.pan.y === 0}
          >
            {t("sceneReset")}
          </Button>
        </div>
      </div>

      <div className="mb-4">
        <p className="label" id="scene-pan-label">
          {t("scenePan")}
        </p>
        <p className="mb-2 text-xs leading-relaxed text-gray-500 dark:text-gray-400">
          {t(dragPans ? "scenePanHint" : "scenePanHintTouch")}
        </p>
        <PanPad pan={draft.pan} labelledBy="scene-pan-label" onKey={onPadKey} onNudge={nudge} />
      </div>

      <div>
        <p className="label" id="scene-bg-label">
          {t("sceneBackground")}
        </p>
        {/* The arrows move the focus only: choosing Picture with none yet
            opens the file picker, which an arrow key must not do. */}
        <SegmentedControl
          look="outline"
          labelledBy="scene-bg-label"
          options={kinds}
          value={draft.background.kind}
          onChange={chooseKind}
          selectOnMove={false}
        />
        {!cutOut && (
          <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-amber-300/70 p-2.5 dark:border-amber-500/40">
            {/* A basis, so a narrow column puts the button under the words
                rather than the words in a column beside the button. */}
            <p className="min-w-0 flex-1 basis-52 text-xs leading-relaxed text-gray-700 dark:text-gray-200">
              {t("sceneOpaqueHint")}
            </p>
            <Button
              variant="secondary"
              size="lg"
              icon="eraser"
              loading={busyBackground}
              onClick={() => void onRemoveBackground()}
            >
              {t("sceneOpaqueAction")}
            </Button>
          </div>
        )}
        {draft.background.kind === "color" && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {SWATCHES.map((swatch) => (
              <ColorSwatch
                key={swatch.hex}
                color={swatch.hex}
                label={t(swatch.nameKey)}
                selected={draft.background.color === swatch.hex}
                onClick={() => chooseColor(swatch.hex)}
              />
            ))}
            <label className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-300">
              <ColorInput
                value={draft.background.color ?? DEFAULT_COLOR}
                onChange={(event) => chooseColor(event.target.value)}
              />
              {t("sceneBgCustomColor")}
            </label>
          </div>
        )}
        <FileInput
          ref={fileRef}
          accept="image/jpeg,image/png,image/webp"
          onChange={(event) => {
            void upload(event.target.files?.[0]);
            event.target.value = "";
          }}
        />
        {(draft.background.kind === "image" || hasImage) && (
          <div className="mt-3 flex flex-wrap items-center gap-3">
            {hasImage && avatar.scene_image_url && (
              <img
                src={avatar.scene_image_url}
                alt={t("sceneBgImageAlt")}
                className="h-14 w-20 rounded-lg border border-gray-200 object-cover dark:border-line"
              />
            )}
            <Button variant="secondary" size="lg" loading={busyImage} onClick={() => fileRef.current?.click()}>
              {t(hasImage ? "sceneBgReplace" : "sceneBgUpload")}
            </Button>
            {hasImage && (
              <Button variant="secondary" size="lg" disabled={busyImage} onClick={() => void removeImage()}>
                {t("sceneBgRemove")}
              </Button>
            )}
          </div>
        )}
      </div>

      {error && (
        <p className="field-error mt-3 text-xs leading-relaxed" role="alert">
          {error}
        </p>
      )}
      <p className="sr-only" role="status" aria-live="polite">
        {status === "saved" ? t("sceneSaved") : status === "saving" ? t("sceneSaving") : ""}
      </p>
    </section>
  );
}
