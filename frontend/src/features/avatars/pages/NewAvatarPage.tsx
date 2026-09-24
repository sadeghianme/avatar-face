import { useParams } from "react-router-dom";

import { CreationWizard } from "@/features/avatars/components/create/CreationWizard";
import { OtherWays } from "@/features/avatars/components/create/OtherWays";
import { useOrg } from "@/providers/org";

/**
 * /avatars/new and /avatars/new/:creationId.
 *
 * A photo goes through the creation wizard, and the creation's id is in the
 * URL from the moment the upload is accepted, so a reload resumes it. The
 * other ways to make an avatar (AI generation, stock, 3D) sit under the
 * wizard's first screen; once a photo is on its way they would only be a
 * distraction, so they leave with the drop zone.
 */
export function NewAvatarPage() {
  const { current } = useOrg();
  const { creationId } = useParams();
  if (!current) return null;
  return (
    <div className="mx-auto max-w-5xl">
      {/* Keyed by the creation: a new upload is a new wizard, not the old
          one's state carried over. */}
      <CreationWizard key={creationId ?? "new"} orgId={current.id} creationId={creationId} />
      {!creationId && <OtherWays orgId={current.id} />}
    </div>
  );
}
