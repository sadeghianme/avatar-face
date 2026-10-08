import { Button } from "@/components/ui/Button";
import { Slider } from "@/components/ui/Slider";
import type { SceneEditor } from "@/features/avatars/hooks/useSceneEditor";
import { ZOOM_FACE, ZOOM_FULL, ZOOM_MAX, ZOOM_STEP } from "@/features/avatars/scene";
import { useT } from "@/i18n";

/** How close the avatar is shown: a range with its value in words, the two presets, and Reset. */
export function ZoomControls({ scene }: { scene: SceneEditor }) {
  const { t } = useT();
  const { draft, preset } = scene;
  return (
    <div className="mb-4">
      <Slider
        id="scene-zoom"
        label={t("sceneZoom")}
        readout={scene.zoomWords}
        readoutClassName="font-normal tabular-nums text-gray-500 dark:text-gray-400"
        min={ZOOM_FULL}
        max={ZOOM_MAX}
        step={ZOOM_STEP}
        value={draft.zoom}
        aria-valuetext={scene.zoomWords}
        onChange={scene.setZoom}
      />
      <div className="mt-2 flex flex-wrap gap-2">
        <Button variant="secondary" size="lg" aria-pressed={preset === "face"} onClick={() => scene.setZoom(ZOOM_FACE)}>
          {t("sceneZoomFace")}
        </Button>
        <Button variant="secondary" size="lg" aria-pressed={preset === "full"} onClick={() => scene.setZoom(ZOOM_FULL)}>
          {t("sceneZoomFull")}
        </Button>
        <Button
          variant="secondary"
          size="lg"
          icon="undo"
          onClick={scene.reset}
          disabled={!scene.dirty && preset === "face" && draft.pan.x === 0 && draft.pan.y === 0}
        >
          {t("sceneReset")}
        </Button>
      </div>
    </div>
  );
}
