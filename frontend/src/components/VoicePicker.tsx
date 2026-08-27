import { BrowserTTS } from "@liveface/embed";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import { api } from "../lib/api";
import type { Provider, Voice } from "../lib/types";

export const BROWSER_PROVIDER = "browser";
export const SERVER_PROVIDER = "kokoro";

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
  const { data: voices } = useQuery({
    queryKey: ["tts-voices", value.provider],
    queryFn: async (): Promise<Voice[]> => {
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
    if (providers?.length && !providers.some((p) => p.name === value.provider)) {
      onChange({ ...value, provider: providers[0].name, voice: "" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers]);

  // Keep the voice valid when the provider (or its voice list) changes.
  useEffect(() => {
    if (voices?.length && !voices.some((v) => v.id === value.voice)) {
      onChange({ ...value, voice: voices[0].id, locale: voices[0].locale });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voices]);

  return (
    <div className="flex flex-wrap gap-3">
      <div className="min-w-36 flex-1">
        <label className="label" htmlFor="provider">{t("provider")}</label>
        <select
          id="provider"
          className="input"
          value={value.provider}
          onChange={(e) => onChange({ ...value, provider: e.target.value })}
        >
          {providers?.map((p) => (
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
