import { useParams, useSearchParams } from "react-router-dom";

import { OtherWays } from "@/features/avatars/components/create/OtherWays";
import { NewWizard } from "@/features/avatars/components/wizard/NewWizard";
import { useOrg } from "@/providers/org";

/**
 * /avatars/new and /avatars/new/:creationId: the creation wizard,
 * 1 Model · 2 Photo · 3 Prepare · 4 Publish (NewWizard).
 *
 * The other ways to add an avatar (stock, 3D) are folded under the first
 * step only; once a model is chosen they would be a distraction.
 */
export function NewAvatarPage() {
  const { current } = useOrg();
  const { creationId } = useParams();
  const [params] = useSearchParams();
  if (!current) return null;
  return (
    <div>
      {/* Keyed by the creation: a new one is a new wizard, not the old
          one's state carried over. */}
      <NewWizard key={creationId ?? "new"} orgId={current.id} creationId={creationId} />
      {!creationId && !params.get("model") && <OtherWays orgId={current.id} />}
    </div>
  );
}
