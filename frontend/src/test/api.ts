/**
 * The server answers several screens share: the consent terms and the
 * member's remembered agreement, and the speech lists the voice pickers
 * read. Fallbacks, so a test's own routes win.
 */
import { CONSENT_TEXT_VERSIONS } from "@/features/avatars/consent";
import { ORG_ID } from "@/test/fixtures";
import type { MockServer } from "@/test/server";

export function mockConsent(
  server: MockServer,
  { agreed = true, aiEnabled = true }: { agreed?: boolean; aiEnabled?: boolean } = {}
): void {
  const scope = (version: string, providers: string[] = []) => ({ text_version: version, providers });
  server
    .fallback("GET", `/orgs/${ORG_ID}/consents/terms`, () => ({
      third_party_ai: scope(CONSENT_TEXT_VERSIONS.third_party_ai, ["google"]),
      depiction: scope(CONSENT_TEXT_VERSIONS.depiction),
      generated_face: scope(CONSENT_TEXT_VERSIONS.generated_face),
      third_party_ai_enabled: aiEnabled,
    }))
    .fallback("GET", `/orgs/${ORG_ID}/consents/mine`, () => ({
      scope: "third_party_ai",
      text_version: CONSENT_TEXT_VERSIONS.third_party_ai,
      consent_id: agreed ? "consent-ai" : null,
      created_at: agreed ? "2026-10-04T10:00:00Z" : null,
      stale: false,
    }))
    .fallback("POST", `/orgs/${ORG_ID}/consents`, (request) => {
      const body = request.body as { scope: string; text_version: string; providers?: string[]; creation_id?: string };
      return {
        id: `consent-${body.scope}`,
        scope: body.scope,
        providers: body.providers ?? [],
        text_version: body.text_version,
        creation_id: body.creation_id ?? null,
        created_at: "2026-10-06T10:00:00Z",
      };
    });
}

export function mockSpeech(server: MockServer): void {
  server
    .fallback("GET", "/tts/languages", () => [
      {
        locale: "en-US",
        name: "English",
        native_name: "English",
        sample: "Hello there",
        provider: "kokoro",
        voice: "af_heart",
      },
    ])
    .fallback("GET", "/tts/providers", () => [{ name: "kokoro", display_name: "Kokoro" }])
    .fallback("GET", "/tts/providers/:provider/voices", () => [
      { id: "af_heart", name: "Heart", locale: "en-US", gender: "female" },
    ])
    .fallback("GET", `/orgs/${ORG_ID}/cloned-voices`, () => []);
}
