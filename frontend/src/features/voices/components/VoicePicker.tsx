import { useEffect, useMemo, useRef } from "react";

import { Field } from "@/components/ui/Field";
import { Select } from "@/components/ui/Select";
import {
  CLONED_PROVIDER,
  type ClonedVoice,
  SERVER_PROVIDER,
  useClonedVoices,
  useProviderVoices,
  useSpeechLanguages,
  useSpeechProviders,
} from "@/features/voices/api";
import { useT } from "@/i18n";
import { useOrg } from "@/providers/org";

/** One empty list for "no clones", so the voices query is not re-keyed by a new []. */
const NO_CLONES: readonly ClonedVoice[] = [];

export interface VoiceSelection {
  provider: string;
  voice: string;
  locale: string;
}

/** The voice a fresh panel starts on.
 *
 * The server voice, because it is the only one that sounds the same for
 * everyone: device voices differ per visitor's OS, so what an owner hears
 * while building an avatar would not be what their visitors hear. If this
 * instance never downloaded the Kokoro weights the picker falls back to
 * whatever IS available (see the provider-validation effect below), so
 * naming it here is a preference, not a requirement.
 */
export function defaultVoiceSelection(): VoiceSelection {
  return { provider: SERVER_PROVIDER, voice: "af_heart", locale: "en-US" };
}

export function VoicePicker({
  value,
  onChange,
}: {
  value: VoiceSelection;
  onChange: (selection: VoiceSelection) => void;
}) {
  const { t } = useT();
  const { current } = useOrg();
  const orgId = current?.id;

  // Cloned voices are rows in this org's speech cache, not a global list, so
  // they come from the org-scoped endpoint and are merged in here — the
  // generic provider listing is unauthenticated and could not scope them.
  const clones = useClonedVoices(orgId);
  const cloned = clones.data ?? NO_CLONES;
  // Until the org's clones have answered (the org itself may still be
  // loading), the provider list is not known: judged without them, a cloned
  // voice (the avatar's own, saved) would be "invalid" and replaced — and
  // on the avatar page, saved so.
  const clonesKnown = clones.isSuccess || clones.isError;

  // Languages the server can actually speak, each already resolved to the
  // best provider and voice. Choosing a language is the primary act; the
  // provider is an implementation detail the picker fills in.
  const { data: languages } = useSpeechLanguages();

  // Free local voices via the Web Speech API first, when the browser has them.
  const { data: providers } = useSpeechProviders();

  // Offered only when this org actually has one: an empty "Cloned voice"
  // entry would be a dead end for everyone who never recorded anything.
  const hasCloned = cloned.length > 0;
  const allProviders = useMemo(
    () => (hasCloned ? [...(providers ?? []), { name: CLONED_PROVIDER, display_name: t("clonedVoices") }] : providers),
    [hasCloned, providers, t]
  );
  const { data: voices } = useProviderVoices(value.provider, cloned);

  // Keep the PROVIDER valid too. The default names the server voice, which
  // an instance without the model files does not have — without this the
  // select would show a value absent from its own options and the voice
  // query would 422.
  // Both checks run when a LIST changes, against the selection as it is
  // then: a selection change alone must not re-run them (picking a voice
  // the list does not have yet would be undone before the list arrives).
  const selection = useRef({ value, onChange });
  selection.current = { value, onChange };

  useEffect(() => {
    const { value, onChange } = selection.current;
    if (clonesKnown && allProviders?.length && !allProviders.some((p) => p.name === value.provider)) {
      onChange({ ...value, provider: allProviders[0].name, voice: "" });
    }
  }, [allProviders, clonesKnown]);

  // Keep the voice valid when the provider (or its voice list) changes.
  useEffect(() => {
    const { value, onChange } = selection.current;
    if (voices?.length && !voices.some((v) => v.id === value.voice)) {
      onChange({
        ...value,
        voice: voices[0].id,
        // Never undefined: a voice list without locales (an older server, a
        // browser voice with a blank lang) would otherwise put undefined
        // into the selection and crash the language match below.
        locale: voices[0].locale || value.locale || "en-US",
      });
    }
  }, [voices]);

  const activeLanguage =
    languages?.find((l) => l.locale === value.locale) ??
    languages?.find((l) => l.locale.split("-")[0] === (value.locale || "").split("-")[0]);

  return (
    // 12rem a field: side by side in a wide column, one under the other in
    // a narrow one (a phone, the avatar page's two fifths on a tablet)
    // rather than both cut to "Browser voice (fr…".
    <div className="flex flex-wrap gap-3">
      {languages && languages.length > 1 && (
        <Field id="speech-language" label={t("speechLanguage")} className="min-w-48 flex-1">
          <Select
            value={activeLanguage?.locale ?? ""}
            onChange={(e) => {
              const next = languages.find((l) => l.locale === e.target.value);
              if (!next) return;
              // Picking a language picks the voice too — that is the point.
              onChange({ provider: next.provider, voice: next.voice, locale: next.locale });
            }}
          >
            {languages.map((l) => (
              <option key={l.locale} value={l.locale}>
                {l.native_name}
                {l.native_name === l.name ? "" : ` · ${l.name}`}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <Field id="provider" label={t("provider")} className="min-w-48 flex-1">
        <Select value={value.provider} onChange={(e) => onChange({ ...value, provider: e.target.value })}>
          {allProviders?.map((p) => (
            <option key={p.name} value={p.name}>
              {p.display_name}
            </option>
          ))}
        </Select>
      </Field>
      <Field id="voice" label={t("voice")} className="min-w-48 flex-1">
        <Select
          value={value.voice}
          onChange={(e) => {
            const voice = voices?.find((v) => v.id === e.target.value);
            onChange({
              ...value,
              voice: e.target.value,
              locale: voice?.locale ?? value.locale,
            });
          }}
        >
          {voices?.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name} ({v.locale})
            </option>
          ))}
        </Select>
      </Field>
    </div>
  );
}
