/** fr: members strings. A key lives in exactly one file; add new ones here. */
import type { members as en } from "@/i18n/locales/en/members";
import type { Locale } from "@/i18n/types";

export const members = {
  inviteMember: "Inviter un membre",
  role: "Rôle",
  pendingInvitations: "Invitations en attente",
} as const satisfies Locale<typeof en>;
