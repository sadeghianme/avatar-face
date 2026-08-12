import { useState } from "react";

import { CropBox, type CropRect } from "./CropBox";
import { api } from "../lib/api";
import type { Avatar } from "../lib/types";

/**
 * Cropping an existing avatar, in its own preview.
 *
 * The interaction lives in CropBox, shared with the new-avatar flow. This is
 * only the part that differs: what a crop means for a saved avatar, which is
 * a server call that also has to move the rig with the image.
 */
export function CropStudio({
  avatar,
  orgId,
  onDone,
  onCancel,
}: {
  avatar: Avatar;
  orgId: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apply = async (rect: CropRect) => {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/orgs/${orgId}/avatars/${avatar.id}/crop`, {
        x: rect.x,
        y: rect.y,
        width: rect.w,
        height: rect.h,
      });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div>
      <CropBox
        src={avatar.image_url ?? avatar.thumbnail_url ?? ""}
        busy={busy}
        onApply={(rect) => void apply(rect)}
        onCancel={onCancel}
      />
      {error && <p className="field-error mt-2">{error}</p>}
    </div>
  );
}
