/** fr: share strings. A key lives in exactly one file; add new ones here. */
import type { share as en } from "@/i18n/locales/en/share";
import type { Locale } from "@/i18n/types";

export const share = {
  sharePlaceholder: "Écrivez ce que l'avatar doit dire…",
  sharePlaceholderShort: "Écrivez une phrase…",
  sharePlay: "Lire",
  sharePoweredBy: "Réalisé avec Liveface",
  shareGoneTitle: "Ce lien n'est pas disponible",
  shareGoneBody: "Il a peut-être été désactivé par son propriétaire.",
  shareNoVoice: "Ce navigateur ne propose aucune voix de synthèse.",
  shareAiAvatar: "Avatar IA",
} as const satisfies Locale<typeof en>;
