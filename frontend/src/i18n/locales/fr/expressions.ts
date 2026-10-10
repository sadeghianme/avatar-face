/** fr: the AI expression pictures (the avatar page's Expressions section). A key lives in exactly one file. */
import type { expressions as en } from "@/i18n/locales/en/expressions";
import type { Locale } from "@/i18n/types";

export const expressions = {
  exprTitle: "Expressions",
  exprSummaryOff: "Animées",
  exprSummaryOn: "Images IA",
  exprSummaryChosen: "Images IA à la prochaine publication",
  exprSummaryMaking: "Images IA en cours",
  exprIntro:
    "L'avatar sourit, a l'air surpris, inquiet, pensif ou sérieux en parlant. Par défaut, ces expressions sont animées à partir de cette photo. Les images IA sont des photos de ce même visage faisant chaque expression, créées par le modèle d'images de Google : elles paraissent plus naturelles, et la photo est envoyée à Google pour les créer.",
  exprAiOff: "Votre organisation a désactivé l'IA tierce : les expressions sont animées.",
  exprUse: "Utiliser des images IA pour les expressions",
  exprUseHint:
    "Créées à partir de cette photo à la prochaine publication : cinq images, comptées dans votre quota mensuel d'images. Une expression que l'IA ne réussit pas reste animée.",
  exprDelivery: "À la publication",
  exprDeliveryNow: "Les créer tout de suite",
  exprDeliveryBatch: "Moins cher, prêtes en quelques heures",
  exprPending:
    "Les images sont en cours de création par lot. Elles seront publiées d'elles-mêmes une fois prêtes, d'ici quelques heures.",
  exprMake: "Créer les images d'expressions maintenant",
  exprMakeAgain: "Recréer les images",
  exprMakeHint:
    "Cinq images à partir de cette photo, en une vingtaine de secondes. Les visiteurs les verront après publication.",
  exprPurpose: "Créer des images de ce visage pour ses expressions",
  exprStage_making: "Création des images d'expressions…",
  exprStage_saving: "Enregistrement…",
  exprStage_batch: "Envoi des images à créer…",
  exprCount: "{{done}} sur {{total}}",
  exprMade: "{{made}} sur {{total}} créées par l'IA ; les autres restent animées.",
  exprShotsLabel: "Les images d'expressions",
  exprShotAlt: "{{name}}, tel que l'IA a dessiné ce visage",
  exprShotAnimated: "Animée",
  exprSmile: "Sourit entre les phrases",
  exprName_happy: "Joyeux",
  exprName_surprised: "Surpris",
  exprName_concerned: "Inquiet",
  exprName_thinking: "Pensif",
  exprName_serious: "Sérieux",
  exprReason_declined: "L'IA a refusé de la dessiner",
  exprReason_notReached: "L'IA n'a pas fait cette expression",
  exprReason_changed: "L'IA a trop modifié le visage",
  exprReason_stopped: "Non envoyée : IA désactivée ou quota d'images atteint",
  exprReason_failed: "Le service d'IA n'a pas répondu ; réessayez",
  exprRemove: "Supprimer les images IA",
  exprRemoveQuestion: "Supprimer les images IA ? Les expressions redeviennent animées.",
  exprRemoveConfirm: "Supprimer",
  exprErr_disabled: "Votre organisation a désactivé l'IA tierce : rien n'a été envoyé.",
  exprErr_limit: "Le quota d'images de ce mois est atteint : rien n'a été envoyé.",
  exprErr_unavailable: "Les images IA ne sont pas configurées sur ce serveur.",
  exprErr_person:
    "Les images d'expressions IA sont faites pour les visages humains ; celles de cet avatar sont animées.",
  exprErr_busy: "Les images sont déjà en cours de création pour cet avatar.",
  aiEdited_expressions: "Expressions IA",
} as const satisfies Locale<typeof en>;
