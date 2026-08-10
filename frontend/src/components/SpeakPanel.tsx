import {
  BrowserTTS,
  listen,
  SpeechQueue,
  sttSupported,
  type CuePlayer,
  type SpeechPlayer,
  type SynthesisPayload,
} from "@liveface/embed";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "./Icon";
import { api, ApiError } from "../lib/api";
import { BROWSER_PROVIDER, VoicePicker, type VoiceSelection } from "./VoicePicker";

export function SpeakPanel({
  engine,
  orgId,
}: {
  engine: SpeechPlayer | null;
  orgId: string;
}) {
  const { t, i18n } = useTranslation();
  // Prefilled rather than empty: an empty box disables Speak, so the first
  // thing the page offers is a dead button and a blank field.
  const [text, setText] = useState(() => t("speakSample"));
  // Default to the device's real voices when available; the offline tone
  // generator is the zero-dependency fallback, not the experience.
  const [selection, setSelection] = useState<VoiceSelection>(() =>
    BrowserTTS.supported()
      ? { provider: BROWSER_PROVIDER, voice: "", locale: "en-US" }
      : { provider: "offline", voice: "offline-warm", locale: "en-US" }
  );
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;

  const queue = useMemo(() => {
    if (!engine) return null;
    return new SpeechQueue(engine, async (chunk): Promise<SynthesisPayload> => {
      const s = selectionRef.current;
      return api.post<SynthesisPayload>(`/tts/orgs/${orgId}/synthesize`, {
        text: chunk,
        provider: s.provider,
        voice: s.voice,
        locale: s.locale,
      });
    });
  }, [engine, orgId]);

  // Free local voices: speechSynthesis plays, the engine just gets cues.
  const browserTts = useMemo(
    () => (engine ? new BrowserTTS(engine as unknown as CuePlayer) : null),
    [engine]
  );

  useEffect(
    () => () => {
      queue?.stop();
      browserTts?.stop();
    },
    [queue, browserTts]
  );

  const speak = async () => {
    if (!text.trim()) return;
    setError(null);
    setBusy(true);
    try {
      const s = selectionRef.current;
      if (s.provider === BROWSER_PROVIDER) {
        await browserTts?.speak(text, s.voice, s.locale);
      } else {
        await queue?.speak(text);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : t("error"));
    } finally {
      setBusy(false);
    }
  };

  const dictate = async () => {
    setError(null);
    setListening(true);
    try {
      const transcript = await listen({ lang: i18n.language, interim: setText });
      if (transcript) setText(transcript);
    } catch {
      setError("Speech recognition failed");
    } finally {
      setListening(false);
    }
  };

  return (
    <div className="card flex flex-col gap-4">
      <VoicePicker value={selection} onChange={setSelection} />
      <textarea
        className="input min-h-24"
        placeholder={t("speakPlaceholder")}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      {error && <p className="field-error">{error}</p>}
      <div className="flex gap-2">
        <button
          className="btn-primary flex-1"
          disabled={!engine || !text.trim() || busy}
          onClick={() => void speak()}
        >
          <Icon name="speaker" className="me-1.5 inline h-4 w-4" />
          {t("speak")}
        </button>
        <button
          className="btn-secondary"
          disabled={!queue}
          onClick={() => {
            queue?.stop();
            browserTts?.stop();
            setBusy(false);
          }}
        >
          <Icon name="stop" className="me-1.5 inline h-4 w-4" />
          {t("stop")}
        </button>
        {sttSupported() && (
          <button
            className="btn-secondary"
            disabled={listening}
            onClick={() => void dictate()}
            title={t("dictate")}
          >
            <Icon name={listening ? "ear" : "mic"} className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );
}
