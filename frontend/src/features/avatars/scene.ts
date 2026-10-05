import type { Scene as EngineScene } from "@liveface/embed";

/**
 * The scene an avatar is shown in (the Framing & scene panel): how far in,
 * where, and on what. The numbers the engine's viewport takes (embed
 * viewport.ts), as the owner edits them and the API stores them.
 */

/** Zoom 1 is the face view, 0 the whole picture, up to ZOOM_MAX closer in. */
export const ZOOM_MAX = 1.3;
export const ZOOM_FACE = 1;
export const ZOOM_FULL = 0;
export const ZOOM_STEP = 0.01;
/** A keyboard arrow moves the view by this fraction of the canvas; with
 *  Shift, four times as far. */
export const PAN_STEP = 0.05;
export const PAN_MAX = 1;

export type BackgroundKind = "transparent" | "color" | "image";

export interface SceneDraft {
  zoom: number;
  pan: { x: number; y: number };
  background: { kind: BackgroundKind; color?: string };
}

/** What the saved scene says, as the API returns it. */
export interface SavedScene {
  zoom: number;
  pan: { x: number; y: number };
  background: { kind: BackgroundKind; color?: string; has_image: boolean };
}

/** Eight backgrounds that sit well under a cut-out: paper whites, a soft
 *  grey, charcoal, and four deep brand-friendly tones. */
export const SWATCHES: readonly { hex: string; nameKey: string }[] = [
  { hex: "#ffffff", nameKey: "sceneSwatchWhite" },
  { hex: "#f4f4f5", nameKey: "sceneSwatchPaper" },
  { hex: "#d6d3d1", nameKey: "sceneSwatchStone" },
  { hex: "#1f2937", nameKey: "sceneSwatchCharcoal" },
  { hex: "#1e3a8a", nameKey: "sceneSwatchNavy" },
  { hex: "#0f766e", nameKey: "sceneSwatchTeal" },
  { hex: "#b45309", nameKey: "sceneSwatchAmber" },
  { hex: "#be123c", nameKey: "sceneSwatchRose" },
];

export const DEFAULT_COLOR = SWATCHES[4].hex;

const clamp = (v: number, lo: number, hi: number) => (Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : lo);
const round3 = (v: number) => Math.round(v * 1000) / 1000;

/** The scene an avatar renders by: its own, or, for one made before
 *  scenes existed, its framing (face is zoom 1, full 0, nothing behind). */
export function sceneOf(avatar: { scene?: SavedScene | null; framing?: "face" | "full" } | null | undefined): SceneDraft {
  const saved = avatar?.scene;
  if (saved) {
    return clampScene({
      zoom: saved.zoom,
      pan: { x: saved.pan?.x ?? 0, y: saved.pan?.y ?? 0 },
      background: { kind: saved.background?.kind ?? "transparent", color: saved.background?.color },
    });
  }
  return { zoom: avatar?.framing === "full" ? ZOOM_FULL : ZOOM_FACE, pan: { x: 0, y: 0 }, background: { kind: "transparent" } };
}

/** Within the ranges the API accepts, rounded so a drag does not save a
 *  dozen decimals. */
export function clampScene(scene: SceneDraft): SceneDraft {
  const background: SceneDraft["background"] = { kind: scene.background?.kind ?? "transparent" };
  if (background.kind === "color") background.color = normalizeHex(scene.background.color) ?? DEFAULT_COLOR;
  return {
    zoom: round3(clamp(scene.zoom, ZOOM_FULL, ZOOM_MAX)),
    pan: { x: round3(clamp(scene.pan?.x ?? 0, -PAN_MAX, PAN_MAX)), y: round3(clamp(scene.pan?.y ?? 0, -PAN_MAX, PAN_MAX)) },
    background,
  };
}

/** "#rrggbb" in lower case, or null for anything else. */
export function normalizeHex(value: string | null | undefined): string | null {
  if (!value) return null;
  const hex = value.trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(hex) ? hex : null;
}

export function sameScene(a: SceneDraft, b: SceneDraft): boolean {
  return a.zoom === b.zoom && a.pan.x === b.pan.x && a.pan.y === b.pan.y &&
    a.background.kind === b.background.kind && (a.background.color ?? null) === (b.background.color ?? null);
}

/** The scene as the engine takes it: the background picture by its URL. */
export function engineScene(draft: SceneDraft, imageUrl: string | null | undefined): EngineScene {
  const background: EngineScene["background"] =
    draft.background.kind === "image"
      ? imageUrl ? { kind: "image", image_url: imageUrl } : { kind: "transparent" }
      : draft.background.kind === "color"
        ? { kind: "color", color: draft.background.color ?? DEFAULT_COLOR }
        : { kind: "transparent" };
  return { zoom: draft.zoom, pan: { ...draft.pan }, background };
}

/** Which preset a zoom is at, if any. */
export function zoomPreset(zoom: number): "face" | "full" | null {
  if (Math.abs(zoom - ZOOM_FACE) < 0.005) return "face";
  if (zoom < 0.005) return "full";
  return null;
}

/** The zoom in words, for the slider's aria-valuetext and its readout: a
 *  percentage of the face view (the engine draws 1.3 at 160%). */
export function zoomText(zoom: number): { key: "sceneZoomFaceValue" | "sceneZoomFullValue" | "sceneZoomPercent"; percent: number } {
  const preset = zoomPreset(zoom);
  const percent = Math.round(zoom <= 1 ? zoom * 100 : 100 + (zoom - 1) * 200);
  if (preset === "face") return { key: "sceneZoomFaceValue", percent };
  if (preset === "full") return { key: "sceneZoomFullValue", percent };
  return { key: "sceneZoomPercent", percent };
}

/** The pan moved by a drag of (dx, dy) across a surface of (width, height)
 *  px: dragging the picture right moves the view left. */
export function panned(pan: { x: number; y: number }, dx: number, dy: number, width: number, height: number): { x: number; y: number } {
  if (!(width > 0) || !(height > 0)) return pan;
  return {
    x: round3(clamp(pan.x - dx / width, -PAN_MAX, PAN_MAX)),
    y: round3(clamp(pan.y - dy / height, -PAN_MAX, PAN_MAX)),
  };
}

/** The pan after an arrow key: the view moves the way the arrow points. */
export function panStepped(pan: { x: number; y: number }, key: string, big: boolean): { x: number; y: number } | null {
  const step = big ? PAN_STEP * 4 : PAN_STEP;
  const moves: Record<string, [number, number]> = {
    ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step],
  };
  const move = moves[key];
  if (!move) return null;
  return { x: round3(clamp(pan.x + move[0], -PAN_MAX, PAN_MAX)), y: round3(clamp(pan.y + move[1], -PAN_MAX, PAN_MAX)) };
}

/** Whether the picture is a cut-out: only then does a background show. */
export function isCutOut(avatar: { original_image_key?: string | null } | null | undefined): boolean {
  return Boolean(avatar?.original_image_key);
}

/** The panel's own words for a refused request, by the API's code. */
export function sceneErrorKey(code: string | undefined): string | null {
  switch (code) {
    case "unsupported_image_type": return "sceneErrImageType";
    case "image_too_large": return "sceneErrImageLarge";
    case "scene_image_invalid": return "sceneErrImageInvalid";
    case "scene_image_missing": return "sceneErrImageMissing";
    case "not_a_photo": return "sceneErrNotPhoto";
    default: return null;
  }
}
