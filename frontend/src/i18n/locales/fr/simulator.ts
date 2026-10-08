/** fr: simulator strings. A key lives in exactly one file; add new ones here. */
import type { simulator as en } from "@/i18n/locales/en/simulator";
import type { Locale } from "@/i18n/types";

export const simulator = {
  simSubtitle:
    "Collez le code d'intégration d'un avatar et exécutez-le ici, sur sa propre page, exactement comme le navigateur d'un visiteur. Si ça marche ici, ça marche sur votre site.",
  simPasteLabel: "Code d'intégration",
  simNoScript: "Aucune balise script Liveface trouvée dans ce collage.",
  simMissing: "Attribut requis manquant : {{fields}}",
  simInvalid: "Valeur non valide : {{fields}}. Copiez à nouveau le code depuis la page de l'avatar.",
  simRun: "Exécuter",
  simRerun: "Relancer",
  simStarting: "chargement du code sur une page vierge…",
  simChecking: "Vérification…",
  simWorking: "Fonctionne",
  simFailed: "Échec",
  simPreview: "Résultat",
  simIdle: "Collez un code et appuyez sur Exécuter.",
  simModeLabel: "Clé utilisée",
  simModeToken: "Clé de test",
  simModeOwn: "Ma propre clé",
  simModeTokenHint:
    "Utilise une clé temporaire créée pour cette page. Vérifie l'avatar, la voix et le widget — mais pas votre propre clé.",
  simModeOwnHint:
    "Utilise la clé du snippet, et vérifie donc aussi la clé elle-même. La page de test n'a pas de domaine propre : les domaines autorisés de la clé ne sont pas vérifiés ici.",
  simPlaceholderKey: "Remplacez YOUR_API_KEY par une vraie clé, ou utilisez une clé de test.",
  simTokenFailed: "Impossible d'obtenir une clé de test :",
  simRenewed: "Clé de test expirée — renouvelée automatiquement.",
} as const satisfies Locale<typeof en>;
