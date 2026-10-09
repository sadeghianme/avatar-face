/** fr: settings strings. A key lives in exactly one file; add new ones here. */
import type { settings as en } from "@/i18n/locales/en/settings";
import type { Locale } from "@/i18n/types";

export const settings = {
  orgSettings: "Organisation",
  orgName: "Nom de l'organisation",
  aiSwitchTitle: "Autoriser l’IA tierce (Google)",
  aiSwitchHint:
    "Permet aux membres d’envoyer des photos et des descriptions à Google (Gemini) pour créer et ajuster l’image d’un avatar dans un style choisi, repérer les points d’un animal, et créer les dents et les formes de bouche propres à une personne réaliste lors de la publication de son avatar. Chaque membre donne son accord avant sa première utilisation, et de nouveau si le texte change. Désactivé, les avatars peuvent toujours être créés à partir d’une photo réaliste, avec des dents et des formes de bouche standard, et rien n’est envoyé.",
  aiSwitchOn: "Activé : les membres peuvent utiliser les étapes d’IA.",
  aiSwitchOff: "Désactivé : aucune image n’est envoyée à Google.",
  aiSwitchAdminsOnly: "Seuls les propriétaires et les administrateurs peuvent le modifier.",
  aiSwitchNotAllowed: "Seuls les propriétaires et les administrateurs peuvent le modifier.",
  usageAiImages: "Images IA : {{used}} / {{limit}}",
  usageAiPoints: "Repérage de points IA : {{used}} / {{limit}}",
  sessionsTitle: "Appareils connectés",
  sessionsHint:
    "Connecté sur un ordinateur que vous n’utilisez plus, ou quelqu’un d’autre connaît votre mot de passe ? Se déconnecter partout met fin à toutes les sessions de votre compte, celle-ci comprise. Choisir un nouveau mot de passe fait de même.",
  logoutEverywhere: "Se déconnecter partout",
  logoutEverywhereAsk: "Se déconnecter sur tous les appareils, celui-ci compris ?",
  logoutEverywhereFailed: "La déconnexion partout a échoué. Réessayez.",
} as const satisfies Locale<typeof en>;
