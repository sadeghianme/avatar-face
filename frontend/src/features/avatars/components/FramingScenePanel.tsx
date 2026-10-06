import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "@/components/ui/Icon";
import { Spinner } from "@/components/ui/Spinner";
import { api, ApiError } from "@/lib/api";
import type { Avatar } from "@/lib/types";
import { TOUCH_ONE_COLUMN, useMediaQuery } from "@/lib/useMediaQuery";
import {
  clampScene, DEFAULT_COLOR, isCutOut, panned, panStepped, sameScene, sceneErrorKey, sceneOf, SWATCHES,
  ZOOM_FACE, ZOOM_FULL, ZOOM_MAX, ZOOM_STEP, zoomPreset, zoomText, type BackgroundKind, type SceneDraft,
} from "@/features/avatars/scene";

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
  embedded = false,
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
  /** Inside a section that carries the title: no card, no heading of its own. */
  embedded?: boolean;
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

  // Re-seed when the server's copy changes under us (publish, discard, an
  // upload), unless a save of a newer draft is still on its way.
  useEffect(() => {
    if (timer.current !== null) return;
    const next = sceneOf(avatar);
    draftRef.current = next;
    setDraft(next);
    onPreview(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
          background: scene.background.kind === "color"
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
  useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current); }, []);

  // Dragging the preview pans. Pointer events, captured, so a drag that
  // leaves the box still ends cleanly; a frame at a time, so a fast drag
  // does not rebuild the viewport more often than it can be drawn.
  useEffect(() => {
    const el = surfaceRef.current;
    if (!el || !dragPans) return;
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
      try { el.releasePointerCapture(e.pointerId); } catch { /* already released */ }
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [avatar.id, surfaceRef.current, dragPans]);

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
    change({ ...draft, background: kind === "color" ? { kind, color: draft.background.color ?? DEFAULT_COLOR } : { kind } });
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
  const kinds: { kind: BackgroundKind; key: string }[] = [
    { kind: "transparent", key: "sceneBgTransparent" },
    { kind: "color", key: "sceneBgColor" },
    { kind: "image", key: "sceneBgImage" },
  ];

  return (
    <section className={embedded ? "" : "card"} aria-labelledby={embedded ? undefined : "scene-title"} aria-label={embedded ? t("sceneTitle") : undefined}>
      {!embedded && (
        <h2 id="scene-title" className="mb-1 text-base font-semibold">{t("sceneTitle")}</h2>
      )}
      <p className="mb-4 text-xs leading-relaxed text-gray-500 dark:text-gray-400">{t("sceneIntro")}</p>

      <div className="mb-4">
        <label className="label flex justify-between gap-2" htmlFor="scene-zoom">
          <span>{t("sceneZoom")}</span>
          <span className="font-normal tabular-nums text-gray-500 dark:text-gray-400">{zoomWords}</span>
        </label>
        <input
          id="scene-zoom"
          type="range"
          className="w-full accent-orange-500"
          min={ZOOM_FULL}
          max={ZOOM_MAX}
          step={ZOOM_STEP}
          value={draft.zoom}
          aria-valuetext={zoomWords}
          onChange={(event) => setZoom(Number(event.target.value))}
        />
        <div className="mt-2 flex flex-wrap gap-2">
          <button type="button" className="btn-secondary min-h-11" aria-pressed={preset === "face"} onClick={() => setZoom(ZOOM_FACE)}>
            {t("sceneZoomFace")}
          </button>
          <button type="button" className="btn-secondary min-h-11" aria-pressed={preset === "full"} onClick={() => setZoom(ZOOM_FULL)}>
            {t("sceneZoomFull")}
          </button>
          <button type="button" className="btn-secondary min-h-11" onClick={reset} disabled={!dirty && preset === "face" && draft.pan.x === 0 && draft.pan.y === 0}>
            <Icon name="undo" className="me-1.5 inline h-4 w-4" />
            {t("sceneReset")}
          </button>
        </div>
      </div>

      <div className="mb-4">
        <p className="label" id="scene-pan-label">{t("scenePan")}</p>
        <p className="mb-2 text-xs leading-relaxed text-gray-500 dark:text-gray-400">{t(dragPans ? "scenePanHint" : "scenePanHintTouch")}</p>
        <div
          role="group"
          aria-labelledby="scene-pan-label"
          aria-describedby="scene-pan-value"
          tabIndex={0}
          onKeyDown={onPadKey}
          className="inline-grid grid-cols-3 gap-1 rounded-xl border border-gray-200 p-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 dark:border-line"
        >
          <span />
          <button type="button" className="btn-secondary min-h-11 min-w-11 px-0" aria-label={t("scenePanUp")} onClick={() => nudge("ArrowUp")}>↑</button>
          <span />
          <button type="button" className="btn-secondary min-h-11 min-w-11 px-0" aria-label={t("scenePanLeft")} onClick={() => nudge("ArrowLeft")}>←</button>
          <span id="scene-pan-value" className="grid place-items-center font-mono text-[11px] tabular-nums text-gray-500 dark:text-gray-400">
            {draft.pan.x.toFixed(2)}, {draft.pan.y.toFixed(2)}
          </span>
          <button type="button" className="btn-secondary min-h-11 min-w-11 px-0" aria-label={t("scenePanRight")} onClick={() => nudge("ArrowRight")}>→</button>
          <span />
          <button type="button" className="btn-secondary min-h-11 min-w-11 px-0" aria-label={t("scenePanDown")} onClick={() => nudge("ArrowDown")}>↓</button>
          <span />
        </div>
      </div>

      <div>
        <p className="label" id="scene-bg-label">{t("sceneBackground")}</p>
        <div role="radiogroup" aria-labelledby="scene-bg-label" className="flex flex-wrap gap-2">
          {kinds.map(({ kind, key }) => (
            <button
              key={kind}
              type="button"
              role="radio"
              aria-checked={draft.background.kind === kind}
              className={`min-h-11 rounded-lg border px-3 text-sm font-medium ${
                draft.background.kind === kind
                  ? "border-brand-600 bg-brand-600 text-white"
                  : "border-gray-300 bg-white text-gray-700 dark:border-line dark:bg-panel dark:text-gray-200"
              }`}
              onClick={() => chooseKind(kind)}
            >
              {t(key)}
            </button>
          ))}
        </div>
        {!cutOut && (
          <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-amber-300/70 p-2.5 dark:border-amber-500/40">
            {/* A basis, so a narrow column puts the button under the words
                rather than the words in a column beside the button. */}
            <p className="min-w-0 flex-1 basis-52 text-xs leading-relaxed text-gray-700 dark:text-gray-200">{t("sceneOpaqueHint")}</p>
            <button type="button" className="btn-secondary min-h-11" disabled={busyBackground} onClick={() => void onRemoveBackground()}>
              {busyBackground ? <Spinner className="h-4 w-4" /> : <Icon name="eraser" className="me-1.5 inline h-4 w-4" />}
              {t("sceneOpaqueAction")}
            </button>
          </div>
        )}
        {draft.background.kind === "color" && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {SWATCHES.map((swatch) => (
              <button
                key={swatch.hex}
                type="button"
                aria-label={t(swatch.nameKey)}
                aria-pressed={draft.background.color === swatch.hex}
                className={`h-9 w-9 rounded-full border-2 ${
                  draft.background.color === swatch.hex ? "border-brand-600 ring-2 ring-brand-300" : "border-gray-300 dark:border-line"
                }`}
                style={{ backgroundColor: swatch.hex }}
                onClick={() => chooseColor(swatch.hex)}
              />
            ))}
            <label className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-300">
              <input
                type="color"
                className="h-9 w-12 cursor-pointer rounded border border-gray-300 bg-transparent p-0.5 dark:border-line"
                value={draft.background.color ?? DEFAULT_COLOR}
                onChange={(event) => chooseColor(event.target.value)}
              />
              {t("sceneBgCustomColor")}
            </label>
          </div>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="hidden"
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
            <button type="button" className="btn-secondary min-h-11" disabled={busyImage} onClick={() => fileRef.current?.click()}>
              {busyImage ? <Spinner className="h-4 w-4" /> : null}
              {t(hasImage ? "sceneBgReplace" : "sceneBgUpload")}
            </button>
            {hasImage && (
              <button type="button" className="btn-secondary min-h-11" disabled={busyImage} onClick={() => void removeImage()}>
                {t("sceneBgRemove")}
              </button>
            )}
          </div>
        )}
      </div>

      {error && (
        <p className="field-error mt-3 text-xs leading-relaxed" role="alert">{error}</p>
      )}
      <p className="sr-only" role="status" aria-live="polite">
        {status === "saved" ? t("sceneSaved") : status === "saving" ? t("sceneSaving") : ""}
      </p>
    </section>
  );
}
