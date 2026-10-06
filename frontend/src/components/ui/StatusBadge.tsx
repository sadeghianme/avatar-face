import { useTranslation } from "react-i18next";

import { Badge, type BadgeTone } from "@/components/ui/Badge";
import type { AvatarStatus } from "@/lib/types";

const TONE: Record<AvatarStatus, BadgeTone> = {
  pending: "neutral",
  processing: "warning",
  ready: "success",
  failed: "danger",
};

/** An avatar's build state, in words and its colour. */
export function StatusBadge({ status }: { status: AvatarStatus }) {
  const { t } = useTranslation();
  return <Badge tone={TONE[status]}>{t(`status.${status}`)}</Badge>;
}
