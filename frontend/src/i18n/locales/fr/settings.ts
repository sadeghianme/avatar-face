/** fr: settings strings. A key lives in exactly one file; add new ones here. */
export const settings = {
  orgSettings: "Organisation",
  orgName: "Nom de l'organisation",
  aiSwitchTitle: "Autoriser l’IA tierce (Google)",
  aiSwitchHint: "Permet aux membres d’envoyer des images à Google (Gemini) pour les retoucher, les redessiner ou les générer, repérer les points d’un animal ou créer les dents et les formes de bouche d’une personne. Chaque membre donne son accord avant la première utilisation ; ensuite, l’assistant retouche aussi les lèvres entrouvertes sur les dents, et crée les dents et les formes de bouche d’une personne quand son avatar est terminé, sans redemander. Désactivé : les avatars se créent toujours à la main, avec des dents et des formes de bouche standard, et rien n’est envoyé.",
  aiSwitchOn: "Activé : les membres peuvent utiliser les étapes d’IA.",
  aiSwitchOff: "Désactivé : aucune image n’est envoyée à Google.",
  aiSwitchAdminsOnly: "Seuls les propriétaires et les administrateurs peuvent le modifier.",
  aiSwitchNotAllowed: "Seuls les propriétaires et les administrateurs peuvent le modifier.",
  usageAiImages: "Images IA : {{used}} / {{limit}}",
  usageAiPoints: "Repérage de points IA : {{used}} / {{limit}}",
} as const;
