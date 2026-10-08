/** fr: api-keys strings. A key lives in exactly one file; add new ones here. */
import type { api_keys as en } from "@/i18n/locales/en/api-keys";
import type { Locale } from "@/i18n/types";

export const api_keys = {
  createApiKey: "Créer une clé API",
  keyName: "Nom de la clé",
  allowedDomains: "Domaines autorisés (séparés par des virgules, vide = tous)",
  keyCreatedOnce: "Copiez cette clé maintenant — elle ne sera plus jamais affichée.",
} as const satisfies Locale<typeof en>;
