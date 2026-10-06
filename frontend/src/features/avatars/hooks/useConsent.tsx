import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

import { AiConsentDialog } from "@/features/avatars/components/create/AiConsentDialog";
import {
  AI_PROVIDERS,
  consentBody,
  consentProblem,
  type ConsentRecord,
  type ConsentScope,
  type ConsentTerms,
  mineFromRecord,
  type MyConsent,
  needsReagree,
  rememberedConsent,
  termsOutdated,
} from "@/features/avatars/consent";
import { api, ApiError } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";

/** The page is older than the words in force: an ApiError, so the wizard's
 * error handling shows it like any refusal. */
const outdated = () => new ApiError(409, "consent_outdated", "The consent text changed; reload the page to read it");

/**
 * Consents for one organization, as the signed-in member gives them.
 *
 * - `terms`: the wording versions in force and the organization's switch.
 * - `aiConsentId`: the member's remembered third-party AI consent under the
 *   words this page shows (GET /consents/mine), or null: ask first. Undefined
 *   while that is still loading, so nothing asks before it knows.
 * - `aiReagree`: true when the member agreed under an earlier wording and has
 *   not agreed to this one (the checkbox and the dialog then say why).
 * - `record(scope, creationId?)`: records a statement under this page's
 *   words, right before the step it is for (a statement about a face, for
 *   the creation `creationId`). A third-party AI consent is then remembered
 *   in the cache, so the next step does not ask again.
 * - `forgetAi()`: a step refused the remembered id (consent_required: the
 *   wording changed, or it was withdrawn); ask again.
 * - `withAi(purpose, send)`: for a step that asks through a dialog (finding
 *   an animal's points, generating from a photo, making a person's mouth
 *   shapes and teeth in the Mouth panel). Uses the remembered
 *   consent, or shows AiConsentDialog and records one; "Not now" resolves
 *   to null and nothing is sent. A consent_required answer asks once more
 *   and retries once. The AI adjust step asks inline instead (AdjustStep).
 *
 * A version mismatch is never agreed to on the owner's behalf: it throws
 * consent_outdated, which says to reload. third_party_ai_disabled throws
 * too, after refreshing what the org and the terms say, so the AI steps
 * give way to a sentence saying why.
 *
 * `dialog` must be rendered by the caller.
 */
export function useConsent(orgId: string) {
  const queryClient = useQueryClient();
  const [asking, setAsking] = useState<{ purpose: string; resolve: (agreed: boolean) => void } | null>(null);
  const pending = useRef(asking);
  pending.current = asking;

  const terms = useQuery({
    queryKey: queryKeys.consentTerms(orgId),
    queryFn: () => api.get<ConsentTerms>(`/orgs/${orgId}/consents/terms`),
    staleTime: 60_000,
  });
  const mine = useQuery({
    queryKey: queryKeys.myConsent(orgId, "third_party_ai"),
    queryFn: () => api.get<MyConsent>(`/orgs/${orgId}/consents/mine?scope=third_party_ai`),
    staleTime: 60_000,
    // A failed lookup means "ask": asking again is the safe side.
    retry: 1,
  });

  // Unmounted with the question open (the owner navigated away): the
  // request waiting on it is abandoned, not left hanging.
  useEffect(() => () => pending.current?.resolve(false), []);

  const ask = useCallback(
    (purpose: string) =>
      new Promise<boolean>((resolve) => {
        setAsking({ purpose, resolve });
      }),
    []
  );

  const answer = (agreed: boolean) => {
    asking?.resolve(agreed);
    setAsking(null);
  };

  const refreshAiSwitch = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.consentTerms(orgId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.orgs() });
  }, [queryClient, orgId]);

  const remembered = useCallback(
    () =>
      rememberedConsent(
        queryClient.getQueryData<MyConsent>(queryKeys.myConsent(orgId, "third_party_ai")),
        "third_party_ai"
      ),
    [queryClient, orgId]
  );

  const forgetAi = useCallback(() => {
    const key = queryKeys.myConsent(orgId, "third_party_ai");
    const known = queryClient.getQueryData<MyConsent>(key);
    if (known) queryClient.setQueryData<MyConsent>(key, { ...known, consent_id: null, created_at: null });
    void queryClient.invalidateQueries({ queryKey: key });
  }, [queryClient, orgId]);

  /** Record one statement under this page's words. */
  const record = useCallback(
    async (scope: ConsentScope, creationId?: string): Promise<ConsentRecord> => {
      const known = queryClient.getQueryData<ConsentTerms>(queryKeys.consentTerms(orgId)) ?? terms.data;
      if (termsOutdated(known, scope)) throw outdated();
      try {
        const made = await api.post<ConsentRecord>(`/orgs/${orgId}/consents`, consentBody(scope, creationId));
        if (scope === "third_party_ai")
          queryClient.setQueryData(queryKeys.myConsent(orgId, scope), mineFromRecord(made));
        return made;
      } catch (err) {
        if (err instanceof ApiError) {
          const problem = consentProblem(err.code, err.body);
          if (problem?.kind === "disabled") refreshAiSwitch();
          if (problem?.kind === "outdated") {
            void queryClient.invalidateQueries({ queryKey: queryKeys.consentTerms(orgId) });
            throw outdated();
          }
        }
        throw err;
      }
    },
    [orgId, queryClient, terms.data, refreshAiSwitch]
  );

  const withAi = useCallback(
    async <T,>(purpose: string, send: (consentId: string) => Promise<T>): Promise<T | null> => {
      for (let attempt = 0; attempt < 2; attempt++) {
        let consentId = remembered();
        if (!consentId) {
          if (!(await ask(purpose))) return null;
          consentId = (await record("third_party_ai")).id;
        }
        try {
          return await send(consentId);
        } catch (err) {
          const problem = err instanceof ApiError ? consentProblem(err.code, err.body) : null;
          if (problem?.kind === "disabled") refreshAiSwitch();
          if (problem?.kind === "required" && problem.scope === "third_party_ai") {
            forgetAi();
            if (attempt === 0) continue;
          }
          if (problem?.kind === "outdated") throw outdated();
          throw err;
        }
      }
      return null;
    },
    [ask, record, remembered, forgetAi, refreshAiSwitch]
  );

  const providers = terms.data?.third_party_ai.providers ?? AI_PROVIDERS;
  const dialog = (
    <AiConsentDialog
      open={asking !== null}
      purpose={asking?.purpose ?? ""}
      providers={providers}
      reagree={needsReagree(mine.data, "third_party_ai")}
      onAnswer={answer}
    />
  );

  return {
    terms: terms.data,
    /** Unknown (loading) counts as on: every step also checks for itself. */
    aiEnabled: terms.data?.third_party_ai_enabled ?? true,
    providers,
    /** The member agreed to an earlier wording but not the current one:
     * every place that asks says why (AiConsentReagreeNote). */
    aiReagree: needsReagree(mine.data, "third_party_ai"),
    aiConsentId: mine.isPending ? undefined : rememberedConsent(mine.data, "third_party_ai"),
    record,
    forgetAi,
    refreshAiSwitch,
    withAi,
    dialog,
  };
}

export type ConsentApi = ReturnType<typeof useConsent>;
export type WithAi = ConsentApi["withAi"];
