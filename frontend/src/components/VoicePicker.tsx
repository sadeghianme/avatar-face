import { BrowserTTS } from "@liveface/embed";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import { api } from "../lib/api";
import type { Provider, Voice } from "../lib/types";

export const BROWSER_PROVIDER = "browser";

export interface VoiceSelection {
  provider: string;
  voice: string;
  locale: string;
}

/** The voice a fresh panel starts on.
 *
 * Device voices when the browser has them; the offline tone generator is the
 * zero-dependency fallback, not the experience.
 */
export function defaultVoiceSelection(): VoiceSelection {
  return BrowserTTS.supported()
    ? { provider: BROWSER_PROVIDER, voice: "", locale: "en-US" }
    : { provider: "offline", voice: "offline-warm", locale: "en-US" };
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
