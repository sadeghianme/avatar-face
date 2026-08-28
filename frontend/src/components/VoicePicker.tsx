import { BrowserTTS } from "@liveface/embed";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import { api } from "../lib/api";
import { useOrg } from "../lib/org";
import type { Provider, Voice } from "../lib/types";

export const BROWSER_PROVIDER = "browser";
export const SERVER_PROVIDER = "kokoro";
export const CLONED_PROVIDER = "cloned";

export interface SpeechLanguage {
  locale: string;
  name: string;
  native_name: string;
  sample: string;
  provider: string;
  voice: string;
}

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
  const { t } = useTranslation();
  const { current } = useOrg();
  const orgId = current?.id;

  // Cloned voices are rows in this org's speech cache, not a global list, so
  // they come from the org-scoped endpoint and are merged in here — the
  // generic provider listing is unauthenticated and could not scope them.
  const { data: cloned = [] } = useQuery({
    queryKey: ["cloned-voices", orgId],
    queryFn: () =>
      api.get<{ voice: string; label: string; locale: string }[]>(
        `/orgs/${orgId}/cloned-voices`
      ),
    enabled: Boolean(orgId),
  });

  // Languages the server can actually speak, each already resolved to the
  // best provider and voice. Choosing a language is the primary act; the
  // provider is an implementation detail the picker fills in.
  const { data: languages } = useQuery({
    queryKey: ["tts-languages"],
    queryFn: () => api.get<SpeechLanguage[]>("/tts/languages"),
  });

  const { data: providers } = useQuery({
    queryKey: ["tts-providers"],
    queryFn: async () => {
      const server = await api.get<Provider[]>("/tts/providers");
      // Free local voices via the Web Speech API, when the browser has them.
      return BrowserTTS.supported()
        ? [{ name: BROWSER_PROVIDER, display_name: "Browser voice (free)" }, ...server]
        : server;
    },
  });

  // Offered only when this org actually has one: an empty "Cloned voice"
  // entry would be a dead end for everyone who never recorded anything.
  const allProviders = cloned.length
    ? [...(providers ?? []), { name: CLONED_PROVIDER, display_name: t("clonedVoices") }]
    : providers;
  const { data: voices } = useQuery({
    queryKey: ["tts-voices", value.provider, cloned.length],
    queryFn: async (): Promise<Voice[]> => {
      if (value.provider === CLONED_PROVIDER) {
        return cloned.map((c) => ({
          id: c.voice,
          name: c.label,
          locale: c.locale || "en-US",
          gender: "neutral",
        }));
      }
      if (value.provider === BROWSER_PROVIDER) {
        const list = await BrowserTTS.voices();
        return list.map((v) => ({
          id: v.voiceURI,
          name: v.name,
          locale: v.lang,
          gender: "neutral",
        }));
      }
      return api.get<Voice[]>(`/tts/providers/${value.provider}/voices`);
    },
    enabled: Boolean(value.provider),
  });

  // Keep the PROVIDER valid too. The default names the server voice, which
  // an instance without the model files does not have — without this the
  // select would show a value absent from its own options and the voice
  // query would 422.
  useEffect(() => {
    if (allProviders?.length && !allProviders.some((p) => p.name === value.provider)) {
      onChange({ ...value, provider: allProviders[0].name, voice: "" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allProviders]);

  // Keep the voice valid when the provider (or its voice list) changes.
  useEffect(() => {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voices]);

  const activeLanguage =
    languages?.find((l) => l.locale === value.locale) ??
    languages?.find(
      (l) => l.locale.split("-")[0] === (value.locale || "").split("-")[0]
    );

  return (
    <div className="flex flex-wrap gap-3">
      {languages && languages.length > 1 && (
        <div className="min-w-36 flex-1">
          <label className="label" htmlFor="speech-language">{t("speechLanguage")}</label>
          <select
            id="speech-language"
            className="input"
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
          </select>
        </div>
      )}
      <div className="min-w-36 flex-1">
        <label className="label" htmlFor="provider">{t("provider")}</label>
        <select
          id="provider"
          className="input"
          value={value.provider}
          onChange={(e) => onChange({ ...value, provider: e.target.value })}
        >
          {allProviders?.map((p) => (
            <option key={p.name} value={p.name}>
              {p.display_name}
            </option>
          ))}
        </select>
      </div>
      <div className="min-w-36 flex-1">
        <label className="label" htmlFor="voice">{t("voice")}</label>
        <select
          id="voice"
          className="input"
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
        </select>
      </div>
    </div>
  );
}
