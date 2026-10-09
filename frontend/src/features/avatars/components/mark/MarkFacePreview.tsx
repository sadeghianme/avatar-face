import type { AvatarEngine } from "@liveface/embed";
import { useState } from "react";

import { AvatarPreview } from "@/features/avatars/components/AvatarPreview";
import type { MarkFaceState } from "@/features/avatars/hooks/useMarkFace";
import { SpeakPanel } from "@/features/voices";
import { useT } from "@/i18n";
import type { Avatar } from "@/lib/types";

/**
 * Beside the photo: the rig the marks would make, talking (once Test was
 * pressed; until then, what Test does), with a Speak panel to try it.
 */
export function MarkFacePreview({
  avatar,
  orgId,
  imageUrl,
  marking,
}: {
  avatar: Avatar;
  orgId: string;
  imageUrl: string;
  marking: MarkFaceState;
}) {
  const { t } = useT();
  const [engine, setEngine] = useState<AvatarEngine | null>(null);
  return (
    <div>
      <p className="mb-2 text-xs font-medium text-gray-500">
        {t("testBeforeSave")}
        {marking.previewing && <span className="ml-2 font-normal">{t("markPreviewUpdating")}</span>}
      </p>
      {marking.previewUrl ? (
        <>
          <AvatarPreview
            rigUrl={marking.previewUrl}
            textureUrl={imageUrl}
            faceType={avatar.face_type}
            size={280}
            onEngine={setEngine}
          />
          <div className="mt-3">
            <SpeakPanel engine={engine} orgId={orgId} />
          </div>
        </>
      ) : (
        <div
          className="flex h-[280px] items-center justify-center rounded-xl border border-dashed
          border-gray-300 text-center text-xs text-gray-500 dark:border-line"
        >
          {t("testHint")}
        </div>
      )}
    </div>
  );
}
