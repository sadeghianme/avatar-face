import type { RefObject } from "react";

import { FieldError } from "@/components/ui/FieldError";
import { Label } from "@/components/ui/Label";
import { PanPad } from "@/features/avatars/components/PanPad";
import { BackgroundControls } from "@/features/avatars/components/scene/BackgroundControls";
import { ZoomControls } from "@/features/avatars/components/scene/ZoomControls";
import { useDragPan } from "@/features/avatars/hooks/useDragPan";
import { useSceneEditor } from "@/features/avatars/hooks/useSceneEditor";
import type { SceneDraft } from "@/features/avatars/scene";
import { useT } from "@/i18n";
import type { Avatar } from "@/lib/types";
import { TOUCH_ONE_COLUMN, useMediaQuery } from "@/lib/useMediaQuery";

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
 * offers the existing removal rather than hiding the option. The draft and
 * its saving are useSceneEditor's, the drag useDragPan's.
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
  const { t } = useT();
  const scene = useSceneEditor(avatar, orgId, onPreview);
  // On a phone or an upright tablet the preview is most of the screen and
  // above this panel, not beside it: a swipe on it scrolls the page (it
  // used to pan the picture, a draft change made by trying to scroll).
  // The position pad moves it there; a drag still pans beside the panel.
  const touchColumn = useMediaQuery(TOUCH_ONE_COLUMN);
  const dragPans = active && !touchColumn;
  // Read at render, so a remounted preview box gets the listeners again.
  useDragPan(surfaceRef.current, dragPans, scene.draftRef, scene.change);

  return (
    <section aria-label={t("sceneTitle")}>
      <p className="mb-4 text-xs leading-relaxed text-gray-500 dark:text-gray-400">{t("sceneIntro")}</p>

      <ZoomControls scene={scene} />

      <div className="mb-4">
        <Label as="p" id="scene-pan-label">
          {t("scenePan")}
        </Label>
        <p className="mb-2 text-xs leading-relaxed text-gray-500 dark:text-gray-400">
          {t(dragPans ? "scenePanHint" : "scenePanHintTouch")}
        </p>
        <PanPad
          pan={scene.draft.pan}
          labelledBy="scene-pan-label"
          onKey={(e) => {
            if (scene.panKey(e.key, e.shiftKey)) e.preventDefault();
          }}
          onNudge={(key) => scene.panKey(key, false)}
        />
      </div>

      <BackgroundControls
        scene={scene}
        imageUrl={avatar.scene_image_url}
        onRemoveBackground={onRemoveBackground}
        busyBackground={busyBackground}
      />

      {scene.error && <FieldError className="mt-3 text-xs leading-relaxed">{scene.error}</FieldError>}
      <p className="sr-only" role="status" aria-live="polite">
        {scene.status === "saved" ? t("sceneSaved") : scene.status === "saving" ? t("sceneSaving") : ""}
      </p>
    </section>
  );
}
