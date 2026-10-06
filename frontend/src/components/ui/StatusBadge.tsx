import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { useT } from "@/i18n";
import type { AvatarStatus } from "@/lib/types";

const TONE: Record<AvatarStatus, BadgeTone> = {
  pending: "neutral",
  processing: "warning",
  ready: "success",
  failed: "danger",
};

/** An avatar's build state, in words and its colour. */
export function StatusBadge({ status }: { status: AvatarStatus }) {
  const { t } = useT();
  return <Badge tone={TONE[status]}>{t(`status.${status}`)}</Badge>;
}
