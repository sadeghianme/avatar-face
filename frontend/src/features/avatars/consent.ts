/**
 * Consents, as the dashboard asks for them.
 *
 * Three statements (services.consent on the server): `third_party_ai`,
 * before a photo is sent to Google to be edited, to have its points found,
 * or to have a person's teeth and mouth shapes made from it (step 5, the
 * Mouth panel); `depiction`, the uploader's statement before a person's face is
 * built; and `generated_face`, in its place for a face the image model made
 * from words. The last two are about one face: each is recorded for one
 * creation, which the server says needs it (`Creation.statement`).
 * The wording lives here, translated; the server keeps only its VERSION and
 * refuses any version it does not know. So the version sent is the one of
 * the words THIS bundle shows, never the one the server happens to answer
 * with: a tab left open across a wording change must not record agreement
 * to a text it never displayed. It is told to reload instead.
 *
 * The third-party AI statement is asked once per person and wording: the
 * server remembers it (GET /consents/mine), and every step still checks
 * the id it is given, and the organization's switch.
 *
 * Framework-free with type-only imports, like creation.ts, so the rules are
 * tested with `node --test`.
 */

export type ConsentScope = "third_party_ai" | "depiction" | "generated_face";
/** The statements about a face, recorded for one creation. */
export type FaceStatement = "depiction" | "generated_face";

/**
 * The version of the wording this bundle shows, per scope. Bump one (with
 * services.consent.TEXT_VERSIONS) whenever its words change in meaning, in
 * every language together.
 */
export const CONSENT_TEXT_VERSIONS: Readonly<Record<ConsentScope, string>> = {
  third_party_ai: "2026-10-03",
  depiction: "2026-09-25",
  generated_face: "2026-09-25",
};

/** The providers a third-party AI consent names: every model the server
 * calls today is Google's. */
export const AI_PROVIDERS: readonly string[] = ["google"];

/** GET /orgs/{id}/consents/terms. */
export interface ConsentTerms {
  third_party_ai: { text_version: string; providers: string[] };
  depiction: { text_version: string; providers: string[] };
  generated_face: { text_version: string; providers: string[] };
  third_party_ai_enabled: boolean;
}

/** POST /orgs/{id}/consents answers with this. */
export interface ConsentRecord {
  id: string;
  scope: ConsentScope;
  providers: string[];
  text_version: string;
  /** The creation a statement about a face is about; null otherwise. */
  creation_id?: string | null;
  created_at: string;
}

export interface ConsentBody {
  scope: ConsentScope;
  text_version: string;
  providers?: string[];
  creation_id?: string;
}

/** What POST /consents is sent for `scope`: always this bundle's version,
 * and for a statement about a face, the creation it is about (the server
 * accepts it for that creation only). */
export function consentBody(scope: ConsentScope, creationId?: string): ConsentBody {
  if (scope === "third_party_ai") {
    return { scope, text_version: CONSENT_TEXT_VERSIONS[scope], providers: [...AI_PROVIDERS] };
  }
  return { scope, text_version: CONSENT_TEXT_VERSIONS[scope], ...(creationId ? { creation_id: creationId } : {}) };
}

/** The server's wording for `scope` is not the one on screen: the page is
 * older than the text in force (or newer, mid-deploy). Unknown terms (not
 * loaded yet) are not a mismatch; the server checks again on POST. */
export function termsOutdated(terms: ConsentTerms | null | undefined, scope: ConsentScope): boolean {
  return Boolean(terms && terms[scope].text_version !== CONSENT_TEXT_VERSIONS[scope]);
}

/**
 * What a refused request says about consent:
 * - `required`: ask for `scope` (again) and retry;
 * - `outdated`: the words on screen are not the ones in force; reload;
 * - `disabled`: the organization switched third-party AI off; hide the AI.
 * Null for any other refusal.
 */
export type ConsentProblem =
  { kind: "required"; scope: ConsentScope } | { kind: "outdated" } | { kind: "disabled" } | null;

export function consentProblem(code: string, body: Record<string, unknown> = {}): ConsentProblem {
  if (code === "third_party_ai_disabled") return { kind: "disabled" };
  if (code === "unknown_consent_version" || code === "consent_outdated") return { kind: "outdated" };
  if (code !== "consent_required") return null;
  const scope: ConsentScope =
    body.scope === "depiction" || body.scope === "generated_face" ? body.scope : "third_party_ai";
  // Asked for a version other than ours: agreeing again to OUR words would
  // be refused, and should be.
  if (typeof body.text_version === "string" && body.text_version !== CONSENT_TEXT_VERSIONS[scope]) {
    return { kind: "outdated" };
  }
  return { kind: "required", scope };
}

/** "google" → "Google (Gemini)": how a provider is named to the owner. */
export function providerLabel(provider: string): string {
  return provider === "google" ? "Google (Gemini)" : provider;
}

// --- Remembered agreement ------------------------------------------------------------

/** GET /orgs/{id}/consents/mine?scope=: the caller's latest consent under
 * the wording in force, or null (never asked, or the wording changed). */
export interface MyConsent {
  scope: ConsentScope;
  text_version: string;
  consent_id: string | null;
  created_at: string | null;
  /** True when consent_id is null because the wording changed: the member
   * agreed to an earlier version. Absent on servers that predate it. */
  stale?: boolean;
}

/**
 * The consent id to pass to a step without asking again, or null (ask).
 *
 * The owner is asked once per person and wording, not per photo: the
 * server remembers. But only a consent to the words THIS page shows counts:
 * if the server's version is not ours, the id names a text this page never
 * displayed, and the step would be taken on a statement nobody saw here.
 */
export function rememberedConsent(mine: MyConsent | null | undefined, scope: ConsentScope): string | null {
  if (!mine || mine.scope !== scope || !mine.consent_id) return null;
  return mine.text_version === CONSENT_TEXT_VERSIONS[scope] ? mine.consent_id : null;
}

/**
 * Whether to tell the member that the statement changed since they agreed:
 * they have an earlier agreement but none for the words in force, and the
 * words the server holds are the ones on this page (so agreeing is possible).
 * False for a member who never agreed (nothing to renew) and for one who
 * has agreed to the current words.
 */
export function needsReagree(mine: MyConsent | null | undefined, scope: ConsentScope): boolean {
  if (!mine || mine.scope !== scope || mine.consent_id) return false;
  return mine.stale === true && mine.text_version === CONSENT_TEXT_VERSIONS[scope];
}

/** What GET /consents/mine will answer once `record` is stored: written
 * into the cache so the next step does not ask again before a refetch. */
export function mineFromRecord(record: ConsentRecord): MyConsent {
  return {
    scope: record.scope,
    text_version: record.text_version,
    consent_id: record.id,
    created_at: record.created_at,
    stale: false,
  };
}
