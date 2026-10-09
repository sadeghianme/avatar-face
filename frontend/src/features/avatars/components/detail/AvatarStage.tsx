import type { SpeechPlayer } from "@liveface/embed";
import type { RefObject } from "react";

import { Card } from "@/components/ui/Card";
import { IconButton } from "@/components/ui/IconButton";
import { Avatar3DPreview } from "@/features/avatars/components/Avatar3DPreview";
import { AvatarPreview } from "@/features/avatars/components/AvatarPreview";
import { CropStudio } from "@/features/avatars/components/CropStudio";
import { engineScene, type SceneDraft, sceneOf } from "@/features/avatars/scene";
import { useT } from "@/i18n";
import { cx } from "@/lib/cx";
import type { Avatar } from "@/lib/types";

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
 * The stage: the avatar, and nothing under it. A square, the shape
 * visitors get, as wide as its column; on a wide screen no taller than the
 * window leaves under the page head (a wide, short window gets a
 * landscape stage with the square inside), and stuck there while the
 * settings scroll. In one column (a phone, a tablet upright) it is capped
 * too, so Speak is not a screen away: at most 55% of an upright window (a
 * 768px tablet would otherwise get a 736px square), and the window under
 * the header on a phone on its side; the square is then centred
 * (max-height carries to the width through the aspect ratio). The crop
 * studio takes the room it needs instead.
 *
 * The scene (zoom, pan, background) is a property of the avatar, not a
 * local view preference: it is what embedding sites render, so editing it
 * in the Framing & scene panel changes what visitors to those sites see,
 * once published. The stage shows the edit as it is made (`scene`).
 */
export function AvatarStage({
  avatar,
  orgId,
  stageRef,
  cropping,
  onCropClose,
  scene,
  debugMesh,
  onEngine,
  fullscreen,
}: {
  avatar: Avatar;
  orgId: string;
  stageRef: RefObject<HTMLDivElement>;
  cropping: boolean;
  onCropClose: () => void;
  /** The scene being edited; null: the saved one. */
  scene: SceneDraft | null;
  debugMesh: boolean;
  onEngine: (engine: SpeechPlayer | null) => void;
  fullscreen: { expanded: boolean; covering: boolean; toggle: () => void };
}) {
  const { t } = useT();
  const { expanded, covering } = fullscreen;
  return (
    <Card
      ref={stageRef}
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
          onClick={fullscreen.toggle}
          className={cx(
            "absolute end-3 z-10 h-10 w-10",
            covering ? "top-[calc(0.75rem+env(safe-area-inset-top))]" : "top-3"
          )}
        />
      )}
      {cropping ? (
        <CropStudio avatar={avatar} orgId={orgId} onCancel={onCropClose} onDone={onCropClose} />
      ) : avatar.kind === "model3d" && avatar.model_url ? (
        <Avatar3DPreview modelUrl={avatar.model_url} fit="box" onEngine={onEngine} />
      ) : (
        <AvatarPreview
          rigUrl={avatar.rig_url!}
          // Full-resolution texture: the 256px thumbnail looks blurry
          // on a large preview canvas.
          textureUrl={avatar.image_url ?? avatar.thumbnail_url!}
          layerUrls={avatar.layer_urls}
          faceType={avatar.face_type}
          // The stage is most of a window: a 720-point square (1440
          // device pixels on a 2× screen) keeps the teeth sharp.
          size={720}
          debugMesh={debugMesh}
          scene={engineScene(scene ?? sceneOf(avatar), avatar.scene_image_url)}
          soft
          fit="box"
          onEngine={onEngine}
        />
      )}
    </Card>
  );
}
