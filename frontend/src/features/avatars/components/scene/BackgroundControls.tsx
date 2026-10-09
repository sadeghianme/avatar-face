import { Button } from "@/components/ui/Button";
import { ColorInput } from "@/components/ui/ColorInput";
import { ColorSwatch } from "@/components/ui/ColorSwatch";
import { FileInput } from "@/components/ui/FileInput";
import { Label } from "@/components/ui/Label";
import { type Segment, SegmentedControl } from "@/components/ui/SegmentedControl";
import type { SceneEditor } from "@/features/avatars/hooks/useSceneEditor";
import { type BackgroundKind, DEFAULT_COLOR, SWATCHES } from "@/features/avatars/scene";
import { useT } from "@/i18n";

/**
 * What is behind a cut-out: nothing, a colour (swatches and a custom one)
 * or a picture (uploaded, replaced, removed). A photo that kept its own
 * background is told so, with the page's background removal beside it.
 */
export function BackgroundControls({
  scene,
  imageUrl,
  onRemoveBackground,
  busyBackground,
}: {
  scene: SceneEditor;
  /** The background picture's signed URL, when there is one. */
  imageUrl: string | null | undefined;
  onRemoveBackground: () => Promise<void>;
  busyBackground: boolean;
}) {
  const { t } = useT();
  const { draft, hasImage, fileRef } = scene;
  const kinds: Segment<BackgroundKind>[] = [
    { value: "transparent", label: t("sceneBgTransparent") },
    { value: "color", label: t("sceneBgColor") },
    { value: "image", label: t("sceneBgImage") },
  ];
  return (
    <div>
      <Label as="p" id="scene-bg-label">
        {t("sceneBackground")}
      </Label>
      {/* The arrows move the focus only: choosing Picture with none yet
          opens the file picker, which an arrow key must not do. */}
      <SegmentedControl
        look="outline"
        labelledBy="scene-bg-label"
        options={kinds}
        value={draft.background.kind}
        onChange={scene.chooseKind}
        selectOnMove={false}
      />
      {!scene.cutOut && (
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
              onClick={() => scene.chooseColor(swatch.hex)}
            />
          ))}
          <Label look="plain" className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-300">
            <ColorInput
              value={draft.background.color ?? DEFAULT_COLOR}
              onChange={(event) => scene.chooseColor(event.target.value)}
            />
            {t("sceneBgCustomColor")}
          </Label>
        </div>
      )}
      <FileInput
        ref={fileRef}
        accept="image/jpeg,image/png,image/webp"
        onChange={(event) => {
          scene.upload(event.target.files?.[0]);
          event.target.value = "";
        }}
      />
      {(draft.background.kind === "image" || hasImage) && (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          {hasImage && imageUrl && (
            <img
              src={imageUrl}
              alt={t("sceneBgImageAlt")}
              className="h-14 w-20 rounded-lg border border-gray-200 object-cover dark:border-line"
            />
          )}
          <Button variant="secondary" size="lg" loading={scene.busyImage} onClick={() => fileRef.current?.click()}>
            {t(hasImage ? "sceneBgReplace" : "sceneBgUpload")}
          </Button>
          {hasImage && (
            <Button variant="secondary" size="lg" disabled={scene.busyImage} onClick={scene.removeImage}>
              {t("sceneBgRemove")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
