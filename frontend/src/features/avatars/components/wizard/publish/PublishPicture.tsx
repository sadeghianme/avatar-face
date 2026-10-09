import { Icon } from "@/components/ui/Icon";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Spinner } from "@/components/ui/Spinner";
import { AvatarPreview } from "@/features/avatars/components/AvatarPreview";
import { MarkCanvas } from "@/features/avatars/components/MarkCanvas";
import { PICTURE_BACKDROP } from "@/features/avatars/components/wizard/Art";
import { PUBLISH_VIEWS, type PublishEditorState } from "@/features/avatars/hooks/usePublishEditor";
import { useT } from "@/i18n";
import { cx } from "@/lib/cx";
import type { FaceType } from "@/lib/types";

/**
 * The picture, big: its points to drag (MarkCanvas, with its 3x zoom in the
 * corner) or the talking preview, the rig Publish would build. Two
 * canvases that cannot be one, so a toggle above picks Points or Talking
 * preview; the preview keeps running while the points show, so Play needs
 * no wait. As large as the viewport allows: its height fits between the
 * bars, its width follows its shape.
 */
export function PublishPicture({
  editor,
  texture,
  imageSize,
  faceType,
}: {
  editor: PublishEditorState;
  texture: string;
  imageSize: [number, number];
  /** The creation's face type: the preview moves its head as visitors see it. */
  faceType?: FaceType | null;
}) {
  const { t } = useT();
  const [imgW, imgH] = imageSize;
  const ratio = imgW / Math.max(1, imgH);
  const fit = { maxWidth: `max(${Math.round(300 * ratio)}px, min(100%, calc((100dvh - 27.5rem) * ${ratio})))` };

  return (
    <div className="mx-auto" style={fit}>
      <div className="mb-3 flex justify-center">
        <SegmentedControl
          look="raised"
          label={t("wzViewLabel")}
          options={PUBLISH_VIEWS.map((v) => ({
            value: v,
            label: (
              <>
                <Icon name={v === "points" ? "target" : "speaker"} className="h-4 w-4" />
                {t(`wzView_${v}`)}
              </>
            ),
          }))}
          value={editor.view}
          onChange={editor.setView}
        />
      </div>

      {editor.view === "points" && texture && (
        <div className="overflow-hidden rounded-3xl border border-gray-200 dark:border-line [&>div]:rounded-none">
          <MarkCanvas imageUrl={texture} imageSize={imageSize} marks={editor.marks} onChange={editor.setMarks} />
        </div>
      )}
      {/* Kept running while the points show, so Play needs no wait. */}
      <div className={editor.view === "preview" ? "" : "hidden"}>
        <div
          className={cx(
            "relative overflow-hidden rounded-3xl border border-gray-200 dark:border-line",
            PICTURE_BACKDROP,
            // The canvas as tall as the screen leaves, its width following.
            "[&_canvas]:block [&_canvas]:max-h-[max(300px,calc(100dvh-27.5rem))] [&_canvas]:max-w-full [&_canvas]:!w-auto"
          )}
        >
          {editor.rigUrl && texture ? (
            <AvatarPreview
              rigUrl={editor.rigUrl}
              textureUrl={texture}
              faceType={faceType}
              size={640}
              soft
              onEngine={editor.setEngine}
            />
          ) : (
            <div className="grid aspect-square place-items-center p-6 text-center text-sm text-gray-500 dark:text-gray-400">
              {editor.previewError ?? (
                <span className="flex items-center gap-2">
                  <Spinner className="h-5 w-5 text-brand-600" /> {t("wzPreviewLoading")}
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
