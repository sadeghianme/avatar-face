/**
 * Consent rules, without a browser: `npm test` (node --test). Node strips
 * the types, so this imports the module by its file name.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CONSENT_TEXT_VERSIONS,
  consentBody,
  consentProblem,
  mineFromRecord,
  providerLabel,
  rememberedConsent,
  termsOutdated,
} from "./consent.ts";

const version = CONSENT_TEXT_VERSIONS.third_party_ai;
const terms = (aiVersion = version, depictionVersion = CONSENT_TEXT_VERSIONS.depiction) => ({
  third_party_ai: { text_version: aiVersion, providers: ["google"] },
  depiction: { text_version: depictionVersion, providers: [] },
  generated_face: { text_version: CONSENT_TEXT_VERSIONS.generated_face, providers: [] },
  third_party_ai_enabled: true,
});

describe("recording a consent", () => {
  it("sends the version of the words this page shows, and names Google for AI", () => {
    assert.deepEqual(consentBody("third_party_ai"), {
      scope: "third_party_ai",
      text_version: version,
      providers: ["google"],
    });
    assert.deepEqual(consentBody("depiction"), { scope: "depiction", text_version: CONSENT_TEXT_VERSIONS.depiction });
  });
  it("names the creation a statement about a face is about, and only then", () => {
    assert.deepEqual(consentBody("depiction", "cr1"), {
      scope: "depiction",
      text_version: CONSENT_TEXT_VERSIONS.depiction,
      creation_id: "cr1",
    });
    assert.deepEqual(consentBody("generated_face", "cr2"), {
      scope: "generated_face",
      text_version: CONSENT_TEXT_VERSIONS.generated_face,
      creation_id: "cr2",
    });
    // Sending photos to Google is not about one photo.
    assert.equal("creation_id" in consentBody("third_party_ai", "cr1"), false);
  });
  it("matches the server's wording versions (services.consent.TEXT_VERSIONS)", () => {
    assert.deepEqual(
      { ...CONSENT_TEXT_VERSIONS },
      { third_party_ai: "2026-09-26", depiction: "2026-09-25", generated_face: "2026-09-25" }
    );
  });
  it("notices when the words in force are not the ones on screen", () => {
    assert.equal(termsOutdated(terms(), "third_party_ai"), false);
    assert.equal(termsOutdated(terms("2027-01-01"), "third_party_ai"), true);
    assert.equal(termsOutdated(terms(version, "2027-01-01"), "third_party_ai"), false);
    // Not loaded yet is not a mismatch: the server checks on POST.
    assert.equal(termsOutdated(undefined, "depiction"), false);
  });
});

describe("a remembered consent", () => {
  const mine = (extra = {}) => ({
    scope: "third_party_ai",
    text_version: version,
    consent_id: "c1",
    created_at: "2026-09-25T10:00:00Z",
    ...extra,
  });
  it("is used without asking when it is under the words on screen", () => {
    assert.equal(rememberedConsent(mine(), "third_party_ai"), "c1");
  });
  it("is not used when there is none, it is another scope's, or the words changed", () => {
    assert.equal(rememberedConsent(mine({ consent_id: null }), "third_party_ai"), null);
    assert.equal(rememberedConsent(mine({ scope: "depiction" }), "third_party_ai"), null);
    assert.equal(rememberedConsent(mine({ text_version: "2027-01-01" }), "third_party_ai"), null);
    assert.equal(rememberedConsent(undefined, "third_party_ai"), null);
  });
  it("is what a fresh record answers, so the next step does not ask again", () => {
    const record = { id: "c2", scope: "third_party_ai", providers: ["google"], text_version: version, created_at: "t" };
    assert.equal(rememberedConsent(mineFromRecord(record), "third_party_ai"), "c2");
  });
});

describe("a refusal about consent", () => {
  it("asks for the scope the server names", () => {
    assert.deepEqual(consentProblem("consent_required", { scope: "depiction", text_version: CONSENT_TEXT_VERSIONS.depiction }), {
      kind: "required",
      scope: "depiction",
    });
    assert.deepEqual(consentProblem("consent_required", {}), { kind: "required", scope: "third_party_ai" });
    assert.deepEqual(
      consentProblem("consent_required", { scope: "generated_face", text_version: CONSENT_TEXT_VERSIONS.generated_face }),
      { kind: "required", scope: "generated_face" }
    );
  });
  it("never agrees again to other words: an unknown version means reload", () => {
    assert.deepEqual(consentProblem("consent_required", { scope: "third_party_ai", text_version: "2027-01-01" }), {
      kind: "outdated",
    });
    assert.deepEqual(consentProblem("unknown_consent_version", { current_version: "2027-01-01" }), { kind: "outdated" });
  });
  it("hides the AI when the organization switched it off, and ignores the rest", () => {
    assert.deepEqual(consentProblem("third_party_ai_disabled"), { kind: "disabled" });
    assert.equal(consentProblem("budget_spent"), null);
  });
  it("names Google as the owner knows it", () => {
    assert.equal(providerLabel("google"), "Google (Gemini)");
    assert.equal(providerLabel("other"), "other");
  });
});
