import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import { api } from "../lib/api";
import type { Provider, Voice } from "../lib/types";

export interface VoiceSelection {
  provider: string;
  voice: string;
  locale: string;
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
    queryFn: () => api.get<Provider[]>("/tts/providers"),
  });
  const { data: voices } = useQuery({
    queryKey: ["tts-voices", value.provider],
    queryFn: () => api.get<Voice[]>(`/tts/providers/${value.provider}/voices`),
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
