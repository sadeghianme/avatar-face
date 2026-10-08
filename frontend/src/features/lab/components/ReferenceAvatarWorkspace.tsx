import { useRef } from "react";

import { ReferenceCompare } from "@/features/lab/components/reference/ReferenceCompare";
import { ReferencePoseCard } from "@/features/lab/components/reference/ReferencePoseCard";
import { ReferenceSidebar } from "@/features/lab/components/reference/ReferenceSidebar";
import { ReferenceSpeechCard } from "@/features/lab/components/reference/ReferenceSpeechCard";
import { useReferenceWorkspace } from "@/features/lab/hooks/useReferenceWorkspace";
import type { Avatar } from "@/lib/types";

/**
 * The reference lab for one avatar: the baseline mouth and a candidate
 * side by side, posed or speaking one phrase on one clock, with the fit
 * profile and the speech to test beside them. The bench's state is
 * useReferenceWorkspace's; the cards draw it.
 */
export function ReferenceAvatarWorkspace({ avatar, orgId }: { avatar: Avatar; orgId: string }) {
  const bench = useReferenceWorkspace(avatar, orgId);
  const previews = useRef<HTMLElement>(null);
  return (
    <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
      <div className="space-y-5">
        <ReferencePoseCard bench={bench} />
        <ReferenceCompare avatar={avatar} bench={bench} previews={previews} />
        <ReferenceSpeechCard bench={bench} previews={previews} />
      </div>
      <ReferenceSidebar avatar={avatar} orgId={orgId} bench={bench} />
    </div>
  );
}
