/**
 * Every server-state key, in one place (docs/frontend-ui.md, "Data").
 *
 * TanStack Query matches keys by prefix: invalidating `creations(org)`
 * refreshes every creation of that organization, `avatars(org)` the list
 * only. Writing a key by hand in a feature drifts from its reader; these
 * factories are the only way keys are made, and the features' hooks
 * (features/<x>/api.ts) the only callers. Framework-free, so `npm test`
 * checks the shapes and the prefixes that invalidation relies on.
 */
type Id = string | undefined;

export const queryKeys = {
  // The organization and what spans the app.
  orgs: () => ["orgs"] as const,
  usage: (orgId: Id) => ["usage", orgId] as const,
  integrations: (orgId: Id) => ["integrations", orgId] as const,
  apiKeys: (orgId: Id) => ["api-keys", orgId] as const,
  members: (orgId: Id) => ["members", orgId] as const,
  invitations: (orgId: Id) => ["invitations", orgId] as const,
  invite: (token: Id) => ["invite", token] as const,

  // Avatars.
  avatars: (orgId: Id) => ["avatars", orgId] as const,
  avatar: (orgId: Id, avatarId: Id) => ["avatar", orgId, avatarId] as const,
  rigAnchors: (avatarId: Id, rigUrl: string | null | undefined) => ["rig-anchors", avatarId, rigUrl] as const,
  mouthKit: (orgId: Id, avatarId: Id) => ["mouth-kit", orgId, avatarId] as const,
  expressions: (orgId: Id, avatarId: Id) => ["expressions", orgId, avatarId] as const,
  stockAvatars: () => ["stock-avatars"] as const,

  // The creation wizard: one creation, and every creation of an org (prefix).
  creations: (orgId: Id) => ["creation", orgId] as const,
  creation: (orgId: Id, creationId: Id) => ["creation", orgId, creationId] as const,
  drafts: (orgId: Id) => ["creations", orgId, "draft"] as const,

  // Consent.
  consentTerms: (orgId: Id) => ["consent-terms", orgId] as const,
  myConsent: (orgId: Id, scope: string) => ["consent-mine", orgId, scope] as const,

  // Voices and speech.
  ttsLanguages: () => ["tts-languages"] as const,
  ttsProviders: () => ["tts-providers"] as const,
  ttsVoices: (provider: string, clonedCount: number) => ["tts-voices", provider, clonedCount] as const,
  imageGen: () => ["imagegen"] as const,
  clonedVoices: (orgId: Id) => ["cloned-voices", orgId] as const,
  cloneJobs: (orgId: Id) => ["clone-jobs", orgId] as const,
  renderCapability: (orgId: Id) => ["render-capability", orgId] as const,
};

/** True when `key` is matched by invalidating `prefix` (TanStack's partial match). */
export function keyMatches(prefix: readonly unknown[], key: readonly unknown[]): boolean {
  return prefix.length <= key.length && prefix.every((part, i) => part === key[i]);
}
