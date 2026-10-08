import { type CSSProperties, useRef } from "react";

import { FieldError } from "@/components/ui/FieldError";
import { AvatarPageHead } from "@/features/avatars/components/AvatarPageHead";
import { AvatarStage } from "@/features/avatars/components/detail/AvatarStage";
import { BuildNotices } from "@/features/avatars/components/detail/BuildNotices";
import { SettingsColumn } from "@/features/avatars/components/detail/SettingsColumn";
import { MarkFacePanel } from "@/features/avatars/components/MarkFacePanel";
import { useAvatarDetail } from "@/features/avatars/hooks/useAvatarDetail";
import { useMeasuredHeight } from "@/features/avatars/hooks/useMeasuredHeight";
import { useOpenSections } from "@/features/avatars/hooks/useOpenSections";
import { useStageFullscreen } from "@/features/avatars/hooks/useStageFullscreen";
import { useT } from "@/i18n";

/**
 * The avatar's page: the avatar on the left, everything about it on the
 * right (docs/avatar-lines.md, "The avatar page"). The state and requests
 * are useAvatarDetail's; this lays them out.
 *
 * Three fifths of the width is the stage (AvatarStage): the avatar, sized
 * to the window and kept in view (sticky under the page head) while the
 * settings scroll beside it; nothing sits under it. Two fifths is the
 * settings column (SettingsColumn): the publish state first, then Speak,
 * then the settings in named groups. The page head — back, the name, the
 * status, what the AI did, and the actions on the picture — stays at the
 * top of the window too, so Mark the face, Test and Delete are one click
 * away from anywhere in the column. On a phone it is one column, the stage
 * first.
 */
export function AvatarDetailPage() {
  const { t } = useT();
  const page = useAvatarDetail();
  // The settings' folded sections, as the member left them.
  const sections = useOpenSections();
  // The page head's height, measured: the stage sticks just under it and
  // is sized to what the window has left, whether the head's row of
  // actions wraps or not.
  const head = useMeasuredHeight(76);
  // The stage, full screen or covering the window (useStageFullscreen).
  const stageRef = useRef<HTMLDivElement>(null);
  const fullscreen = useStageFullscreen(stageRef);
  const { avatar, org } = page;

  if (page.isError) {
    return <FieldError>{t("error")} — avatar not found in this organization.</FieldError>;
  }
  if (!avatar || !org) {
    return <p className="text-gray-500">{t("loading")}</p>;
  }

  const ready = avatar.status === "ready";
  const staged = ready && Boolean(avatar.rig_url && avatar.thumbnail_url);

  return (
    <div style={{ "--head-h": `${head.height}px` } as CSSProperties}>
      {/* On a wide screen the head stays under the shell's header while the
          settings scroll; the stage sticks under it (--head-h). */}
      <AvatarPageHead
        ref={head.ref}
        avatar={avatar}
        onRename={page.rename}
        editable={avatar.kind === "photo" && ready}
        adjusting={page.adjusting}
        onToggleAdjusting={() => page.toggleTool("adjusting")}
        cropping={page.cropping}
        onToggleCropping={() => page.toggleTool("cropping")}
        busyBackground={page.busyBackground}
        onToggleBackground={() => void page.toggleBackground()}
        onUndo={page.undo}
        deleting={page.deleting}
        onDelete={page.remove}
      />

      <BuildNotices avatar={avatar} onRetry={page.retry} retryError={page.retryError} />

      {page.adjusting && ready && (
        <div className="mb-4">
          <MarkFacePanel avatar={avatar} orgId={org.id} onClose={() => page.closeTool("adjusting")} />
        </div>
      )}

      {staged && (
        // Three fifths the stage, two fifths the settings; one column on a
        // phone, sized to the screen (minmax(0, …)): an implicit column
        // would grow to the embed snippet's longest line.
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <AvatarStage
            avatar={avatar}
            orgId={org.id}
            stageRef={stageRef}
            cropping={page.cropping}
            onCropClose={() => page.closeTool("cropping")}
            scene={page.preview.scene}
            debugMesh={page.preview.debugMesh}
            onEngine={page.setEngine}
            fullscreen={fullscreen}
          />
          <SettingsColumn avatar={avatar} org={org} page={page} sections={sections} stageRef={stageRef} />
        </div>
      )}
    </div>
  );
}
